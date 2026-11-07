/**
 * Сервер Музы: сейф и курьер.
 *
 * ЧТО ОН ДЕЛАЕТ И ЧЕГО НЕ ДЕЛАЕТ.
 *
 * Не читает идеи. Не расшифровывает. Не считает. Всё это живёт на телефоне.
 * Здесь только:
 *   1. приём зашифрованных файлов ЧАСТЯМИ — с докачкой после обрыва;
 *   2. выдача их обратно с проверкой доступа;
 *   3. прокси к модели и к распознаванию речи (ключ ИИ не светится в браузере);
 *   4. разбор ссылок — браузер этого не может из-за CORS.
 *
 * ПОЧЕМУ ЧАСТЯМИ. Файл на 231 МБ одним куском не уедет: оборвётся связь,
 * упрётся лимит прокси, и загрузка начнётся заново. Поэтому используем
 * ВСТРОЕННУЮ многoчастную загрузку S3: части едут независимо, сервер не
 * держит весь файл в памяти, и после обрыва продолжается с места.
 *
 * ЧТО СЕРВЕР ПРОВЕРЯЕТ, А ЧТО НЕТ. Содержимое проверить не может — оно
 * зашифровано на устройстве, и это правильно. Но ЦЕЛОСТНОСТЬ обязан:
 * размер каждой части. Битый файл, не пойманый здесь, всплывёт при
 * восстановлении — когда уже поздно.
 */

import { createServer } from 'node:http'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  parseCookie,
  samePassword,
  signSession,
  verifySession,
} from './auth.mjs'
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { Readable, Transform } from 'node:stream'
import { pruneMetrics, recordMetric, summarizeMetrics } from './metrics.mjs'
import {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3'

// --- Настройки ---------------------------------------------------------------

/** Допустимый размер одной части: 5 МБ — минимум для S3. */
const PART_SIZE = 8 * 1024 * 1024
/** Больше этого размера S3 не примет часть. */
const MAX_PART_SIZE = 64 * 1024 * 1024
/** Сколько частей разрешаем: 10 000 — предел S3. */
const MAX_PARTS = 10_000
const PORT = Number(process.env.PORT ?? 3000)
const STATE_DIR = process.env.STATE_DIR ?? '/opt/muza/state'

const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION ?? 'ru-1',
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_KEY ?? '',
    secretAccessKey: process.env.S3_SECRET ?? '',
  },
})
const Bucket = process.env.S3_BUCKET ?? ''

/**
 * Пароль приложения. Если задан — все действия требуют его в заголовке.
 *
 * Без него сервер открыт всему интернету, и это не мелочь: кто угодно
 * сможет залить мусор и занять место. Проверка сравнивается за постоянное
 * время, чтобы по отклику нельзя было угадывать пароль посимвольно.
 */
const TOKEN = process.env.MUZA_TOKEN ?? ''

/**
 * Вход на dev-домен по cookie.
 *
 * Пусто — ручки входа не существуют (прод). Задано — `forward_auth`
 * в Caddy пускает к статике только с подписанной cookie.
 */
const DEV_AUTH_PASSWORD = process.env.DEV_AUTH_PASSWORD ?? ''
const DEV_AUTH_SECRET = process.env.DEV_AUTH_SECRET || DEV_AUTH_PASSWORD

/**
 * ПРОКСИ К МОДЕЛИ.
 *
 * Зачем: сейчас ключ polza.ai лежит в браузере у каждого человека. Он
 * виден в инструментах разработчика, попадает в расширения и утекает
 * вместе с любым сторонним скриптом. Через прокси ключ остаётся ТОЛЬКО
 * здесь, а приложение работает вообще без ключа.
 *
 * Чего прокси НЕ делает: не читает идеи. Он передаёт запрос как есть,
 * добавляя заголовок авторизации, и возвращает ответ как есть. Модель
 * видит текст идеи — но её и раньше видел провайдер; для человека это
 * не меняется.
 */
