/**
 * Проверка расшифровки речи «Музы» без сети, без ключа и без настоящего ffmpeg.
 *
 * Запуск (как у `data-selftest.ts`):
 *   node_modules/.bin/rolldown tools/transcription-selftest.ts -o node_modules/.tmp/transcription-selftest.mjs --format esm
 *   node node_modules/.tmp/transcription-selftest.mjs
 *
 * Что здесь есть:
 *   1) подменённый `fetch`: проверяем multipart, поля, заголовок и разбор ответа;
 *   2) все ветки ошибок: нет ключа, 401/402/413/429/5xx, таймаут, битый JSON,
 *      пустой ответ, пустой текст, отмена;
 *   3) путь вырезания звука — через подменённое вырезание (настоящий ffmpeg.wasm
 *      в Node не запускается: ему нужен Worker и DOM).
 *
 * Чего здесь НЕТ: настоящего ffmpeg и настоящего polza.ai. Это проверка логики
 * сервиса, а не сквозная проверка распознавания.
 */

import {
  DEFAULT_TRANSCRIBE_MODEL,
  WHISPER_LARGE_V3_PRICING,
  costOfTranscription,
  createLlmConfig,
} from '../src/ai/config'
import {
  TranscriptionService,
  createTranscriptionService,
  type AudioExtractionJob,
} from '../src/video/TranscriptionService'
import {
  DEFAULT_MAX_UPLOAD_BYTES,
  DEFAULT_TRANSCRIPTION_SETTINGS,
  buildExtractAudioArgs,
  resolveTranscriptionSettings,
  shouldExtractAudio,
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
}): TranscriptionService {
  const config = createLlmConfig({
    apiKey: options.apiKey ?? 'test-key',
    ...(options.pricingRub === undefined
      ? {}
      : { transcribePricing: { perMinuteRub: options.pricingRub } }),
  })
  return new TranscriptionService(config, {
    settings: options.settings,
    deps: { fetch: options.fetch, extractAudio: options.extractAudio },
  })
}

const SMALL = { blob: blobOf(2048), mimeType: 'video/mp4', name: 'clip.mp4', durationSec: 5.5 }

// --- Тесты -------------------------------------------------------------------

async function main(): Promise<void> {
  // 1. Конфиг: модель и цена взяты из конфига, а не из кода вызова.
  await test('конфиг: модель Whisper и цена за минуту', () => {
    eq(DEFAULT_TRANSCRIBE_MODEL, 'openai/whisper-large-v3', 'модель по умолчанию — с префиксом провайдера')
    eq(WHISPER_LARGE_V3_PRICING, { perMinuteRub: 0.108 }, 'тариф Whisper Large V3 — 0,108 ₽/мин (каталог polza.ai)')
    eq(DEFAULT_TRANSCRIPTION_SETTINGS.maxUploadBytes, 15 * 1024 * 1024, 'лимит отправки — 15 МБ')
    eq(DEFAULT_MAX_UPLOAD_BYTES, 15 * 1024 * 1024, 'лимит вынесен в конфиг')
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
    eq(form.get('model'), 'openai/whisper-large-v3', 'модель из конфига')
    eq(form.get('language'), 'ru', 'язык ru')
    eq(form.get('response_format'), 'verbose_json', 'response_format = verbose_json')
    const file = form.get('file')
    ok(file instanceof Blob, 'поле file — файл, а не строка')
    eq((file as Blob).size, 2048, 'уходит исходный файл целиком')
    eq((file as File).name, 'clip.mp4', 'имя файла сохранено')

    eq(outcome.result.text, 'Привет, это тестовая заметка.', 'текст из ответа')
    eq(outcome.result.durationSec, 5.5, 'длительность из ответа')
    ok(Math.abs(outcome.result.costRub - (5.5 / 60) * 0.108) < 1e-12, 'стоимость по длительности и тарифу')
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
    ok(!c.ok && c.error.code === 'empty_response', 'пустой текст → empty_response')

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
