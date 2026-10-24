/**
 * Проверка расшифровки речи «Музы» без сети, без ключа и без настоящего ffmpeg.
 *
 * Запуск (как у `data-selftest.ts`):
 *   node_modules/.bin/rolldown tools/transcription-selftest.ts --dir node_modules/.tmp/trself --format esm
 *   node node_modules/.tmp/trself/transcription-selftest.js
 *
 * Что здесь есть:
 *   1) подменённый `fetch`: проверяем multipart, поля, заголовок и разбор ответа;
 *   2) все ветки ошибок: нет ключа, 401/402/413/429/5xx, таймаут, битый JSON,
 *      пустой ответ, пустой текст, отмена;
 *   3) путь вырезания звука — через подменённое вырезание (настоящий ffmpeg.wasm
 *      в Node не запускается: ему нужен Worker и DOM);
 *   4) сбой вырезания: отбор причины из лога ffmpeg, текст сообщения, аргументы
 *      второй попытки (`-c:a copy`) и решение «повторять или нет»;
 *   5) выбор модели по языку: русский текст — один запрос, латиница — вторая
 *      попытка запасной моделью, цена — сумма обеих; края порогов (19 букв,
 *      ровно 20, доля кириллицы 20%), пустой текст и сбой попыток.
 *
 * Чего здесь НЕТ: настоящего ffmpeg и настоящего polza.ai. Это проверка логики
 * сервиса, а не сквозная проверка распознавания.
 */

import {
  DEFAULT_TRANSCRIBE_FALLBACK_MODEL,
  DEFAULT_TRANSCRIBE_MODEL,
  GIGAAM_V3_PRICING,
  WHISPER_LARGE_V3_PRICING,
  costOfTranscription,
  createLlmConfig,
} from '../src/ai/config'
import {
  TranscriptionService,
  createTranscriptionService,
  retryExtractionWithCopy,
  type AudioExtractionJob,
} from '../src/video/TranscriptionService'
import {
  DEFAULT_MAX_UPLOAD_BYTES,
  DEFAULT_TRANSCRIPTION_SETTINGS,
  FFMPEG_LOG_LINE_LIMIT,
  FFMPEG_LOG_TAIL_LINES,
  LANGUAGE_CYRILLIC_MIN_SHARE,
  LANGUAGE_MIN_LETTERS,
  buildCopyAudioArgs,
  buildExtractAudioArgs,
  buildExtractFailureMessage,
  canRetryExtractionWithCopy,
  countTextLetters,
  describeFfmpegFailure,
  describeTranscriptionModel,
  detectTranscriptionLanguage,
  isMeaningfulFfmpegLine,
  looksLikeMemoryFailure,
  pickFfmpegReasonLines,
  resolveTranscriptionSettings,
  shouldExtractAudio,
  trimFfmpegLine,
  type TranscriptionSettings,
} from '../src/video/transcriptionConfig'
import type { TranscriptionOutcome } from '../src/video/transcriptionTypes'

// --- Крошечная проверялка ----------------------------------------------------

let passed = 0
const failures: string[] = []

function ok(condition: boolean, name: string): void {
  if (condition) {
    passed += 1
    return
  }
  failures.push(name)
  console.error(`✗ ${name}`)
}

function eq(actual: unknown, expected: unknown, name: string): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  if (!same) {
    failures.push(name)
    console.error(`✗ ${name}\n    ожидалось: ${JSON.stringify(expected)}\n    получено:  ${JSON.stringify(actual)}`)
    return
  }
  passed += 1
}

async function test(name: string, body: () => Promise<void> | void): Promise<void> {
  try {
    await body()
  } catch (error) {
    failures.push(name)
    console.error(`✗ ${name}: ${error instanceof Error ? error.stack : String(error)}`)
  }
}

// --- Подмена сети ------------------------------------------------------------

interface FetchCall {
  url: string
  init: RequestInit
}

type Handler = (call: FetchCall, index: number) => Response | Promise<Response>

function makeFetch(handler: Handler): { fn: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = []
  const fn = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const call: FetchCall = { url: String(input), init: init ?? {} }
    calls.push(call)
    return handler(call, calls.length - 1)
  }) as typeof fetch
  return { fn, calls }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function blobOf(bytes: number, type = 'video/mp4'): Blob {
  return new Blob([new Uint8Array(bytes)], { type })
}

/** Ответ распознавания: текст, длительность и сегменты. */
function transcribeResponse(text = 'Привет, это тестовая заметка.', duration = 5.5): Response {
  return json({
    text,
    language: 'ru',
    duration,
    model: 'openai/whisper-large-v3',
    segments: [{ id: 0, start: 0, end: duration, text }],
    usage: { durationSeconds: duration, cost: 0.01, cost_rub: 0.01 },
  })
}

function authHeader(call: FetchCall): string {
  return String((call.init.headers as Record<string, string> | undefined)?.Authorization ?? '')
}

function formOf(call: FetchCall): FormData {
  return call.init.body as FormData
}

/** Подменённое вырезание звука: пишем, что попросили, и отдаём «аудио». */
function fakeExtractor(bytes = 512, durationSec: number | null = null): {
  extractor: (job: AudioExtractionJob) => Promise<{ blob: Blob; mimeType: string; durationSec: number | null }>
  jobs: AudioExtractionJob[]
} {
  const jobs: AudioExtractionJob[] = []
  return {
    jobs,
    extractor: async (job) => {
      jobs.push(job)
      job.onProgress?.(0.5, 'Вырезаем звук…')
      return { blob: blobOf(bytes, 'audio/mp4'), mimeType: 'audio/mp4', durationSec }
    },
  }
}