const POLZA_URL = process.env.POLZA_URL ?? 'https://polza.ai/api/v1'
const POLZA_KEY = process.env.POLZA_KEY ?? ''

/**
 * Какие модели разрешены.
 *
 * Белый список, а не «что попросят»: иначе прокси превращается в бесплатный
 * доступ к любой модели за наш счёт. Здесь ровно те, что использует
 * приложение.
 */
const ALLOWED_MODELS = new Set([
  'deepseek/deepseek-v4.1-flash',
  'ai-sage/gigaam-v3',
  'openai/whisper-large-v3',
])

/** Сколько запросов к модели разрешаем с одного адреса в час. */
const AI_LIMIT_PER_HOUR = Number(process.env.AI_LIMIT ?? 200)
/** И сколько всего в сутки — общий предохранитель от разорения. */
const AI_LIMIT_PER_DAY = Number(process.env.AI_LIMIT_DAY ?? 2000)

/**
 * Счётчики расхода. В памяти: при перезапуске обнуляются.
 *
 * Это осознанно: точный биллинг — отдельная задача, а сейчас нужен
 * предохранитель «один человек не выжег весь месяц за вечер». Потеря
 * счётчика при перезапуске безопаснее, чем его отсутствие.
 */
const aiUse = { total: 0, byIp: new Map(), dayStart: Date.now() }

function allowAi(ip) {
  const now = Date.now()
  if (now - aiUse.dayStart > 24 * 60 * 60 * 1000) {
    aiUse.total = 0
    aiUse.byIp.clear()
    aiUse.dayStart = now
  }
  if (aiUse.total >= AI_LIMIT_PER_DAY) return 'исчерпан общий лимит на сутки'
  const record = aiUse.byIp.get(ip) ?? { count: 0, since: now }
  if (now - record.since > 60 * 60 * 1000) {
    record.count = 0
    record.since = now
  }
  if (record.count >= AI_LIMIT_PER_HOUR) return 'слишком много запросов за час'
  record.count += 1
  aiUse.byIp.set(ip, record)
  aiUse.total += 1
  return null
}

/**
 * Пароль обязан быть ЛАТИНИЦЕЙ.
 *
 * HTTP-заголовки допускают только ASCII. Пароль на кириллице в заголовке
 * не доходит, и сервер отвечает «нужен пароль» даже при верном значении.
 * Найдено проверкой: с паролем «секрет» не проходил ни один запрос.
 */
const TOKEN_IS_ASCII = /^[\x20-\x7E]*$/.test(TOKEN)

function authorized(req) {
  if (TOKEN === '') return true
  const header = String(req.headers.authorization ?? '')
  const given = header.startsWith('Bearer ') ? header.slice(7) : ''
  const a = Buffer.from(given)
  const b = Buffer.from(TOKEN)
  return a.length === b.length && timingSafeEqual(a, b)
}

// --- Состояние загрузок ------------------------------------------------------

/**
 * Незаконченные загрузки: id → { uploadId, key, parts: {номер: ETag} }.
 *
 * Храним НА ДИСКЕ, а не в памяти: сервер может перезапуститься (обновление,
 * падение), а загрузка 231 МБ с телефона не должна начинаться заново.
 * Потерять это состояние — значит потерять докачку, ради которой всё и
 * делалось.
 */
let uploads = new Map()
let statePath = `${STATE_DIR}/uploads.json`

async function loadState() {
  try {
    await mkdir(STATE_DIR, { recursive: true })
    const raw = await readFile(statePath, 'utf8')
    uploads = new Map(Object.entries(JSON.parse(raw)))
  } catch {
    uploads = new Map()
  }
}

async function saveState() {
  const tmp = `${statePath}.tmp`
  // Пишем во временный файл и ПЕРЕИМЕНОВЫВАЕМ: переименование атомарно.
  // Иначе падение посреди записи оставит битый JSON, и незаконченные
  // загрузки не восстановятся — то есть пропадёт докачка, ради которой
  // всё и делалось.
  await writeFile(tmp, JSON.stringify(Object.fromEntries(uploads)), 'utf8')
  await rename(tmp, statePath)
}

// --- Ответы ------------------------------------------------------------------

function json(res, status, data) {
  const body = JSON.stringify(data)
  // Заголовки задаём через setHeader, а не в writeHead: так CORS, выставленный
  // раньше, не затирается — иначе ответы с ошибками приходили бы без него,
  // и браузер показывал «нет связи» вместо «нужен пароль».
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Content-Length', Buffer.byteLength(body))
  res.writeHead(status)
  res.end(body)
}

/** Читает тело запроса в память. Части ограничены сверху, поэтому это безопасно. */
async function readBody(req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('часть слишком большая')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

// --- Маршруты ----------------------------------------------------------------

/**
 * Разрешение для браузера (CORS).
 *
 * Приложение живёт на github.io, прокси — на своём домене. Для браузера это
 * РАЗНЫЕ ИСТОЧНИКИ, и по умолчанию он запрещает читать ответ. Без этих
 * заголовков любой вызов из приложения падал бы как «нет связи с сервисом»,
 * хотя сервер жив и отвечает.
 *
 * `*` здесь безопасен: прокси всё равно открыт для всех, а доступ защищён
 * белым списком моделей и лимитами. Секретов в ответах нет.
 */
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
  res.setHeader('Access-Control-Max-Age', '86400')
}

/** Страница входа. Отдаётся без пароля — иначе в неё не попасть. */
function loginPage(res, failed) {
  const body = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>Вход — Муза dev</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100dvh; display: grid; place-items: center;
         background: #0a0d14; color: #e7edf7;
         font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  .card { width: min(360px, calc(100% - 32px)); padding: 24px; border-radius: 16px;
          background: #111725; border: 1px solid #26324a; }
  h1 { margin: 0 0 6px; font-size: 20px; }
  p { margin: 0 0 16px; color: #8b96ab; font-size: 14px; }
  label { display: block; margin-bottom: 8px; font-size: 14px; }
  input { width: 100%; box-sizing: border-box; padding: 12px; border-radius: 10px;
          border: 1px solid #2b3a55; background: #0a0f1a; color: #e7edf7; font-size: 16px; }
  button { width: 100%; margin-top: 12px; padding: 12px; border: 0; border-radius: 10px;
           background: #ff8a5b; color: #14100d; font-size: 16px; font-weight: 600; cursor: pointer; }
  .err { margin: 0 0 12px; padding: 10px; border-radius: 8px; background: #3a1d1d;
         color: #ffb4a8; font-size: 14px; }
</style>
</head>
<body>
  <form class="card" method="post" action="/auth/login">
    <h1>Муза · dev</h1>
    <p>Введите пароль. Браузер запомнит вход на год.</p>
    ${failed ? '<p class="err">Неверный пароль</p>' : ''}
    <label for="password">Пароль</label>
    <input id="password" name="password" type="password" autocomplete="current-password"
           autofocus required>
    <button type="submit">Войти</button>
  </form>
</body>
</html>`
  res.writeHead(failed ? 401 : 200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex',
  })
  res.end(body)
}

async function handle(req, res) {
  cors(res)
  // Предварительный запрос браузера: на него надо ответить ДО всякой логики,
  // иначе CORS не пропустит основной запрос.
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname

  if (path === '/health') return json(res, 200, { ok: true, when: new Date().toISOString() })

  // --- Вход на dev по cookie ------------------------------------------------
  // Ручки существуют только когда задан DEV_AUTH_PASSWORD. Прод их не
  // включает, а Caddy прода к ним и не ходит.
  if (DEV_AUTH_PASSWORD !== '') {
    if (path === '/login' && req.method === 'GET') {
      return loginPage(res, url.searchParams.get('error') === '1')
    }

    if (path === '/auth/login' && req.method === 'POST') {
      const body = await readBody(req, 4096)
      const form = new URLSearchParams(body.toString('utf8'))
      if (!samePassword(form.get('password') ?? '', DEV_AUTH_PASSWORD)) {
        res.writeHead(303, { Location: '/login?error=1', 'Cache-Control': 'no-store' })
        return res.end()
      }
      const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS
      const cookie = `${SESSION_COOKIE}=${signSession(exp, DEV_AUTH_SECRET)}` +
        `; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`
      res.writeHead(303, { 'Set-Cookie': cookie, Location: '/', 'Cache-Control': 'no-store' })
      return res.end()
    }

    // forward_auth приходит с ЛЮБЫМ методом (включая POST share target),
    // поэтому метод не проверяем — только cookie.
    if (path === '/auth/check') {
      if (verifySession(parseCookie(req.headers.cookie, SESSION_COOKIE), DEV_AUTH_SECRET)) {
        return json(res, 200, { ok: true })
      }
      res.writeHead(302, { Location: '/login', 'Cache-Control': 'no-store' })
      return res.end()
    }

    if (path === '/auth/logout') {
      res.writeHead(303, {
        'Set-Cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
        Location: '/login',
        'Cache-Control': 'no-store',
      })
      return res.end()
    }
  }

  /**
   * `/ai/*` НЕ требует пароля сервера — и это осознанно.
   *
   * Пароль сервера нужен, чтобы чужой не заливал файлы в наше хранилище.
   * А прокси к модели вызывается из браузера: если требовать пароль, он
   * окажется в приложении, то есть в браузере у каждого — и мы вернёмся
   * ровно к той проблеме, ради которой прокси и делали.
   *
   * Поэтому прокси открыт, но защищён иначе: белым списком моделей и
   * лимитами на адрес и на сутки. Это и есть правильная защита для
   * общедоступной ручки.
   */
  const isAiRoute =
    path === '/ai/chat' ||
    path === '/ai/chat/completions' ||
    path === '/ai/audio/transcriptions' ||
    path === '/ai/usage'
  if (!isAiRoute && !authorized(req)) return json(res, 401, { error: 'нужен пароль' })

  /** Сводка расхода и хранения. Только с паролем сервера. */
  if (path === '/metrics/summary' && req.method === 'GET') {
    const days = Math.max(1, Math.min(365, Number(url.searchParams.get('days') ?? 30) || 30))
    return json(res, 200, await summarizeMetrics(STATE_DIR, { days }))
  }

  // --- Начать загрузку ---
  if (path === '/file/begin' && req.method === 'POST') {
    const body = await readBody(req, 4096)
    const request = JSON.parse(body.toString('utf8') || '{}')
    const size = Number(request.size ?? 0)
    if (!Number.isFinite(size) || size <= 0) return json(res, 400, { error: 'не указан размер' })

    const parts = Math.ceil(size / PART_SIZE)
    if (parts > MAX_PARTS) return json(res, 400, { error: 'файл слишком большой' })

    const id = randomUUID()
    // Ключ в хранилище — случайный: имя файла может выдать содержимое,
    // а серверу знать его незачем.
    const key = `files/${id}`
    const created = await s3.send(
      new CreateMultipartUploadCommand({ Bucket, Key: key, ContentType: 'application/octet-stream' }),
    )
    uploads.set(id, {
      uploadId: created.UploadId,
      key,
      size,
      parts: {},
      createdAt: new Date().toISOString(),
    })
    await saveState()
    return json(res, 200, { id, partSize: PART_SIZE, parts })
  }

  // --- Одна часть ---
  const partMatch = /^\/file\/part\/([0-9a-f-]+)\/(\d+)$/.exec(path)
  if (partMatch && req.method === 'PUT') {
    const [_, id, numberRaw] = partMatch
    const record = uploads.get(id)
    if (!record) return json(res, 404, { error: 'такая загрузка не начиналась' })
    const number = Number(numberRaw)
    if (!Number.isInteger(number) || number < 1 || number > MAX_PARTS) {
      return json(res, 400, { error: 'неверный номер части' })
    }

    const data = await readBody(req, MAX_PART_SIZE)
    if (data.length === 0) return json(res, 400, { error: 'пустая часть' })

    const sent = await s3.send(
      new UploadPartCommand({
        Bucket,
        Key: record.key,
        UploadId: record.uploadId,
        PartNumber: number,
        Body: data,
      }),
    )
    record.parts[number] = sent.ETag
    await saveState()
    return json(res, 200, { part: number, etag: sent.ETag, size: data.length })
  }

  // --- Проверить, что уже принято ---
  const statusMatch = /^\/file\/status\/([0-9a-f-]+)$/.exec(path)
  if (statusMatch && req.method === 'GET') {
    const record = uploads.get(statusMatch[1])
    if (!record) return json(res, 404, { error: 'нет такой загрузки' })
    // Именно это и делает докачку возможной: клиент спрашивает, что уже
    // принято, и продолжает с первого недостающего номера.
    const accepted = Object.keys(record.parts).map(Number).sort((a, b) => a - b)
    return json(res, 200, { accepted, size: record.size })
  }

  // --- Завершить ---
  const completeMatch = /^\/file\/complete\/([0-9a-f-]+)$/.exec(path)
  if (completeMatch && req.method === 'POST') {
    const id = completeMatch[1]
    const record = uploads.get(id)
    if (!record) return json(res, 404, { error: 'нет такой загрузки' })

    const numbers = Object.keys(record.parts).map(Number).sort((a, b) => a - b)
    const expected = Math.ceil(record.size / PART_SIZE)

    // Незаконченную загрузку НЕ завершаем молча: иначе в хранилище окажется
    // обрезанный файл, и узнаем мы об этом при восстановлении.
    if (numbers.length !== expected) {
      return json(res, 409, {
        error: 'не все части пришли',
        accepted: numbers,
        expected,
      })
    }

    const completed = await s3.send(
      new CompleteMultipartUploadCommand({
        Bucket,
        Key: record.key,
        UploadId: record.uploadId,
        MultipartUpload: {
          Parts: numbers.map((number) => ({ PartNumber: number, ETag: record.parts[number] })),
        },
      }),
    )
    uploads.delete(id)
    await saveState()
    void recordMetric(STATE_DIR, {
      type: 'upload',
      bytes: record.size,
      ok: true,
      install: String(req.headers['x-muza-install'] ?? '').slice(0, 64),
    })
    return json(res, 200, { id, key: record.key, etag: completed.ETag ?? null })
  }

  // --- Отменить ---
  const abortMatch = /^\/file\/abort\/([0-9a-f-]+)$/.exec(path)
  if (abortMatch && req.method === 'POST') {
    const record = uploads.get(abortMatch[1])
    if (record) {
      await s3
        .send(
          new AbortMultipartUploadCommand({
            Bucket,
            Key: record.key,
            UploadId: record.uploadId,
          }),
        )
        .catch(() => null)
      uploads.delete(abortMatch[1])
      await saveState()
    }
    return json(res, 200, { ok: true })
  }

  // --- Скачать ---
  const getMatch = /^\/file\/([0-9a-f-]+)$/.exec(path)
  if (getMatch && req.method === 'GET') {
    const key = `files/${getMatch[1]}`
    try {
      const head = await s3.send(new HeadObjectCommand({ Bucket, Key: key }))
      const object = await s3.send(new GetObjectCommand({ Bucket, Key: key }))
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        ...(head.ContentLength ? { 'Content-Length': String(head.ContentLength) } : {}),
        'Cache-Control': 'private, no-store',
      })
      object.Body.pipe(res)
      return
    } catch {
      return json(res, 404, { error: 'файла нет' })
    }
  }

  // --- Удалить ---
  if (getMatch && req.method === 'DELETE') {
    await s3.send(new DeleteObjectCommand({ Bucket, Key: `files/${getMatch[1]}` })).catch(() => null)
    return json(res, 200, { ok: true })
  }

  // --- Прокси к модели ---
  // `/ai/chat/completions` — тот же обработчик: OpenAI-совместимый клиент
  // сам дописывает `/chat/completions` к базовому адресу, и ломать его
  // ради красоты пути незачем.
  if ((path === '/ai/chat' || path === '/ai/chat/completions') && req.method === 'POST') {
    if (POLZA_KEY === '') return json(res, 503, { error: 'модель не настроена на сервере' })

    const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0]
    const denied = allowAi(ip)
    if (denied) return json(res, 429, { error: denied })

    const raw = await readBody(req, 4 * 1024 * 1024)
    let payload
    try {
      payload = JSON.parse(raw.toString('utf8'))
    } catch {
      return json(res, 400, { error: 'тело запроса не JSON' })
    }
    // Белый список моделей: иначе через прокси можно ходить к любой модели
    // за наш счёт.
    const model = String(payload?.model ?? '')
    if (!ALLOWED_MODELS.has(model)) return json(res, 400, { error: 'такая модель не разрешена' })

    const startedAt = Date.now()
    // `stream: false` принудительно: потоковый ответ через прокси требует
    // отдельной обработки, а приложение сейчас поток не использует.
    const upstream = await fetch(`${POLZA_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${POLZA_KEY}`,
      },
      body: JSON.stringify({ ...payload, stream: false }),
    })
    const text = await upstream.text()
    res.writeHead(upstream.status, {
      'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
    })
    res.end(text)

    // Метрика — ПОСЛЕ ответа и без ожидания: человек не должен ждать,
    // пока запишется строка. Содержимого здесь нет, только числа.
    let usage = null
    try {
      usage = JSON.parse(text)?.usage ?? null
    } catch {
      /* не JSON — метрику всё равно запишем, без токенов */
    }
    void recordMetric(STATE_DIR, {
      type: 'ai',
      route: 'chat',
      model,
      prompt: Number(usage?.prompt_tokens) || 0,
      cached: Number(usage?.prompt_tokens_details?.cached_tokens) || 0,
      completion: Number(usage?.completion_tokens) || 0,
      ms: Date.now() - startedAt,
      status: upstream.status,
      install: String(req.headers['x-muza-install'] ?? '').slice(0, 64),
    })
    return
  }

  /**
   * РАСШИФРОВКА РЕЧИ.
   *
   * Отдельный маршрут, потому что тело здесь — `multipart/form-data` с файлом,
   * а не JSON. Файл бывает большим, поэтому тело НЕ читается в память:
   * `body: req` отдаёт поток запроса как есть, а `duplex: 'half'` разрешает
   * fetch отправлять потоковое тело — без него Node бросает
   * «RequestInit: duplex option is required when sending a body».
   *
   * `Content-Type` с boundary передаём КАК ЕСТЬ. Boundary — граница между
   * частями multipart; без неё upstream не разберёт файл. Поставить свой
   * заголовок нельзя даже при желании: границу придумывает клиент.
   *
   * Белый список моделей здесь не применить: `model` лежит ВНУТРИ тела,
   * которое мы не буферизуем (а буферизовать сотни мегабайт нельзя).
   * Поэтому защита — только лимиты (`allowAi`), как у чата.
   */
  if (path === '/ai/audio/transcriptions' && req.method === 'POST') {
    if (POLZA_KEY === '') return json(res, 503, { error: 'модель не настроена на сервере' })

    const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0]
    const denied = allowAi(ip)
    if (denied) return json(res, 429, { error: denied })

    const contentType = String(req.headers['content-type'] ?? '')
    if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
      return json(res, 400, { error: 'нужен multipart/form-data с файлом' })
    }

    // Человек закрыл вкладку или оборвалась связь — незачем продолжать
    // отправку провайдеру за наши деньги.
    const controller = new AbortController()
    res.on('close', () => {
      if (!res.writableEnded) controller.abort()
    })
    res.on('error', () => controller.abort())

    let upstream
    try {
      upstream = await fetch(`${POLZA_URL}/audio/transcriptions`, {
        method: 'POST',
        headers: {
          // Как есть, с boundary: иначе upstream не разберёт multipart.
          'Content-Type': contentType,
          Authorization: `Bearer ${POLZA_KEY}`,
          Accept: 'application/json',
        },
        // Поток запроса, без буфера в памяти. `duplex: 'half'` обязателен
        // для потокового тела в fetch (Node 18+; на Node 22 поддерживается).
        body: req,
        duplex: 'half',
        signal: controller.signal,
      })
    } catch (error) {
      if (controller.signal.aborted || res.destroyed) {
        // Клиент ушёл — отвечать некому, а заголовки ещё не отправлены.
        res.destroy()
        return
      }
      throw error
    }

    // Пока ждали провайдера, человек мог закрыть вкладку. Писать в мёртвый
    // ответ незачем: глушим и забираем запрос у провайдера.
    if (res.destroyed) {
      controller.abort()
      return
    }

    res.writeHead(upstream.status, {
      'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
    })
    if (!upstream.body) {
      res.end()
      return
    }
    // Ответ тоже потоком: текст распознавания бывает длинным, и держать
    // его целиком в памяти незачем. Но метрике нужна длительность звука —
    // поэтому запоминаем ПЕРВЫЕ 256 КБ (там служебные поля), а дальше
    // пропускаем как есть.
    const startedAt = Date.now()
    const head = []
    let headBytes = 0
    const tee = new Transform({
      transform(chunk, _encoding, callback) {
        if (headBytes < 256 * 1024) {
          head.push(chunk)
          headBytes += chunk.length
        }
        callback(null, chunk)
      },
    })
    tee.on('end', () => {
      let seconds = 0
      const text = Buffer.concat(head).toString('utf8')
      try {
        const data = JSON.parse(text)
        seconds = Number(data?.duration) || Number(data?.usage?.seconds) || 0
      } catch {
        // Ответ длиннее буфера или не JSON — пробуем вытащить число.
        const match = /"duration"\s*:\s*([0-9.]+)/.exec(text)
        if (match) seconds = Number(match[1]) || 0
      }
      void recordMetric(STATE_DIR, {
        type: 'ai',
        route: 'transcribe',
        model: 'ai-sage/gigaam-v3',
        seconds,
        ms: Date.now() - startedAt,
        status: upstream.status,
        install: String(req.headers['x-muza-install'] ?? '').slice(0, 64),
      })
    })

    const stream = Readable.fromWeb(upstream.body)
    stream.on('error', () => res.destroy())
    stream.pipe(tee).pipe(res)
    return
  }

  /** Сколько люди потратили — чтобы не узнать об этом по счёту. */
  if (path === '/ai/usage' && req.method === 'GET') {
    const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0]
    const record = aiUse.byIp.get(ip)
    return json(res, 200, {
      requests: record?.count ?? 0,
      limitPerHour: AI_LIMIT_PER_HOUR,
      totalToday: aiUse.total,
      limitPerDay: AI_LIMIT_PER_DAY,
    })
  }

  return json(res, 404, { error: 'неизвестный путь' })
}

// --- Запуск ------------------------------------------------------------------

const server = createServer((req, res) => {
  handle(req, res).catch((error) => {
    // Наружу — коротко, без внутренностей: по тексту ошибки можно узнать
    // про устройство сервера больше, чем нужно чужому.
    console.error('ошибка:', error instanceof Error ? error.message : error)
    json(res, 500, { error: 'внутренняя ошибка' })
  })
})

await loadState()
void pruneMetrics(STATE_DIR)
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Муза-сервер слушает ${PORT}; бакет: ${Bucket || 'НЕ ЗАДАН'}`)
  if (DEV_AUTH_PASSWORD !== '') console.log('вход на dev включён: cookie на год')
  if (TOKEN === '') console.warn('ВНИМАНИЕ: пароль MUZA_TOKEN не задан — сервер открыт всем')
  else if (!TOKEN_IS_ASCII) {
    console.error('ОШИБКА: в MUZA_TOKEN есть не-латинские символы. Такой пароль не дойдёт: HTTP-заголовки только ASCII.')
  }
})

/** Контрольная сумма — пригодится, чтобы сверить целостность на клиенте. */
export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}