/** Сервис с ключом, но без обращения к настоящей сети. */
function service(options: {
  fetch: typeof fetch
  extractAudio?: (job: AudioExtractionJob) => Promise<{ blob: Blob; mimeType: string; durationSec: number | null }>
  settings?: Partial<TranscriptionSettings>
  apiKey?: string
  pricingRub?: number
  /** Основная модель: нужна, чтобы проверить случай «модели совпали». */
  model?: string
  fallbackModel?: string
  fallbackPricingRub?: number
}): TranscriptionService {
  const config = createLlmConfig({
    apiKey: options.apiKey ?? 'test-key',
    ...(options.model === undefined ? {} : { transcribeModel: options.model }),
    ...(options.pricingRub === undefined
      ? {}
      : { transcribePricing: { perMinuteRub: options.pricingRub } }),
    ...(options.fallbackModel === undefined
      ? {}
      : { transcribeFallbackModel: options.fallbackModel }),
    ...(options.fallbackPricingRub === undefined
      ? {}
      : { transcribeFallbackPricing: { perMinuteRub: options.fallbackPricingRub } }),
  })
  return new TranscriptionService(config, {
    settings: options.settings,
    deps: { fetch: options.fetch, extractAudio: options.extractAudio },
  })
}

const SMALL = { blob: blobOf(2048), mimeType: 'video/mp4', name: 'clip.mp4', durationSec: 5.5 }

/** Английская речь так, как её выдаёт GigaAM: латиница, без кириллицы. */
const ENGLISH_TEXT = "You don't nee to pay for amimore if You Hava A USB Drive"
/** Улучшенный текст той же записи от Whisper — его и должен взять сервис. */
const ENGLISH_FIXED = 'You do not need to pay for anything more if you have a USB drive.'

// --- Тесты -------------------------------------------------------------------

async function main(): Promise<void> {
  // 1. Конфиг: модель и цена взяты из конфига, а не из кода вызова.
  await test('конфиг: модель распознавания и цена за минуту', () => {
    eq(DEFAULT_TRANSCRIBE_MODEL, 'ai-sage/gigaam-v3', 'по умолчанию — русская GigaAM, с префиксом провайдера')
    eq(GIGAAM_V3_PRICING, { perMinuteRub: 0.24171 }, 'тариф GigaAM v3 — 0,24171 ₽/мин (каталог polza.ai)')
    eq(WHISPER_LARGE_V3_PRICING, { perMinuteRub: 0.108 }, 'тариф Whisper Large V3 — 0,108 ₽/мин, запасной вариант (каталог polza.ai)')
    eq(DEFAULT_TRANSCRIPTION_SETTINGS.maxUploadBytes, 15 * 1024 * 1024, 'лимит отправки — 15 МБ')
    eq(DEFAULT_MAX_UPLOAD_BYTES, 15 * 1024 * 1024, 'лимит вынесен в конфиг')
    eq(DEFAULT_TRANSCRIBE_FALLBACK_MODEL, 'openai/whisper-large-v3', 'запасная модель по умолчанию — Whisper Large V3')
    const defaults = createLlmConfig()
    eq(defaults.transcribeFallbackModel, 'openai/whisper-large-v3', 'запасная модель есть в конфиге по умолчанию')
    eq(defaults.transcribeFallbackPricing, { perMinuteRub: 0.108 }, 'тариф запасной модели — 0,108 ₽/мин')
  })

  await test('конфиг: пустая запасная модель и битая цена — значения по умолчанию', () => {
    const config = createLlmConfig({
      transcribeFallbackModel: '   ',
      transcribeFallbackPricing: { perMinuteRub: -1 },
    })
    eq(config.transcribeFallbackModel, 'openai/whisper-large-v3', 'пустая запасная модель заменена')
    eq(config.transcribeFallbackPricing, { perMinuteRub: 0.108 }, 'отрицательная цена заменена тарифом по умолчанию')
  })

  await test('costOfTranscription: длительность × цена за минуту', () => {
    eq(costOfTranscription(60, { perMinuteRub: 0.108 }), 0.108, 'минута — 0,108 ₽')
    eq(Number(costOfTranscription(30, { perMinuteRub: 0.108 }).toFixed(4)), 0.054, '30 секунд — вдвое дешевле')
    eq(costOfTranscription(0, { perMinuteRub: 0.108 }), 0, 'неизвестная длительность — 0 ₽')
    eq(costOfTranscription(Number.NaN, { perMinuteRub: 0.108 }), 0, 'NaN — 0 ₽')
  })

  await test('shouldExtractAudio и аргументы вырезания звука', () => {
    const settings = resolveTranscriptionSettings()
    ok(!shouldExtractAudio(2 * 1024 * 1024, settings), 'маленький файл не вырезаем')
    ok(shouldExtractAudio(16 * 1024 * 1024, settings), 'файл больше лимита — вырезаем')
    eq(
      buildExtractAudioArgs('muza-input.mp4', 'muza-audio.m4a', settings),
      ['-hide_banner', '-y', '-i', 'muza-input.mp4', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'aac', '-b:a', '64k', 'muza-audio.m4a'],
      'аргументы: только звук, моно, 16 кГц, AAC',
    )
  })

  // 2. Успешный путь: multipart с нужными полями и разбор ответа.
  await test('успех: multipart, поля, заголовок, текст и стоимость', async () => {
    const stages: string[] = []
    const { fn, calls } = makeFetch(() => transcribeResponse())
    const outcome = await service({ fetch: fn }).transcribe({
      source: SMALL,
      onProgress: (event) => stages.push(event.stage),
    })

    ok(outcome.ok, 'результат успешный')
    if (!outcome.ok) return
    eq(calls.length, 1, 'ровно один запрос')
    eq(calls[0]?.url, 'https://polza.ai/api/v1/audio/transcriptions', 'адрес эндпоинта')
    eq(calls[0]?.init.method, 'POST', 'метод POST')
    eq(authHeader(calls[0]!), 'Bearer test-key', 'ключ в заголовке Authorization')
    ok(
      calls[0]?.init.headers !== undefined &&
        !('Content-Type' in (calls[0]!.init.headers as Record<string, string>)),
      'Content-Type не задан вручную: boundary ставит браузер',
    )

    const form = formOf(calls[0]!)
    ok(form instanceof FormData, 'тело — FormData (multipart/form-data)')
    eq(form.get('model'), 'ai-sage/gigaam-v3', 'модель из конфига (GigaAM по умолчанию)')
    eq(form.get('language'), 'ru', 'язык ru')
    eq(form.get('response_format'), 'verbose_json', 'response_format = verbose_json')
    const file = form.get('file')
    ok(file instanceof Blob, 'поле file — файл, а не строка')
    eq((file as Blob).size, 2048, 'уходит исходный файл целиком')
    eq((file as File).name, 'clip.mp4', 'имя файла сохранено')

    eq(outcome.result.text, 'Привет, это тестовая заметка.', 'текст из ответа')
    eq(outcome.result.durationSec, 5.5, 'длительность из ответа')
    ok(Math.abs(outcome.result.costRub - (5.5 / 60) * 0.24171) < 1e-12, 'стоимость по длительности и тарифу')
    eq(stages, ['check', 'upload', 'wait', 'finish'], 'этапы: отправка и ожидание — разные')
  })

  await test('длительность: сегменты и запасное значение', async () => {
    const first = makeFetch(() => json({ text: 'Есть', segments: [{ end: 12.5 }] }))
    const a = await service({ fetch: first.fn }).transcribe({ source: SMALL })
    ok(a.ok && a.result.durationSec === 12.5, 'без duration берём конец последнего сегмента')

    const second = makeFetch(() => json({ text: 'Есть' }))
    const b = await service({ fetch: second.fn, settings: { maxUploadBytes: 1_000_000 } }).transcribe({
      source: { ...SMALL, durationSec: 9 },
    })
    ok(b.ok && b.result.durationSec === 9, 'иначе — длительность, которую знал вызывающий код')

    const third = makeFetch(() => json({ text: 'Есть' }))
    const c = await service({ fetch: third.fn }).transcribe({
      source: { blob: blobOf(2048), mimeType: 'video/mp4' },
    })
    ok(c.ok && c.result.durationSec === 0 && c.result.costRub === 0, 'совсем неизвестно — 0 с и 0 ₽')
  })

  // 2а. Язык записи: доля кириллицы среди букв — чистая функция без сети.
  await test('язык записи: доля кириллицы среди букв', () => {
    eq(detectTranscriptionLanguage('Привет, это тестовая заметка.'), 'ru', 'русский текст — русский')
    eq(detectTranscriptionLanguage(ENGLISH_TEXT), 'other', 'латиница без кириллицы — не русский')
    eq(
      detectTranscriptionLanguage('Купил USB Drive для компьютера и забыл про него'),
      'ru',
      'русский текст с латинским термином остаётся русским',
    )
    eq(
      detectTranscriptionLanguage('Buy a new USB drive for your computer, и всё'),
      'other',
      'латиница с редкими русскими словами — всё равно не русский',
    )
    eq(detectTranscriptionLanguage('USB 1 000 ₽ !!!'), 'unknown', 'мало букв — язык не решаем')
    eq(detectTranscriptionLanguage('1234567890 0000 !!!'), 'unknown', 'одни цифры и знаки — язык не решаем')
    eq(detectTranscriptionLanguage(''), 'unknown', 'пустой текст — язык не решаем')
    eq(countTextLetters('1 000 ₽ и 5 букв'), { letters: 5, cyrillic: 5 }, 'цифры и знаки в долю букв не входят')
  })

  await test('язык записи: края порога — 19, ровно 20 букв и доля 20%', () => {
    eq(LANGUAGE_MIN_LETTERS, 20, 'порог букв — 20')
    eq(LANGUAGE_CYRILLIC_MIN_SHARE, 0.2, 'порог доли кириллицы — 20%')
    eq(detectTranscriptionLanguage('a'.repeat(19)), 'unknown', '19 букв — мало: лишнего запроса нет')
    eq(detectTranscriptionLanguage('a'.repeat(20)), 'other', 'ровно 20 латинских букв — уже не русский')
    const threshold = 'a'.repeat(16) + 'б'.repeat(4)
    eq(countTextLetters(threshold), { letters: 20, cyrillic: 4 }, 'ровно 20 букв, 4 из них кириллица')
    eq(detectTranscriptionLanguage(threshold), 'ru', 'ровно 20% кириллицы — ещё русский (порог строгий)')
    const below = 'a'.repeat(17) + 'б'.repeat(3)
    eq(detectTranscriptionLanguage(below), 'other', '15% кириллицы — уже не русский')
  })

  await test('подпись модели: без технического жаргона', () => {
    eq(
      describeTranscriptionModel('ai-sage/gigaam-v3', 'ru', false),
      'Распознано: русская модель.',
      'GigaAM — русская модель',
    )
    eq(
      describeTranscriptionModel('openai/whisper-large-v3', 'other', true),
      'Распознано: общая модель — речь не на русском.',
      'Whisper после второй попытки — общая модель',
    )
    eq(
      describeTranscriptionModel('openai/whisper-1', 'other', false),
      'Распознано: общая модель — возможно, речь не на русском.',
      'модели совпали: честная оговорка вместо выдумки',
    )
    eq(
      describeTranscriptionModel('', 'ru', false),
      'Распознано: модель распознавания.',
      'пустой идентификатор не ломает подпись',
    )
    ok(
      describeTranscriptionModel('vendor/custom-stt', 'ru', false).includes('vendor/custom-stt'),
      'незнакомую модель называем её именем',
    )
  })

  // 2б. Выбор модели по языку: русская речь лишнего запроса не делает.
  await test('русская речь: запасная модель не вызывается, цена как раньше', async () => {
    const { fn, calls } = makeFetch(() => transcribeResponse('Привет, это тестовая заметка.', 60))
    const outcome = await service({ fetch: fn }).transcribe({ source: SMALL })

    ok(outcome.ok, 'результат успешный')
    eq(calls.length, 1, 'ровно один запрос — запасная модель не тронута')
    eq(formOf(calls[0]!).get('model'), 'ai-sage/gigaam-v3', 'запрос ушёл к основной модели')
    if (!outcome.ok) return
    eq(outcome.result.model, 'ai-sage/gigaam-v3', 'сработала русская модель')
    eq(outcome.result.language, 'ru', 'язык — русский')
    eq(outcome.result.usedFallback, false, 'второй попытки не было')
    ok(Math.abs(outcome.result.costRub - 0.24171) < 1e-12, 'минута по тарифу GigaAM — как раньше')
  })

  await test('английская речь: вторая попытка Whisper, текст её, цена — сумма', async () => {
    const { fn, calls } = makeFetch((_call, index) =>
      index === 0 ? transcribeResponse(ENGLISH_TEXT, 60) : transcribeResponse(ENGLISH_FIXED, 60),
    )
    const outcome = await service({ fetch: fn }).transcribe({ source: SMALL })

    ok(outcome.ok, 'результат успешный')
    eq(calls.length, 2, 'два запроса: основная модель, затем запасная')
    eq(formOf(calls[0]!).get('model'), 'ai-sage/gigaam-v3', 'первый запрос — основная модель')
    eq(formOf(calls[1]!).get('model'), 'openai/whisper-large-v3', 'второй запрос — запасная модель')
    if (!outcome.ok) return
    eq(outcome.result.text, ENGLISH_FIXED, 'взят текст запасной модели, а не латиница GigaAM')
    eq(outcome.result.model, 'openai/whisper-large-v3', 'сработала общая модель')
    eq(outcome.result.language, 'other', 'язык — не русский')
    eq(outcome.result.usedFallback, true, 'признак второй попытки виден наружу')
    ok(Math.abs(outcome.result.costRub - (0.24171 + 0.108)) < 1e-12, 'цена — сумма обеих попыток')
  })

  await test('смешанный текст: кириллицы больше — второй попытки нет', async () => {
    const mixed = 'Купил USB Drive для компьютера, теперь он лежит в ящике'
    const { fn, calls } = makeFetch(() => transcribeResponse(mixed, 30))
    const outcome = await service({ fetch: fn }).transcribe({ source: SMALL })
    eq(calls.length, 1, 'один запрос')
    ok(outcome.ok && outcome.result.language === 'ru', 'преобладание кириллицы — русский')
    ok(outcome.ok && !outcome.result.usedFallback, 'второй попытки не было')
  })

  await test('короткий текст: язык не решаем, лишнего запроса нет', async () => {
    const { fn, calls } = makeFetch(() => transcribeResponse('Yes, of course', 10))
    const outcome = await service({ fetch: fn }).transcribe({ source: SMALL })
    eq(calls.length, 1, 'один запрос')
    ok(outcome.ok && outcome.result.language === 'unknown', 'букв мало — язык не определён')
    ok(outcome.ok && !outcome.result.usedFallback, 'второй попытки не было')
  })

  await test('цифры и знаки без букв: второй попытки нет', async () => {
    const { fn, calls } = makeFetch(() => transcribeResponse('1 000 000 ₽ !!! 42', 10))
    const outcome = await service({ fetch: fn }).transcribe({ source: SMALL })
    eq(calls.length, 1, 'один запрос')
    ok(outcome.ok && outcome.result.language === 'unknown', 'букв нет — решение не принимаем')
  })

  await test('модели совпали: второй попытки нет даже на латинице', async () => {
    const { fn, calls } = makeFetch(() => transcribeResponse(ENGLISH_TEXT, 60))
    const outcome = await service({ fetch: fn, fallbackModel: 'ai-sage/gigaam-v3' }).transcribe({
      source: SMALL,
    })
    eq(calls.length, 1, 'модели совпали — лишнего запроса нет')
    ok(outcome.ok && !outcome.result.usedFallback, 'второй попытки не было')
    ok(outcome.ok && outcome.result.language === 'other', 'но язык честно помечен как нерусский')
  })

  await test('пустой текст: это «речи нет», а не язык — второй попытки нет', async () => {
    const { fn, calls } = makeFetch(() => json({ text: '   ', duration: 3 }))
    const outcome = await service({ fetch: fn }).transcribe({ source: SMALL })

    ok(!outcome.ok && outcome.error.code === 'no_speech', 'код no_speech')
    eq(calls.length, 1, 'запасная модель не вызывалась')
    ok(!outcome.ok && !outcome.error.retriable, 'повтор не предлагается')
    ok(!outcome.ok && outcome.error.message.includes('нет речи'), 'человеку сказано про отсутствие речи')
    ok(!outcome.ok && outcome.error.message.includes('обычное дело'), 'это обычный случай, а не поломка')
  })

  await test('сбой первой попытки: второй нет, ошибка как раньше', async () => {
    const { fn, calls } = makeFetch(() => json({ error: { message: 'провайдер отказал' } }, 402))
    const outcome = await service({ fetch: fn }).transcribe({ source: SMALL })
    ok(!outcome.ok && outcome.error.code === 'budget', 'ошибка первой попытки')
    eq(calls.length, 1, 'запасная модель не вызывалась')
  })

  await test('сбой запасной попытки: отдаём текст основной, а не ошибку', async () => {
    const { fn, calls } = makeFetch((_call, index) =>
      index === 0
        ? transcribeResponse(ENGLISH_TEXT, 60)
        : json({ error: { message: 'сервис недоступен' } }, 503),
    )
    const outcome = await service({ fetch: fn }).transcribe({ source: SMALL })
    eq(calls.length, 2, 'обе попытки были')
    // За первую попытку уже заплачено, и текст на руках. Вернуть ошибку —
    // значит взять деньги и не дать ничего. Поэтому отдаём текст основной
    // модели, а причину — примечанием.
    ok(outcome.ok, 'ошибка не уходит наружу: текст основной модели сохранён')
    if (outcome.ok) {
      eq(outcome.result.text, ENGLISH_TEXT, 'текст основной модели, а не потерянный')
      ok(outcome.result.note !== null, 'причина отказа запасной модели — в примечании')
      ok(
        String(outcome.result.note).includes('общая модель не ответила'),
        'примечание объясняет, что случилось',
      )
      ok(
        String(outcome.result.note).includes('списано') &&
          String(outcome.result.note).includes('₽'),
        'примечание показывает, сколько списано за попытку',
      )
      ok(!outcome.result.usedFallback, 'запасной моделью текст не получен')
    }
  })

  await test('прогресс с запасной моделью: не убывает и доходит до конца', async () => {
    const events: Array<{ progress: number; stage: string }> = []
    const { fn } = makeFetch((_call, index) =>
      index === 0 ? transcribeResponse(ENGLISH_TEXT, 60) : transcribeResponse(ENGLISH_FIXED, 60),
    )
    await service({ fetch: fn }).transcribe({
      source: SMALL,
      onProgress: (event) => events.push({ progress: event.progress, stage: event.stage }),
    })
    let previous = -1
    const monotonic = events.every((event) => {
      const good = event.progress >= previous
      previous = event.progress
      return good
    })
    ok(monotonic, 'прогресс не убывает и на второй попытке')
    eq(events[events.length - 1]?.progress, 1, 'прогресс доходит до 1')
    eq(events[events.length - 1]?.stage, 'finish', 'последний этап — finish')
  })

  // 3. Нет ключа: сеть не трогаем вообще.
  await test('нет ключа: ноль запросов и понятная ошибка', async () => {
    const { fn, calls } = makeFetch(() => transcribeResponse())
    const outcome = await service({ fetch: fn, apiKey: '' }).transcribe({ source: SMALL })
    ok(!outcome.ok, 'успеха нет')
    eq(calls.length, 0, 'запрос НЕ ушёл')
    if (!outcome.ok) {
      eq(outcome.error.code, 'no_key', 'код ошибки no_key')
      ok(outcome.error.message.includes('ключ'), 'сообщение объясняет про ключ')
      ok(outcome.error.message.includes('на месте'), 'сказано, что файл и идея на месте')
    }
  })

  await test('пустой файл: ошибка без запроса', async () => {
    const { fn, calls } = makeFetch(() => transcribeResponse())
    const outcome = await service({ fetch: fn }).transcribe({ source: { blob: blobOf(0) } })
    ok(!outcome.ok && outcome.error.code === 'invalid_file', 'код invalid_file')
    eq(calls.length, 0, 'запрос не ушёл')
  })

  // 4. Большой файл: вырезаем звук и отправляем только его.
  await test('большой файл: звук вырезан, уходит аудио', async () => {
    const { fn, calls } = makeFetch(() => transcribeResponse())
    const fake = fakeExtractor(1024)
    const outcome = await service({
      fetch: fn,
      extractAudio: fake.extractor,
      settings: { maxUploadBytes: 4096 },
    }).transcribe({ source: { blob: blobOf(64 * 1024), mimeType: 'video/mp4', name: 'long.mp4' } })

    ok(outcome.ok, 'результат успешный')
    eq(fake.jobs.length, 1, 'вырезание звука вызвано один раз')
    eq(fake.jobs[0]?.source.name, 'long.mp4', 'на вход вырезания — исходный файл')
    eq(calls.length, 1, 'ровно один запрос — уже с аудио')
    const file = formOf(calls[0]!).get('file') as File
    eq(file.size, 1024, 'уходит вырезанный звук, а не видео')
    eq(file.name, 'muza-audio.m4a', 'имя аудио')
  })

  await test('после вырезания всё ещё больше лимита: понятная ошибка без запроса', async () => {
    const { fn, calls } = makeFetch(() => transcribeResponse())
    const fake = fakeExtractor(8192)
    const outcome = await service({
      fetch: fn,
      extractAudio: fake.extractor,
      settings: { maxUploadBytes: 4096 },
    }).transcribe({ source: { blob: blobOf(64 * 1024) } })

    ok(!outcome.ok && outcome.error.code === 'too_large', 'код too_large')
    eq(calls.length, 0, 'запрос не ушёл')
    ok(!outcome.ok && outcome.error.message.includes('Разделите'), 'человеку сказано, что делать')
  })

  await test('ошибка вырезания звука не теряет файл', async () => {
    const { fn, calls } = makeFetch(() => transcribeResponse())
    const outcome = await service({
      fetch: fn,
      extractAudio: async () => {
        throw new Error('ffmpeg core is not created')
      },
      settings: { maxUploadBytes: 1024 },
    }).transcribe({ source: { blob: blobOf(64 * 1024) } })

    ok(!outcome.ok && outcome.error.code === 'extract_failed', 'код extract_failed')
    eq(calls.length, 0, 'запрос не ушёл')
    ok(!outcome.ok && outcome.error.retriable, 'ошибка помечена как повторяемая')
  })

  // 5. 413: сервис не принял файл — вырезаем звук и пробуем снова.
  await test('413 на видео: вырезаем звук и повторяем запрос', async () => {
    let attempt = 0
    const seen: number[] = []
    const { fn, calls } = makeFetch((call) => {
      attempt += 1
      seen.push((formOf(call).get('file') as Blob).size)
      if (attempt === 1) return json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'too big' } }, 413)
      return transcribeResponse()
    })
    const fake = fakeExtractor(1024)
    const outcome = await service({ fetch: fn, extractAudio: fake.extractor }).transcribe({
      source: SMALL,
    })

    ok(outcome.ok, 'вторая попытка успешна')
    eq(calls.length, 2, 'два запроса: видео, затем звук')
    eq(seen, [2048, 1024], 'во второй раз ушло аудио')
    eq(fake.jobs.length, 1, 'звук вырезан один раз')
  })

  await test('413 и на звук: честная ошибка «слишком большой»', async () => {
    const { fn, calls } = makeFetch(() => json({ error: { code: 'PAYLOAD_TOO_LARGE' } }, 413))
    const fake = fakeExtractor(1024)
    const outcome = await service({ fetch: fn, extractAudio: fake.extractor }).transcribe({
      source: SMALL,
    })
    ok(!outcome.ok && outcome.error.code === 'too_large', 'код too_large')
    eq(calls.length, 2, 'было ровно две попытки')
    ok(!outcome.ok && outcome.error.message.includes('даже звук'), 'сообщение уточняет про звук')
  })

  // 6. Разные отказы — разные понятные сообщения.
  await test('401 / 402 / 429 / 5xx — разные коды', async () => {
    const cases: Array<{ status: number; code: string; retriable: boolean; tail: boolean }> = [
      { status: 401, code: 'auth', retriable: false, tail: false },
      { status: 403, code: 'auth', retriable: false, tail: false },
      { status: 402, code: 'budget', retriable: false, tail: false },
      { status: 429, code: 'rate_limit', retriable: true, tail: false },
      { status: 500, code: 'server', retriable: true, tail: true },
      { status: 503, code: 'server', retriable: true, tail: true },
      { status: 400, code: 'http', retriable: false, tail: true },
    ]
    for (const item of cases) {
      const { fn } = makeFetch(() => json({ error: { message: 'провайдер объяснил' } }, item.status))
      const outcome: TranscriptionOutcome = await service({ fetch: fn }).transcribe({ source: SMALL })
      if (outcome.ok) {
        ok(false, `HTTP ${item.status}: ожидалась ошибка`)
        continue
      }
      eq(outcome.error.code, item.code, `HTTP ${item.status} → код ${item.code}`)
      eq(outcome.error.status, item.status, `HTTP ${item.status} → статус сохранён`)
      eq(outcome.error.retriable, item.retriable, `HTTP ${item.status} → retriable=${item.retriable}`)
      if (item.tail) {
        eq(outcome.error.message.includes('провайдер объяснил'), true, `HTTP ${item.status}: хвост ответа в сообщении`)
      }
    }
  })

  await test('таймаут: запрос не ответил вовремя', async () => {
    const { fn } = makeFetch(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = call.init.signal as AbortSignal
          signal.addEventListener('abort', () => reject(new Error('aborted by timeout')))
        }),
    )
    const outcome = await service({ fetch: fn, settings: { requestTimeoutMs: 30 } }).transcribe({
      source: SMALL,
    })
    ok(!outcome.ok && outcome.error.code === 'timeout', 'код timeout')
    ok(!outcome.ok && outcome.error.retriable, 'таймаут можно повторить')
  })

  await test('отмена через AbortSignal останавливает работу', async () => {
    let abortedAtReject = false
    const { fn, calls } = makeFetch(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = call.init.signal as AbortSignal
          signal.addEventListener('abort', () => {
            abortedAtReject = signal.aborted
            reject(new Error('AbortError'))
          })
        }),
    )
    const controller = new AbortController()
    const pending = service({ fetch: fn, settings: { requestTimeoutMs: 5_000 } }).transcribe({
      source: SMALL,
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 20)
    const outcome = await pending
    ok(!outcome.ok && outcome.error.code === 'aborted', 'код aborted')
    eq(calls.length, 1, 'запрос был отправлен и прерван')
    ok(abortedAtReject, 'сигнал действительно прервал запрос')
    ok(!outcome.ok && outcome.error.message.includes('на месте'), 'файл не потерян')
  })

  await test('отмена до отправки: ноль запросов', async () => {
    const controller = new AbortController()
    controller.abort()
    const { fn, calls } = makeFetch(() => transcribeResponse())
    const outcome = await service({ fetch: fn }).transcribe({ source: SMALL, signal: controller.signal })
    ok(!outcome.ok && outcome.error.code === 'aborted', 'код aborted')
    eq(calls.length, 0, 'запрос не ушёл')
  })

  await test('битый JSON и пустое тело — разные ошибки', async () => {
    const broken = makeFetch(() => new Response('{это не json', { status: 200 }))
    const a = await service({ fetch: broken.fn }).transcribe({ source: SMALL })
    ok(!a.ok && a.error.code === 'invalid_json', 'битый JSON → invalid_json')

    const empty = makeFetch(() => new Response('', { status: 200 }))
    const b = await service({ fetch: empty.fn }).transcribe({ source: SMALL })
    ok(!b.ok && b.error.code === 'empty_response', 'пустое тело → empty_response')

    const noText = makeFetch(() => json({ text: '   ', duration: 3 }))
    const c = await service({ fetch: noText.fn }).transcribe({ source: SMALL })
    ok(!c.ok && c.error.code === 'no_speech', 'пустой текст → no_speech: речи нет, это не поломка')

    const asyncModel = makeFetch(() => json({ id: 'gen_1', status: 'processing' }))
    const d = await service({ fetch: asyncModel.fn }).transcribe({ source: SMALL })
    ok(!d.ok && d.error.code === 'unsupported', 'асинхронная модель → unsupported')
  })

  await test('сеть недоступна: понятная ошибка', async () => {
    const fn = (async () => {
      throw new TypeError('fetch failed')
    }) as typeof fetch
    const outcome = await service({ fetch: fn }).transcribe({ source: SMALL })
    ok(!outcome.ok && outcome.error.code === 'network', 'код network')
    ok(!outcome.ok && outcome.error.retriable, 'сеть можно повторить')
  })

  // 7. Ключ, модель и цена — из `meta`.
  await test('настройки из meta: ключ, база, модель и цена', async () => {
    const values: Record<string, unknown> = {
      'llm.api_key': 'key-from-meta',
      'llm.base_url': 'https://example.test/api/v1/',
      'llm.transcribe_model': 'openai/whisper-large-v3-turbo',
      'llm.transcribe_price_rub': 0.05,
    }
    const store = { get: (key: string) => values[key] }
    const { fn, calls } = makeFetch(() => transcribeResponse('Текст', 120))
    const created = await createTranscriptionService({ store, deps: { fetch: fn } })
    const outcome = await created.transcribe({ source: SMALL })

    ok(outcome.ok, 'результат успешный')
    eq(created.model, 'openai/whisper-large-v3-turbo', 'модель взята из meta')
    eq(calls[0]?.url, 'https://example.test/api/v1/audio/transcriptions', 'адрес без двойного слэша')
    eq(authHeader(calls[0]!), 'Bearer key-from-meta', 'ключ взят из meta')
    ok(!outcome.ok || Math.abs(outcome.result.costRub - 0.1) < 1e-12, 'цена 0,05 ₽/мин × 2 мин = 0,10 ₽')
  })

  await test('явный конфиг сильнее meta', async () => {
    const store = { get: () => '2' }
    const { fn } = makeFetch(() => transcribeResponse())
    const created = await createTranscriptionService({
      store,
      config: { apiKey: 'explicit', transcribeModel: 'openai/whisper-1' },
      deps: { fetch: fn },
    })
    eq(created.model, 'openai/whisper-1', 'явная модель не перекрыта хранилищем')
    eq(created.hasKey(), true, 'ключ на месте')
  })

  await test('настройки из meta: запасная модель и её цена', async () => {
    const values: Record<string, unknown> = {
      'llm.api_key': 'key-from-meta',
      'llm.transcribe_model': 'ai-sage/gigaam-v3',
      'llm.transcribe_fallback_model': 'openai/whisper-large-v3-turbo',
      'llm.transcribe_fallback_price_rub': 0.048,
    }
    const store = { get: (key: string) => values[key] }
    const { fn, calls } = makeFetch((_call, index) =>
      index === 0 ? transcribeResponse(ENGLISH_TEXT, 60) : transcribeResponse(ENGLISH_FIXED, 60),
    )
    const created = await createTranscriptionService({ store, deps: { fetch: fn } })
    eq(created.fallbackModel, 'openai/whisper-large-v3-turbo', 'запасная модель взята из meta')
    eq(created.model, 'ai-sage/gigaam-v3', 'основная модель тоже из meta')

    const outcome = await created.transcribe({ source: SMALL })
    eq(calls.length, 2, 'нерусская речь — вторая попытка')
    eq(formOf(calls[1]!).get('model'), 'openai/whisper-large-v3-turbo', 'вторая попытка — модель из meta')
    if (!outcome.ok) {
      ok(false, 'ожидался успешный результат')
      return
    }
    eq(outcome.result.text, ENGLISH_FIXED, 'взят текст запасной модели')
    ok(
      Math.abs(outcome.result.costRub - (0.24171 + 0.048)) < 1e-12,
      'цена — сумма двух тарифов из meta',
    )
  })

  // 8. Прогресс: полоса не идёт назад и доходит до конца.
  await test('прогресс: 0..1 без шагов назад, вырезание видно', async () => {
    const events: Array<{ progress: number; stage: string }> = []
    const { fn } = makeFetch(() => transcribeResponse())
    const fake = fakeExtractor(512)
    await service({ fetch: fn, extractAudio: fake.extractor, settings: { maxUploadBytes: 1024 } }).transcribe({
      source: { blob: blobOf(8192), durationSec: 30 },
      onProgress: (event) => events.push({ progress: event.progress, stage: event.stage }),
    })
    const stages = events.map((event) => event.stage)
    ok(stages.includes('extract'), 'этап вырезания звука виден')
    ok(stages.includes('upload') && stages.includes('wait'), 'отправка и ожидание — разные этапы')
    eq(stages[stages.length - 1], 'finish', 'последний этап — finish')
    let previous = -1
    const monotonic = events.every((event) => {
      const good = event.progress >= previous
      previous = event.progress
      return good
    })
    ok(monotonic, 'прогресс не убывает')
    eq(events[events.length - 1]?.progress, 1, 'прогресс доходит до 1')
  })

  // 9. Сбой вырезания: причина из лога ffmpeg и вторая попытка копированием.
  await test('аргументы второй попытки: звук копируется без перекодирования', () => {
    const args = buildCopyAudioArgs('muza-input.mp4', 'muza-audio.m4a')
    eq(
      args,
      ['-hide_banner', '-y', '-i', 'muza-input.mp4', '-vn', '-c:a', 'copy', 'muza-audio.m4a'],
      'вторая попытка: -c:a copy, тот же контейнер, без -ac/-ar/-b:a',
    )
    eq(args[args.length - 1], 'muza-audio.m4a', 'контейнер второй попытки тот же')
    ok(!args.includes('-ac') && !args.includes('-ar'), 'при копировании частота и каналы не задаются')
  })

  await test('лог ffmpeg: прогресс и служебные строки отсеиваются', () => {
    ok(
      !isMeaningfulFfmpegLine('frame= 120 fps=20 q=28.0 size= 256kB time=00:00:04.00 bitrate= 524.3kbits/s speed=1.2x'),
      'прогресс-бар — не осмысленная строка',
    )
    ok(
      !isMeaningfulFfmpegLine('  Duration: 00:00:30.02, start: 0.000000, bitrate: 5068 kb/s'),
      'строка Duration — служебная',
    )
    ok(
      !isMeaningfulFfmpegLine('  Stream #0:1(und): Audio: aac (LC), 44100 Hz, stereo, fltp, 128 kb/s'),
      'описание потока — служебное',
    )
    ok(!isMeaningfulFfmpegLine('ffmpeg version 0.12.6'), 'баннер — служебная строка')
    ok(
      isMeaningfulFfmpegLine('[mov,mp4,m4a,3gp,3g2,mj2 @ 0x55f0] moov atom not found'),
      'причина отказа — осмысленная строка',
    )
  })

  await test('причина из лога: последние полезные строки, без мусора и без простыни', () => {
    const lines = [
      'ffmpeg version 0.12.6',
      "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'muza-input.mp4':",
      '  Duration: 00:00:42.00, start: 0.000000, bitrate: 2500 kb/s',
      'frame=  10 fps=5 q=0.0 size= 0kB time=00:00:00.10 bitrate= 1.0kbits/s speed=1x',
      '[mov,mp4,m4a,3gp,3g2,mj2 @ 0x55f0] moov atom not found',
      '[in#0 @ 0x55f0] Error opening input: Invalid data found when processing input',
      'Error opening input file muza-input.mp4.',
      'Conversion failed!',
      'frame=  20 fps=5 q=0.0 size= 0kB time=00:00:00.20 bitrate= 1.0kbits/s speed=1x',
    ]
    const reason = pickFfmpegReasonLines(lines)
    ok(reason.length > 0 && reason.length <= FFMPEG_LOG_TAIL_LINES, 'строк не больше лимита')
    ok(reason.some((line) => line.includes('moov atom not found')), 'причина формата попала в выборку')
    ok(!reason.some((line) => /frame=|bitrate=/.test(line)), 'прогресс в причину не попал')
    ok(!reason.some((line) => line.includes('Duration:')), 'служебные метаданные не попали')
    ok(reason.every((line) => !line.startsWith('[')), 'адрес модуля из строки убран')
    ok(!reason.includes('Conversion failed!'), 'общая концовка не вытесняет содержательные строки')

    // Если содержательных строк нет, «Conversion failed!» остаётся: хоть что-то.
    eq(pickFfmpegReasonLines(['Conversion failed!']), ['Conversion failed!'], 'без других причин концовка показывается')
  })

  await test('строка лога обрезается по длине', () => {
    const trimmed = trimFfmpegLine(`[mov,mp4 @ 0x1f] ${'x'.repeat(400)}`)
    ok(trimmed.length <= FFMPEG_LOG_LINE_LIMIT + 1, 'длинная строка обрезана')
    ok(trimmed.endsWith('…'), 'обрезка помечена многоточием')
    eq(trimFfmpegLine('  [aac @ 0xAB12]  Unsupported   codec. '), 'Unsupported codec.', 'лишние пробелы и адрес убраны')
  })

  await test('понятная причина: формат, кодек, память, нет дорожки', () => {
    ok(describeFfmpegFailure(['moov atom not found']).includes('формат'), 'битый контейнер → про формат')
    ok(describeFfmpegFailure(['Unsupported codec.']).includes('кодек'), 'незнакомый кодек → про кодек')
    ok(describeFfmpegFailure(['Cannot enlarge memory arrays.']).includes('памяти'), 'память → про память')
    ok(
      describeFfmpegFailure(['Output file does not contain any stream']).includes('звуковая дорожка'),
      'нет потока → про дорожку',
    )
  })

  await test('сообщение о сбое: причина от ffmpeg и понятный текст', () => {
    const message = buildExtractFailureMessage(
      ['[mov,mp4,m4a,3gp,3g2,mj2 @ 0x55f0] moov atom not found', 'Conversion failed!'],
      1,
    )
    ok(message.includes('moov atom not found'), 'в сообщении видна причина ffmpeg, а не только код')
    ok(message.includes('код 1'), 'код выхода остаётся для диагностики')
    ok(!message.includes('ffmpeg не смог вырезать звук (код'), 'старая тупиковая формулировка ушла')
    ok(message.includes('Оригинал не тронут'), 'сказано, что оригинал не тронут')
    ok(message.includes('идея и файл на месте'), 'сказано, что идея и файл на месте')
    ok(message.includes('голосовую заметку'), 'подсказан запасной путь')
    eq(message.split('\n').length, 2, 'причина — отдельной строкой')
    ok(!/frame=|size=|bitrate=/.test(message), 'прогресс в сообщение не попал')
  })

  await test('сообщение о сбое без лога: код выхода остаётся единственной зацепкой', () => {
    const message = buildExtractFailureMessage([], 1)
    ok(message.includes('(код 1)'), 'код выхода виден, когда лога нет')
    ok(message.includes('Оригинал не тронут'), 'оригинал не тронут')
    eq(message.split('\n').length, 1, 'без причины второй строки нет')
  })

  await test('решение о второй попытке: отмена, таймаут и память — не повторяем', () => {
    ok(
      canRetryExtractionWithCopy({ aborted: false, timedOut: false, outOfMemory: false }),
      'обычный отказ ffmpeg — повторяем копированием',
    )
    ok(
      !canRetryExtractionWithCopy({ aborted: true, timedOut: false, outOfMemory: false }),
      'отмена — второй попытки нет',
    )
    ok(
      !canRetryExtractionWithCopy({ aborted: false, timedOut: true, outOfMemory: false }),
      'таймаут — второй попытки нет',
    )
    ok(
      !canRetryExtractionWithCopy({ aborted: false, timedOut: false, outOfMemory: true }),
      'нехватка памяти — второй попытки нет',
    )
    ok(looksLikeMemoryFailure('Cannot enlarge memory arrays'), 'текст про память распознан')
    ok(!looksLikeMemoryFailure('moov atom not found'), 'битый контейнер — не про память')
  })

  await test('вторая попытка запускается только при годном ядре', async () => {
    let copyCalls = 0
    const runCopy = async (): Promise<number> => {
      copyCalls += 1
      return 0
    }

    const plain = await retryExtractionWithCopy({
      failure: { aborted: false, timedOut: false, outOfMemory: false },
      runCopy,
    })
    eq(plain, 0, 'обычный отказ ffmpeg: копирование запущено и вернуло код 0')
    eq(copyCalls, 1, 'копирование вызвано ровно один раз')

    const noRetry: Array<{ name: string; failure: { aborted: boolean; timedOut: boolean; outOfMemory: boolean } }> = [
      { name: 'отмена', failure: { aborted: true, timedOut: false, outOfMemory: false } },
      { name: 'таймаут', failure: { aborted: false, timedOut: true, outOfMemory: false } },
      { name: 'нехватка памяти', failure: { aborted: false, timedOut: false, outOfMemory: true } },
    ]
    for (const item of noRetry) {
      const result = await retryExtractionWithCopy({ failure: item.failure, runCopy })
      eq(result, null, `${item.name}: второй попытки нет`)
    }
    eq(copyCalls, 1, 'при отмене, таймауте и памяти копирование не запускалось')
  })

  // Итог.
  console.log('')
  if (failures.length === 0) {
    console.log(`✓ Все проверки пройдены: ${passed}`)
  } else {
    console.error(`✗ Провалено проверок: ${failures.length} из ${passed + failures.length}`)
    process.exitCode = 1
  }
}

await main()
