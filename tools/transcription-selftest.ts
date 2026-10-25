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
 *      ровно 20, доля кириллицы 20%), пустой текст и сбой попыток;
 *   6) своё скачивание ядра ffmpeg (вместо `toBlobURL` из `@ffmpeg/util`):
 *      тело читается один раз, короткий `Content-Length` не ошибка, нет потока,
 *      не-2xx с кодом, отмена во время чтения, монотонный прогресс;
 *   7) крупный файл: WORKERFS монтирует `File` с настоящим расширением,
 *      `unmount` вызывается при успехе, ошибке и отмене, при недоступном
 *      монтировании работает прежний `writeFile`, а «Code=8» превращается
 *      в понятное сообщение про размер. Ядро ffmpeg здесь подменённое:
 *      настоящему в Node нужны Worker и DOM;
 *   8) запасная модель при временном сбое основной: 503/5xx, таймаут и сеть
 *      пробуют её; 401/402/413/неизвестная модель/отмена и `no_speech` — нет;
 *      обе упали — в ошибке причины обеих; в `costRub` только удачная попытка;
 *      совет провайдера «выберите другую модель» до человека не доходит.
 *   9) формат ответа — всегда `json` (не `verbose_json`, который Whisper Large
 *      V3 отвергает с 400): ответ `{"text":"..."}` без `duration` работает,
 *      `duration` используется, если пришёл, своя длительность берётся из
 *      метаданных видео и из `encodedSec` вырезания, неизвестная — `null`
 *      (стоимость неизвестна, а не 0 ₽).
 *      Полный сценарий GigaAM 503 → Whisper `{"text":"..."}` проверен целиком.
 *  10) длительность из файла: маленький файл без переданной длительности
 *      читается через подменённые метаданные; порядок «явно переданное →
 *      файл → encodedSec → неизвестно»; провал и таймаут чтения не ломают
 *      расшифровку; сумма считается по тарифу; неизвестная длительность даёт
 *      честный текст про неизвестную стоимость, а не «0 ₽».
 *
 * Чего здесь НЕТ: настоящего ffmpeg и настоящего polza.ai. Это проверка логики
 * сервиса, а не сквозная проверка распознавания. Настоящей загрузки 31 МБ из
 * браузера тут тоже нет — `fetch` подменён, проверяется наш разбор ответа.
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
  canTryFallbackModel,
  createTranscriptionService,
  describeModelFailures,
  extractAudioWithFfmpeg,
  isTemporaryTranscriptionFailure,
  retryExtractionWithCopy,
  type AudioExtractionDeps,
  type AudioExtractionJob,
} from '../src/video/TranscriptionService'
import type { FFmpeg } from '@ffmpeg/ffmpeg'
import {
  DEFAULT_MAX_UPLOAD_BYTES,
  DEFAULT_TRANSCRIPTION_SETTINGS,
  FFMPEG_LOG_LINE_LIMIT,
  FFMPEG_LOG_TAIL_LINES,
  LANGUAGE_CYRILLIC_MIN_SHARE,
  LANGUAGE_MIN_LETTERS,
  WORKER_FS_MOUNT_POINT,
  WORKER_FS_TYPE,
  buildCopyAudioArgs,
  buildExtractAudioArgs,
  buildExtractFailureMessage,
  canRetryExtractionWithCopy,
  countTextLetters,
  describeFfmpegFailure,
  describeTranscriptionCost,
  describeTranscriptionModel,
  detectTranscriptionLanguage,
  isMeaningfulFfmpegLine,
  looksLikeMemoryFailure,
  looksLikeUnreadableFileFailure,
  pickFfmpegReasonLines,
  planAudioInput,
  resolveTranscriptionSettings,
  shouldExtractAudio,
  transcriptionModelName,
  trimFfmpegLine,
  type TranscriptionSettings,
} from '../src/video/transcriptionConfig'
import {
  VIDEO_CORE_BASE_URL,
  VIDEO_CORE_MIRRORS,
  VIDEO_CORE_MIRROR_TIMEOUT_MS,
  VIDEO_CORE_SCRIPT,
  VIDEO_CORE_VERSION,
  VIDEO_CORE_WASM,
  coreDownloadRatio,
  coreFileUrls,
  describeCoreMirrorFailures,
  downloadCoreToBlobURL,
  loadCoreFromMirrors,
  mirrorName,
  shortCoreFailureReason,
} from '../src/video/config'
import {
  DEFAULT_METADATA_TIMEOUT_MS,
  readElementMetadata,
  type MetadataReader,
} from '../src/video/metadata'
import {
  TranscriptionError,
  type TranscriptionOutcome,
} from '../src/video/transcriptionTypes'

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

/**
 * Подменяет глобальный `fetch` на время проверки: `downloadCoreToBlobURL`
 * зовёт его напрямую, а не через зависимости сервиса. После проверки
 * настоящий `fetch` возвращается — им же читаются затем `blob:`-адреса.
 */
async function withFetch<T>(fake: typeof fetch, body: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = fake
  try {
    return await body()
  } finally {
    globalThis.fetch = original
  }
}

/**
 * Ответ с телом из кусков. `contentLength` может врать (или отсутствовать):
 * именно так ведут себя unpkg (заголовка нет) и jsdelivr (длина от сжатого тела).
 */
function coreResponse(options: {
  sizes: number[]
  contentLength?: number | null
  onChunk?: () => void
}): Response {
  const headers = new Headers({ 'Content-Type': 'application/octet-stream' })
  if (options.contentLength !== null && options.contentLength !== undefined) {
    headers.set('Content-Length', String(options.contentLength))
  }
  let index = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= options.sizes.length) {
        controller.close()
        return
      }
      options.onChunk?.()
      controller.enqueue(new Uint8Array(options.sizes[index]!))
      index += 1
    },
  })
  return new Response(body, { headers })
}

/** Байты и тип blob по `blob:`-адресу: настоящий `fetch` к этому моменту уже вернулся. */
async function blobOfURL(url: string): Promise<{ bytes: Uint8Array; type: string }> {
  const response = await fetch(url)
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    type: response.headers.get('content-type') ?? '',
  }
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

// --- Подменённый ffmpeg: проверка монтирования и запасного writeFile --------

interface FakeCoreCalls {
  created: string[]
  mounts: Array<{ fsType: string; files: File[]; mountPoint: string }>
  unmounts: string[]
  writes: Array<{ path: string; size: number }>
  execs: string[][]
  deletes: string[]
  reads: string[]
}

interface FakeCoreOptions {
  /** `missing` — у ядра нет mount/unmount; `false`/`throw` — монтирование не удалось. */
  mount?: 'ok' | 'missing' | 'false' | 'throw'
  /** Что делает exec: по умолчанию сразу возвращает 0. */
  exec?: (args: string[], signal: AbortSignal | undefined) => Promise<number>
  /** Код выхода, если свой exec не задан. */
  exitCode?: number
  /** Байты вырезанного звука. */
  output?: Uint8Array
}

/**
 * Ядро-обманка: запоминает вызовы и отвечает как ffmpeg.wasm.
 *
 * Настоящее ядро в Node не запускается (нужны Worker и DOM), но весь путь
 * «смонтировать / скопировать → exec → readFile → unmount» проверяется
 * именно здесь: важно, какие аргументы получил mount и снят ли он.
 */
function fakeCore(options: FakeCoreOptions = {}): { ffmpeg: FFmpeg; calls: FakeCoreCalls } {
  const calls: FakeCoreCalls = {
    created: [],
    mounts: [],
    unmounts: [],
    writes: [],
    execs: [],
    deletes: [],
    reads: [],
  }
  const mountMode = options.mount ?? 'ok'
  const core: Record<string, unknown> = {
    loaded: true,
    on: () => {},
    off: () => {},
    terminate: () => {},
    createDir: async (path: string): Promise<boolean> => {
      calls.created.push(path)
      return true
    },
    writeFile: async (path: string, data: Uint8Array): Promise<boolean> => {
      calls.writes.push({ path, size: data.byteLength })
      return true
    },
    exec: async (args: string[], _timeout?: number, execOptions?: { signal?: AbortSignal }): Promise<number> => {
      calls.execs.push(args)
      if (options.exec) return options.exec(args, execOptions?.signal)
      return options.exitCode ?? 0
    },
    readFile: async (path: string): Promise<Uint8Array> => {
      calls.reads.push(path)
      return options.output ?? new Uint8Array([1, 2, 3, 4])
    },
    deleteFile: async (path: string): Promise<boolean> => {
      calls.deletes.push(path)
      return true
    },
  }
  if (mountMode !== 'missing') {
    core.mount = async (
      fsType: string,
      mountOptions: { files?: File[] },
      mountPoint: string,
    ): Promise<boolean> => {
      if (mountMode === 'throw') throw new Error('WORKERFS mount failed')
      calls.mounts.push({ fsType, files: mountOptions.files ?? [], mountPoint })
      return mountMode !== 'false'
    }
    core.unmount = async (mountPoint: string): Promise<boolean> => {
      calls.unmounts.push(mountPoint)
      return true
    }
  }
  return { ffmpeg: core as unknown as FFmpeg, calls }
}

/** Вырезание с подменённым ядром: настоящий ffmpeg и его 31 МБ не нужны. */
async function extractWithFake(
  core: ReturnType<typeof fakeCore>,
  options: {
    size?: number
    name?: string
    mime?: string
    signal?: AbortSignal
    onProgress?: (stageProgress: number | null, message: string) => void
    readBlob?: (blob: Blob) => Promise<Uint8Array>
  } = {},
): Promise<{ audio?: Awaited<ReturnType<typeof extractAudioWithFfmpeg>>; error?: unknown }> {
  const deps: AudioExtractionDeps = {
    loadCore: async () => core.ffmpeg,
    readBlob:
      options.readBlob ??
      (async (blob: Blob) => {
        throw new Error(`readBlob не должен вызываться при монтировании (${blob.size} байт)`)
      }),
  }
  try {
    const audio = await extractAudioWithFfmpeg(
      {
        source: {
          blob: blobOf(options.size ?? 64 * 1024, options.mime ?? 'video/mp4'),
          mimeType: options.mime ?? 'video/mp4',
          name: options.name ?? 'reel.mp4',
          durationSec: 42,
        },
        settings: {
          ...DEFAULT_TRANSCRIPTION_SETTINGS,
          maxUploadBytes: 1024,
        },
        onProgress: options.onProgress,
        signal: options.signal,
      },
      deps,
    )
    return { audio }
  } catch (error) {
    return { error }
  }
}

/** Сервис с ключом, но без обращения к настоящей сети. */
function service(options: {
  fetch: typeof fetch
  extractAudio?: (job: AudioExtractionJob) => Promise<{ blob: Blob; mimeType: string; durationSec: number | null }>
  readMetadata?: MetadataReader
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
    deps: {
      fetch: options.fetch,
      extractAudio: options.extractAudio,
      readMetadata: options.readMetadata,
    },
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
    eq(
      DEFAULT_TRANSCRIPTION_SETTINGS.responseFormat,
      'json',
      'формат ответа по умолчанию — json: только его принимают все модели',
    )
    eq(DEFAULT_MAX_UPLOAD_BYTES, 15 * 1024 * 1024, 'лимит вынесен в конфиг')
    eq(
      DEFAULT_TRANSCRIPTION_SETTINGS.metadataTimeoutMs,
      DEFAULT_METADATA_TIMEOUT_MS,
      'таймаут метаданных — общий с модулем сжатия (10 с)',
    )
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

  // 1а. Ядро ffmpeg: не один CDN, а список зеркал с перебором.
  await test('зеркала ядра: список, первый — unpkg, база совпадает с первым', () => {
    ok(VIDEO_CORE_MIRRORS.length >= 2, 'зеркал не меньше двух — одного CDN мало')
    ok(String(VIDEO_CORE_MIRRORS[0]).includes('unpkg.com'), 'первое зеркало — unpkg, как раньше')
    ok(
      VIDEO_CORE_MIRRORS.some((mirror) => mirror.includes('jsdelivr.net')),
      'запасное зеркало — jsdelivr',
    )
    eq(VIDEO_CORE_BASE_URL, VIDEO_CORE_MIRRORS[0], 'VIDEO_CORE_BASE_URL оставлен равным первому зеркалу')
    ok(
      VIDEO_CORE_MIRRORS.every((mirror) => !mirror.endsWith('/')),
      'в зеркалах нет слэша на конце: адрес файла собирается как база + /файл',
    )
    ok(
      VIDEO_CORE_MIRRORS.every((mirror) => mirror.includes(VIDEO_CORE_VERSION)),
      'все зеркала — одной версии ядра',
    )
    eq(VIDEO_CORE_MIRROR_TIMEOUT_MS, 120_000, 'предел ожидания одного зеркала — 120 с')
  })

  await test('зеркала ядра: js и wasm — всегда с одного зеркала', () => {
    for (const mirror of VIDEO_CORE_MIRRORS) {
      const urls = coreFileUrls(mirror)
      eq(urls.script, `${mirror}/${VIDEO_CORE_SCRIPT}`, `${mirrorName(mirror)}: скрипт с этой же базы`)
      eq(urls.wasm, `${mirror}/${VIDEO_CORE_WASM}`, `${mirrorName(mirror)}: wasm с этой же базы`)
      ok(
        urls.script.startsWith(`${mirror}/`) && urls.wasm.startsWith(`${mirror}/`),
        `${mirrorName(mirror)}: версии js и wasm не смешиваются`,
      )
    }
    eq(
      coreFileUrls('https://example.test/ffmpeg-core').script,
      'https://example.test/ffmpeg-core/ffmpeg-core.js',
      'самохостинг: свой адрес работает так же',
    )
  })

  await test('полоса загрузки ядра: длина от CDN не обманывает', () => {
    eq(coreDownloadRatio({ total: 31_000_000, received: 15_500_000 }), 0.5, 'обычный случай: половина скачана')
    eq(coreDownloadRatio({ total: 31_000_000, received: 31_000_000 }), 1, 'скачано всё')
    eq(coreDownloadRatio({ total: -1, received: 4096 }), null, 'unpkg не отдаёт длину (chunked) — доля неизвестна')
    eq(
      coreDownloadRatio({ total: 9_289_992, received: 10_000_000 }),
      null,
      'jsdelivr отдаёт длину сжатого тела — доля тоже неизвестна, а не 100%',
    )
    eq(coreDownloadRatio({ total: 0, received: 0 }), null, 'пустой ответ не делит на ноль')
  })

  await test('имя зеркала для человека: хост, а не длинный адрес', () => {
    eq(mirrorName(VIDEO_CORE_MIRRORS[0]!), 'unpkg.com', 'у unpkg — короткий хост')
    eq(mirrorName(VIDEO_CORE_MIRRORS[1]!), 'cdn.jsdelivr.net', 'у jsdelivr — свой хост')
    eq(mirrorName('/ffmpeg-core'), '/ffmpeg-core', 'относительный путь самохостинга показывается как есть')
  })

  await test('перебор зеркал: первое сработало — дальше не идём', async () => {
    const tried: string[] = []
    const outcome = await loadCoreFromMirrors<string>({
      mirrors: VIDEO_CORE_MIRRORS,
      timeoutMs: 1_000,
      load: async (mirror) => {
        tried.push(mirror)
        return `ядро:${mirror}`
      },
    })
    ok(outcome.ok, 'ядро получено')
    if (outcome.ok) {
      eq(outcome.core, `ядро:${VIDEO_CORE_MIRRORS[0]}`, 'ядро взято с первого зеркала')
      eq(outcome.mirror, VIDEO_CORE_MIRRORS[0], 'видно, какое зеркало сработало')
    }
    eq(tried, [VIDEO_CORE_MIRRORS[0]], 'загрузчик вызван ровно один раз')
  })

  await test('перебор зеркал: первое упало — второе сработало, причина видна', async () => {
    const tried: string[] = []
    const fallbacks: string[] = []
    const outcome = await loadCoreFromMirrors<string>({
      mirrors: VIDEO_CORE_MIRRORS,
      timeoutMs: 1_000,
      onMirrorFailed: (failure, nextMirror) => {
        fallbacks.push(`${mirrorName(failure.mirror)}→${nextMirror === null ? 'нет' : mirrorName(nextMirror)}`)
      },
      load: async (mirror) => {
        tried.push(mirror)
        if (tried.length === 1) throw new Error('Failed to fetch')
        return 'ядро'
      },
    })
    ok(outcome.ok, 'падение первого зеркала не отменяет загрузку')
    if (outcome.ok) eq(outcome.mirror, VIDEO_CORE_MIRRORS[1], 'ядро взято со второго зеркала')
    eq(tried.length, 2, 'загрузчик вызван по разу на зеркало')
    eq(tried[1], VIDEO_CORE_MIRRORS[1], 'порядок перебора — как в списке')
    eq(
      fallbacks,
      [`${mirrorName(VIDEO_CORE_MIRRORS[0]!)}→${mirrorName(VIDEO_CORE_MIRRORS[1]!)}`],
      'о переходе сообщено с причиной и с адресом следующего',
    )
  })

  await test('перебор зеркал: упали все — причина от каждого в тексте', async () => {
    const outcome = await loadCoreFromMirrors<string>({
      mirrors: VIDEO_CORE_MIRRORS,
      timeoutMs: 1_000,
      load: async (mirror) => {
        throw new Error(`нет ответа от ${mirrorName(mirror)}`)
      },
    })
    ok(!outcome.ok, 'успеха нет')
    if (outcome.ok) return
    eq(outcome.aborted, false, 'это не отмена, а настоящий отказ')
    eq(outcome.failures.length, VIDEO_CORE_MIRRORS.length, 'причина записана по каждому зеркалу')
    const text = describeCoreMirrorFailures(outcome.failures)
    for (const mirror of VIDEO_CORE_MIRRORS) {
      ok(text.includes(mirrorName(mirror)), `в сообщении названо ${mirrorName(mirror)}`)
      ok(text.includes(`нет ответа от ${mirrorName(mirror)}`), `рядом с ${mirrorName(mirror)} — его причина`)
    }
    ok(text.includes('; '), 'причины разделены, а не слиты в одну фразу')
    ok(!text.includes('ядро не загрузилось'), 'вместо общей фразы — настоящие причины')
    eq(describeCoreMirrorFailures([]), 'причины не записаны', 'пустой список не ломает текст')
  })

  await test('перебор зеркал: отмена до старта — ни одного зеркала', async () => {
    const controller = new AbortController()
    controller.abort()
    let calls = 0
    const outcome = await loadCoreFromMirrors<string>({
      mirrors: VIDEO_CORE_MIRRORS,
      timeoutMs: 1_000,
      signal: controller.signal,
      load: async () => {
        calls += 1
        return 'ядро'
      },
    })
    ok(!outcome.ok && outcome.aborted, 'итог — отмена')
    eq(calls, 0, 'загрузчик не вызывался вообще')
  })

  await test('перебор зеркал: отмена во время попытки — без второго зеркала', async () => {
    const controller = new AbortController()
    const tried: string[] = []
    const pending = loadCoreFromMirrors<string>({
      mirrors: VIDEO_CORE_MIRRORS,
      timeoutMs: 30_000,
      signal: controller.signal,
      load: (mirror) =>
        new Promise<string>(() => {
          tried.push(mirror)
        }),
    })
    setTimeout(() => controller.abort(), 10)
    const outcome = await pending
    ok(!outcome.ok && outcome.aborted, 'итог — отмена, а не причины отказов')
    eq(tried, [VIDEO_CORE_MIRRORS[0]], 'второе зеркало после отмены не запускалось')
  })

  await test('перебор зеркал: отмена между зеркалами — следующее не стартует', async () => {
    const controller = new AbortController()
    const tried: string[] = []
    const outcome = await loadCoreFromMirrors<string>({
      mirrors: VIDEO_CORE_MIRRORS,
      timeoutMs: 1_000,
      signal: controller.signal,
      onMirrorFailed: () => controller.abort(),
      load: async (mirror) => {
        tried.push(mirror)
        throw new Error('нет связи')
      },
    })
    ok(!outcome.ok && outcome.aborted, 'отменили на переходе — итог «отменено»')
    eq(tried, [VIDEO_CORE_MIRRORS[0]], 'следующее зеркало не запускалось')
  })

  await test('перебор зеркал: AbortError из загрузчика — это отмена, а не отказ', async () => {
    let calls = 0
    const outcome = await loadCoreFromMirrors<string>({
      mirrors: VIDEO_CORE_MIRRORS,
      timeoutMs: 1_000,
      load: async () => {
        calls += 1
        throw new DOMException('aborted', 'AbortError')
      },
    })
    ok(!outcome.ok && outcome.aborted, 'отмена не превращается в «упали все зеркала»')
    eq(calls, 1, 'после отмены перебор остановлен')
  })

  await test('перебор зеркал: висящее зеркало не держит вечно', async () => {
    const tried: string[] = []
    const outcome = await loadCoreFromMirrors<string>({
      mirrors: VIDEO_CORE_MIRRORS,
      timeoutMs: 30,
      load: (mirror) => {
        tried.push(mirror)
        if (tried.length === 1) return new Promise<string>(() => {}) // висит и молчит
        return Promise.resolve('ядро')
      },
    })
    ok(outcome.ok, 'после таймаута сработало второе зеркало')
    eq(tried.length, 2, 'на висящем зеркале перебор не остановился')
  })

  await test('перебор зеркал: висят оба — вечный no-op, в причинах таймаут', async () => {
    const outcome = await loadCoreFromMirrors<string>({
      mirrors: VIDEO_CORE_MIRRORS,
      timeoutMs: 30,
      load: () => new Promise<string>(() => {}),
    })
    if (outcome.ok) {
      ok(false, 'ожидался отказ: оба зеркала висят')
      return
    }
    eq(outcome.failures.length, VIDEO_CORE_MIRRORS.length, 'таймаут записан по каждому зеркалу')
    ok(
      outcome.failures.every((failure) => failure.reason.includes('не ответило')),
      'причина — «не ответило», а не пустая строка',
    )
    ok(
      describeCoreMirrorFailures(outcome.failures).includes(mirrorName(VIDEO_CORE_MIRRORS[1]!)),
      'второе зеркало тоже названо',
    )
  })

  await test('короткая причина отказа: текст ошибки, а не стек и не простыня', () => {
    eq(
      shortCoreFailureReason(new Error('  Failed   to fetch ')),
      'Failed to fetch',
      'текст ошибки сжат в строку',
    )
    eq(shortCoreFailureReason('таймаут сети'), 'таймаут сети', 'строка принимается как есть')
    eq(
      shortCoreFailureReason({ message: 'NetworkError when attempting to fetch resource.' }),
      'NetworkError when attempting to fetch resource.',
      'объект с message тоже понятен',
    )
    eq(shortCoreFailureReason(undefined), 'причина не сообщена', 'пустая ошибка не даёт пустую причину')
    ok(shortCoreFailureReason(new Error('x'.repeat(500))).length <= 161, 'длинная причина обрезана')
    ok(shortCoreFailureReason(new Error('x'.repeat(500))).endsWith('…'), 'обрезка помечена многоточием')
  })

  // 1б. Своё скачивание ядра вместо `toBlobURL` с прогрессом.
  //
  // `downloadCoreToBlobURL` зовёт глобальный `fetch` напрямую, поэтому здесь
  // он и подменяется — в отличие от тестов сервиса, куда `fetch` передаётся
  // через зависимости.
  await test('скачивание ядра: тело читается один раз, короткий Content-Length не ошибка', async () => {
    let enqueued = 0
    const events: Array<{ total: number; received: number; done: boolean }> = []
    // Главный случай: jsdelivr отдаёт длину СЖАТОГО тела (4), а распакованного
    // приходит 31 — раньше на этом падала `downloadWithProgress`.
    const { fn, calls } = makeFetch(() =>
      coreResponse({
        sizes: [10, 12, 9],
        contentLength: 4,
        onChunk: () => {
          enqueued += 1
        },
      }),
    )
    const url = await withFetch(fn, () =>
      downloadCoreToBlobURL('https://cdn.jsdelivr.net/core.wasm', 'application/wasm', {
        onProgress: (event) => events.push({ ...event }),
      }),
    )

    eq(calls.length, 1, 'ровно один запрос: тело не читается второй раз')
    eq(enqueued, 3, 'тело прочитано по кускам ровно один раз')
    eq(events[0]?.total, 4, 'длина из заголовка отдана как есть — она от сжатого тела')
    eq(events[events.length - 1]?.received, 31, 'дошло до конца: 31 байт')
    eq(events[events.length - 1]?.done, true, 'последнее событие — «дочитано»')
    ok(
      events.every((event, index) => index === 0 || event.received >= events[index - 1]!.received),
      'прогресс монотонный',
    )
    eq(coreDownloadRatio({ total: 4, received: 31 }), null, 'расхождение длины — прогресс без доли, а не ошибка')

    const blob = await blobOfURL(url)
    eq(blob.bytes.byteLength, 31, 'вернулся blob ровно с полученными байтами')
    eq(blob.type, 'application/wasm', 'mime был передан в blob как есть')
    URL.revokeObjectURL(url)
  })

  await test('скачивание ядра: без Content-Length — байты есть, доли нет', async () => {
    const events: Array<{ total: number; received: number; done: boolean }> = []
    const { fn } = makeFetch(() => coreResponse({ sizes: [5, 7], contentLength: null }))
    const url = await withFetch(fn, () =>
      downloadCoreToBlobURL('https://unpkg.com/core.wasm', 'application/wasm', {
        onProgress: (event) => events.push({ ...event }),
      }),
    )

    eq(
      events.map((event) => event.total),
      [-1, -1, -1],
      'unpkg не отдаёт длину: total = -1 на всех событиях',
    )
    eq(
      events.map((event) => event.received),
      [5, 12, 12],
      'байты растут, в конце — все 12',
    )
    eq(events[2]?.done, true, 'конец отмечен')
    ok(
      events.every((event) => coreDownloadRatio(event) === null),
      'при неизвестной длине доли нет, но байты есть',
    )

    const blob = await blobOfURL(url)
    eq(blob.bytes.byteLength, 12, 'байты собраны полностью')
    URL.revokeObjectURL(url)
  })

  await test('скачивание ядра: без потока тело читается arrayBuffer', async () => {
    const events: Array<{ total: number; received: number; done: boolean }> = []
    let arrayBufferCalls = 0
    const fake = {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      body: null,
      arrayBuffer: async (): Promise<ArrayBuffer> => {
        arrayBufferCalls += 1
        return new Uint8Array([1, 2, 3, 4]).buffer
      },
    } as unknown as Response
    const { fn, calls } = makeFetch(() => fake)
    const url = await withFetch(fn, () =>
      downloadCoreToBlobURL('https://unpkg.com/core.js', 'text/javascript', {
        onProgress: (event) => events.push({ ...event }),
      }),
    )

    eq(calls.length, 1, 'запрос один')
    eq(arrayBufferCalls, 1, 'тело прочитано arrayBuffer ровно один раз')
    eq(events, [{ total: 4, received: 4, done: true }], 'прогресс сообщает о 4 байтах')
    const blob = await blobOfURL(url)
    eq([...blob.bytes], [1, 2, 3, 4], 'байты на месте')
    eq(blob.type, 'text/javascript', 'mime скрипта сохранён')
    URL.revokeObjectURL(url)
  })

  await test('скачивание ядра: не-2xx — ошибка с кодом ответа', async () => {
    for (const status of [404, 500]) {
      let reads = 0
      const fake = {
        ok: false,
        status,
        statusText: status === 404 ? 'Not Found' : 'Internal Server Error',
        headers: new Headers(),
        body: null,
        arrayBuffer: async (): Promise<ArrayBuffer> => {
          reads += 1
          return new ArrayBuffer(0)
        },
      } as unknown as Response
      const { fn } = makeFetch(() => fake)
      let message = ''
      try {
        await withFetch(fn, () => downloadCoreToBlobURL('https://cdn.test/core.js', 'text/javascript'))
      } catch (error) {
        message = error instanceof Error ? error.message : String(error)
      }
      ok(message.includes(String(status)), `${status}: код ответа назван`)
      ok(message.includes('ядро ffmpeg'), `${status}: понятно, что не скачалось именно ядро`)
      eq(reads, 0, `${status}: тело отказа не читается`)
    }
  })

  await test('скачивание ядра: отмена во время чтения обрывает загрузку', async () => {
    const controller = new AbortController()
    const total = 500
    let enqueued = 0
    let pullsAfterAbort = 0
    let aborted = false
    const body = new ReadableStream<Uint8Array>({
      pull(streamController) {
        if (aborted) pullsAfterAbort += 1
        enqueued += 1
        streamController.enqueue(new Uint8Array(1024))
      },
    })
    const { fn } = makeFetch(() => new Response(body))
    let error: unknown = null
    try {
      await withFetch(fn, () =>
        downloadCoreToBlobURL('https://cdn.test/core.wasm', 'application/wasm', {
          signal: controller.signal,
          onProgress: () => {
            if (enqueued >= 3 && !aborted) {
              aborted = true
              controller.abort()
            }
          },
        }),
      )
    } catch (caught) {
      error = caught
    }

    ok(error !== null, 'отмена прервала скачивание, а не дождалась всех кусков')
    eq(error instanceof Error ? error.name : '', 'AbortError', 'отмена узнаётся по имени ошибки')
    ok(enqueued < total, 'после отмены загрузка не досчитана до конца')
    const snapshot = pullsAfterAbort
    await new Promise((resolve) => setTimeout(resolve, 20))
    eq(pullsAfterAbort, snapshot, 'после отмены новые куски не читаются')
  })

  await test('скачивание ядра: сигнал уходит в fetch, отмена fetch — это отмена', async () => {
    const controller = new AbortController()
    const { fn, calls } = makeFetch(() => {
      throw new DOMException('The operation was aborted.', 'AbortError')
    })
    let error: unknown = null
    try {
      await withFetch(fn, () =>
        downloadCoreToBlobURL('https://cdn.test/core.wasm', 'application/wasm', {
          signal: controller.signal,
        }),
      )
    } catch (caught) {
      error = caught
    }

    eq(calls.length, 1, 'запрос ушёл')
    eq(calls[0]?.init.signal, controller.signal, 'сигнал отмены передан в fetch')
    eq(error instanceof Error ? error.name : '', 'AbortError', 'отмена fetch не превратилась в «отказ сети»')
  })

  await test('скачивание ядра: сетевой сбой — понятная причина без кода', async () => {
    const { fn } = makeFetch(() => {
      throw new TypeError('Failed to fetch')
    })
    let message = ''
    try {
      await withFetch(fn, () => downloadCoreToBlobURL('https://cdn.test/core.wasm', 'application/wasm'))
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    ok(message.includes('не удалось скачать ядро ffmpeg'), 'сказано, что не скачалось именно ядро')
    ok(message.includes('Failed to fetch'), 'причина от браузера видна, а не потеряна')
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
    eq(form.get('response_format'), 'json', 'response_format = json: его принимают все модели')
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
    const c = await service({
      fetch: third.fn,
      readMetadata: async () => null,
    }).transcribe({
      source: { blob: blobOf(2048), mimeType: 'video/mp4' },
    })
    ok(
      c.ok && c.result.durationSec === null && c.result.costRub === null,
      'совсем неизвестно — длительность и стоимость неизвестны, а не 0',
    )
  })

  // Формат ответа `json`: провайдер присылает только `text`, а
  // длительность для стоимости берётся из своих данных. `verbose_json` не
  // просим: Whisper Large V3 отвечает на него 400, и запасная модель падала
  // всегда — именно на этом сломался живой сценарий пользователя.
  await test('json без duration: текст есть, стоимость — по своей длительности', async () => {
    const { fn, calls } = makeFetch(() => json({ text: 'Текст без длительности.' }))
    const outcome = await service({ fetch: fn }).transcribe({ source: SMALL })
    ok(outcome.ok, 'ответ с одним полем text — достаточный')
    if (!outcome.ok) return
    eq(calls.length, 1, 'ровно один запрос')
    eq(formOf(calls[0]!).get('response_format'), 'json', 'в запросе именно json')
    eq(outcome.result.text, 'Текст без длительности.', 'текст прочитан из поля text')
    eq(outcome.result.durationSec, 5.5, 'длительность — из метаданных видео (durationSec)')
    eq(
      outcome.result.costRub.toFixed(6),
      '0.022157',
      '5,5 с по тарифу GigaAM — 0,022157 ₽, стоимость не поехала',
    )
  })

  await test('json с duration: необязательное поле используем, если оно есть', async () => {
    const { fn } = makeFetch(() => json({ text: 'Есть', duration: 12.5 }))
    const outcome = await service({ fetch: fn }).transcribe({ source: SMALL })
    ok(outcome.ok, 'текст получен')
    if (!outcome.ok) return
    eq(outcome.result.durationSec, 12.5, 'duration из ответа точнее своего значения')
    eq(
      outcome.result.costRub.toFixed(6),
      '0.050356',
      '12,5 с по тарифу GigaAM — 0,050356 ₽',
    )
  })

  await test('json без duration и без своей длительности: стоимость неизвестна, а не 0', async () => {
    const { fn } = makeFetch(() => json({ text: 'Есть' }))
    const outcome = await service({ fetch: fn, readMetadata: async () => null }).transcribe({
      source: { blob: blobOf(2048), mimeType: 'video/mp4' },
    })
    ok(outcome.ok, 'текст получен даже без длительности')
    if (!outcome.ok) return
    eq(outcome.result.durationSec, null, 'длительность неизвестна — null, а не 0')
    eq(outcome.result.costRub, null, 'стоимость неизвестна — null, а не выдуманный ноль')
    const text = describeTranscriptionCost(outcome.result.costRub)
    ok(text.includes('неизвестна'), 'человеку сказано, что стоимость неизвестна')
    ok(!text.includes('0.0000'), 'ноль не показан как факт')
  })

  await test('вырезанный звук: длительность — encodedSec, стоимость по ней', async () => {
    const { fn } = makeFetch(() => json({ text: 'Звук без duration в ответе.' }))
    const fake = fakeExtractor(1024, 42)
    const outcome = await service({
      fetch: fn,
      extractAudio: fake.extractor,
      readMetadata: async () => null,
      settings: { maxUploadBytes: 4096 },
    }).transcribe({ source: { blob: blobOf(64 * 1024), mimeType: 'video/mp4', name: 'long.mp4' } })
    ok(outcome.ok, 'звук вырезан и расшифрован')
    if (!outcome.ok) return
    eq(outcome.result.durationSec, 42, 'длительность — encodedSec из вырезания звука')
    eq(
      outcome.result.costRub?.toFixed(6),
      '0.169197',
      '42 с по тарифу GigaAM — 0,169197 ₽',
    )
  })

  // 2в. Длительность из файла: без неё маленький файл давал 0 ₽ за реальный
  // запрос. Метаданные читаются только тогда, когда вызывающий код
  // длительность не передал, и любой сбой чтения не мешает расшифровке.
  await test('маленький файл без длительности: читаем её из файла, стоимость не ноль', async () => {
    const reads: Array<{ size: number; timeoutMs: number }> = []
    const { fn, calls } = makeFetch(() => json({ text: 'Текст без duration в ответе.' }))
    const outcome = await service({
      fetch: fn,
      readMetadata: async (blob, timeoutMs) => {
        reads.push({ size: blob.size, timeoutMs })
        return { width: 1280, height: 720, durationSec: 60 }
      },
    }).transcribe({
      source: { blob: blobOf(2048), mimeType: 'video/mp4', name: 'small.mp4' },
    })

    ok(outcome.ok, 'расшифровка прошла')
    if (!outcome.ok) return
    eq(reads.length, 1, 'метаданные прочитаны ровно один раз')
    eq(reads[0]?.size, 2048, 'читали именно отправляемый файл')
    eq(reads[0]?.timeoutMs, DEFAULT_METADATA_TIMEOUT_MS, 'таймаут чтения — общий, 10 с')
    eq(outcome.result.durationSec, 60, 'длительность прочитана из файла')
    eq(
      outcome.result.costRub?.toFixed(6),
      '0.241710',
      '60 с × 0,24171 ₽/мин = 0,241710 ₽',
    )
    ok((outcome.result.costRub ?? 0) > 0, 'стоимость не ноль там, где длительность есть')
    eq(calls.length, 1, 'маленький файл ушёл напрямую, без вырезания')
  })

  await test('явно переданная длительность сильнее чтения из файла', async () => {
    let reads = 0
    const { fn } = makeFetch(() => json({ text: 'Текст без duration в ответе.' }))
    const outcome = await service({
      fetch: fn,
      readMetadata: async () => {
        reads += 1
        return { width: null, height: null, durationSec: 60 }
      },
    }).transcribe({
      source: { blob: blobOf(2048), mimeType: 'video/mp4', durationSec: 90 },
    })

    ok(outcome.ok, 'расшифровка прошла')
    if (!outcome.ok) return
    eq(reads, 0, 'файл не читали: вызывающий код уже назвал длительность')
    eq(outcome.result.durationSec, 90, 'приоритет у явно переданной длительности')
    eq(
      outcome.result.costRub?.toFixed(6),
      '0.362565',
      '90 с × 0,24171 ₽/мин = 0,362565 ₽',
    )
  })

  await test('длительность из файла сильнее encodedSec вырезания', async () => {
    const { fn } = makeFetch(() => json({ text: 'Звук.' }))
    // Вырезание «не дошло до конца» и назвало 42 с — файл знает настоящие 60.
    const fake = fakeExtractor(1024, 42)
    const outcome = await service({
      fetch: fn,
      extractAudio: fake.extractor,
      readMetadata: async () => ({ width: null, height: null, durationSec: 60 }),
      settings: { maxUploadBytes: 4096 },
    }).transcribe({ source: { blob: blobOf(64 * 1024), mimeType: 'video/mp4', name: 'long.mp4' } })

    ok(outcome.ok, 'звук вырезан и расшифрован')
    if (!outcome.ok) return
    eq(fake.jobs[0]?.source.durationSec, 60, 'вырезанию тоже передана длительность из файла')
    eq(outcome.result.durationSec, 60, 'файл точнее вырезания: 60 с, а не 42')
    eq(outcome.result.costRub?.toFixed(6), '0.241710', '60 с по тарифу — 0,241710 ₽')
  })

  await test('провал чтения метаданных не ломает расшифровку', async () => {
    const { fn, calls } = makeFetch(() => json({ text: 'Текст есть.' }))
    const outcome = await service({
      fetch: fn,
      readMetadata: async () => {
        throw new Error('metadata error')
      },
    }).transcribe({
      source: { blob: blobOf(2048), mimeType: 'video/mp4' },
    })

    ok(outcome.ok, 'расшифровка прошла, хотя метаданные не прочитались')
    if (!outcome.ok) return
    eq(calls.length, 1, 'запрос всё равно ушёл')
    eq(outcome.result.text, 'Текст есть.', 'текст получен')
    eq(outcome.result.durationSec, null, 'длительность неизвестна')
    eq(outcome.result.costRub, null, 'стоимость неизвестна, а не 0')
  })

  await test('таймаут чтения метаданных не ломает расшифровку', async () => {
    const { fn } = makeFetch(() => json({ text: 'Текст есть.' }))
    const startedAt = Date.now()
    const outcome = await service({
      fetch: fn,
      // Чтение, которое никогда не ответит: расшифровку должен спасти свой предел.
      readMetadata: () => new Promise(() => {}),
      settings: { metadataTimeoutMs: 20 },
    }).transcribe({
      source: { blob: blobOf(2048), mimeType: 'video/mp4' },
    })
    const elapsed = Date.now() - startedAt

    ok(outcome.ok, 'расшифровка прошла после таймаута чтения')
    if (!outcome.ok) return
    eq(outcome.result.durationSec, null, 'длительность неизвестна')
    eq(outcome.result.costRub, null, 'стоимость неизвестна, а не 0')
    ok(elapsed < 2_000, `ждём не дольше своего таймаута (${elapsed} мс)`)
  })

  await test('неизвестная стоимость: честная подпись, а не «0 ₽»', () => {
    const unknown = describeTranscriptionCost(null)
    ok(unknown.includes('Стоимость неизвестна'), 'сказано «стоимость неизвестна»')
    ok(!unknown.includes('0.0000'), 'ноль не показан как факт')
    eq(
      describeTranscriptionCost(0.022157),
      'Стоимость: 0.0222 ₽.',
      'известная сумма показана как раньше',
    )
    ok(
      describeTranscriptionCost(Number.NaN).includes('неизвестна'),
      'нечисловая стоимость — тоже неизвестность',
    )
  })

  await test('чтение метаданных без DOM: null, а не исключение', async () => {
    // Настоящий браузерный путь здесь не проверить (нет `<video>`); важно,
    // что отсутствие DOM не ломает вызывающий код и не подвешивает его.
    const info = await readElementMetadata(blobOf(16), 10)
    eq(info, null, 'без DOM метаданные — null')
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
    eq(outcome.result.fallbackReason, null, 'запасная модель не срабатывала')
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
    eq(outcome.result.fallbackReason, 'language', 'причина — язык записи, а не сбой модели')
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

  // 10. Крупный файл: WORKERFS вместо копии в кучу wasm.
  await test('входной файл: монтирование сохраняет имя и настоящее расширение', () => {
    eq(WORKER_FS_TYPE, 'WORKERFS', 'монтируем именно WORKERFS')
    eq(WORKER_FS_MOUNT_POINT, '/mnt', 'точка монтирования — /mnt')
    const mp4 = planAudioInput('muza-input.mp4', true)
    eq(mp4.mode, 'mount', 'при доступном mount — монтирование')
    eq(mp4.fileName, 'muza-input.mp4', 'имя файла с расширением')
    eq(mp4.inputPath, '/mnt/muza-input.mp4', 'входной путь — внутри /mnt')
    eq(mp4.mountPoint, '/mnt', 'точка монтирования известна для unmount')
    eq(planAudioInput('muza-input.webm', true).inputPath, '/mnt/muza-input.webm', 'расширение webm сохранено')
    eq(planAudioInput('muza-input.mov', true).inputPath, '/mnt/muza-input.mov', 'расширение mov сохранено')
    const copy = planAudioInput('muza-input.mp4', false)
    eq(copy.mode, 'copy', 'без mount — прежний writeFile')
    eq(copy.inputPath, 'muza-input.mp4', 'при копировании имя без /mnt')
    ok(looksLikeUnreadableFileFailure('File could not be read! Code=8'), 'Code=8 распознан')
    ok(looksLikeUnreadableFileFailure('NotReadableError: The requested file could not be read'), 'NotReadableError распознан')
    ok(!looksLikeUnreadableFileFailure('moov atom not found'), 'битый контейнер — не про чтение файла')
  })

  await test('крупный файл: WORKERFS смонтирован, writeFile и чтение в память не вызывались', async () => {
    const core = fakeCore()
    let readBlobCalls = 0
    const { audio, error } = await extractWithFake(core, {
      size: 64 * 1024,
      name: 'reel.webm',
      mime: 'video/webm',
      readBlob: async () => {
        readBlobCalls += 1
        return new Uint8Array([9])
      },
    })

    ok(error === undefined, 'вырезание прошло без ошибки')
    eq(core.calls.created, ['/mnt'], 'каталог монтирования создан')
    eq(core.calls.mounts.length, 1, 'mount вызван один раз')
    const mount = core.calls.mounts[0]!
    eq(mount.fsType, WORKER_FS_TYPE, 'fsType — WORKERFS')
    eq(mount.mountPoint, '/mnt', 'монтируем в /mnt')
    eq(mount.files.length, 1, 'смонтирован ровно один файл')
    ok(mount.files[0] instanceof File, 'WORKERFS получает File с именем, а не безымянный Blob')
    eq(mount.files[0]?.name, 'muza-input.webm', 'имя файла — с настоящим расширением')
    eq(core.calls.writes.length, 0, 'writeFile не вызывался: копии в кучу нет')
    eq(readBlobCalls, 0, 'Blob не читался в память')
    eq(
      core.calls.execs[0],
      buildExtractAudioArgs('/mnt/muza-input.webm', 'muza-audio.m4a', {
        ...DEFAULT_TRANSCRIPTION_SETTINGS,
        maxUploadBytes: 1024,
      }),
      'аргументы прежние, отличается только путь входа',
    )
    eq(core.calls.execs[0]?.[3], '/mnt/muza-input.webm', 'ffmpeg получил путь с расширением')
    eq(core.calls.unmounts, ['/mnt'], 'unmount вызван при успехе')
    ok(core.calls.deletes.includes('/mnt/muza-input.webm'), 'входной файл удалён после снятия монтирования')
    ok(core.calls.deletes.includes('muza-audio.m4a'), 'выходной файл удалён')
    eq(audio?.blob.size, 4, 'результат — прочитанные байты звука')
    eq(audio?.mimeType, 'audio/mp4', 'тип результата не изменился')
  })

  await test('unmount вызывается и при сбое ffmpeg, и при отмене', async () => {
    const failed = fakeCore({
      exec: async () => {
        throw new Error('moov atom not found')
      },
    })
    const failedRun = await extractWithFake(failed, { size: 64 * 1024 })
    ok(failedRun.error !== undefined, 'сбой ffmpeg вернулся ошибкой')
    eq(failed.calls.unmounts, ['/mnt'], 'unmount при сбое ffmpeg')
    ok(
      String((failedRun.error as Error)?.message).includes('moov atom not found'),
      'причина ffmpeg не потеряна',
    )

    const controller = new AbortController()
    const aborted = fakeCore({
      exec: async () => {
        controller.abort()
        return 0
      },
    })
    const abortedRun = await extractWithFake(aborted, { size: 64 * 1024, signal: controller.signal })
    eq((abortedRun.error as { code?: string })?.code, 'aborted', 'отмена вернулась кодом aborted')
    eq(aborted.calls.unmounts, ['/mnt'], 'unmount при отмене')
  })

  await test('нет WORKERFS или mount упал: работает прежний writeFile', async () => {
    const noMount = fakeCore({ mount: 'missing' })
    const noMountRun = await extractWithFake(noMount, {
      size: 4096,
      name: 'clip.mov',
      mime: 'video/quicktime',
      readBlob: async () => new Uint8Array([1, 2]),
    })
    ok(noMountRun.error === undefined, 'без mount вырезание всё равно работает')
    eq(noMount.calls.mounts.length, 0, 'mount не вызывался: его нет у ядра')
    eq(noMount.calls.writes.length, 1, 'пошёл запасной writeFile')
    eq(noMount.calls.writes[0]?.path, 'muza-input.mov', 'путь копии — имя с расширением')
    eq(noMount.calls.execs[0]?.[3], 'muza-input.mov', 'ffmpeg получил имя копии')
    eq(noMount.calls.unmounts, [], 'снимать нечего — монтирования не было')

    const refused = fakeCore({ mount: 'false' })
    const refusedRun = await extractWithFake(refused, {
      size: 4096,
      readBlob: async () => new Uint8Array([1, 2]),
    })
    ok(refusedRun.error === undefined, 'mount=false — не приговор, работает копия')
    eq(refused.calls.writes[0]?.path, 'muza-input.mp4', 'после mount=false — writeFile')
    eq(refused.calls.unmounts, [], 'mount=false: unmount не нужен')

    const thrown = fakeCore({ mount: 'throw' })
    const thrownRun = await extractWithFake(thrown, {
      size: 4096,
      readBlob: async () => new Uint8Array([1, 2]),
    })
    ok(thrownRun.error === undefined, 'исключение mount не ломает вырезание')
    eq(thrown.calls.writes[0]?.path, 'muza-input.mp4', 'после исключения mount — writeFile')
    eq(thrown.calls.unmounts, [], 'монтирование не состоялось — unmount не вызывается')
  })

  await test('файл не прочитался: понятное сообщение про размер, без Code=8', async () => {
    const core = fakeCore({
      exec: async () => {
        throw new Error('File could not be read! Code=8')
      },
    })
    const run = await extractWithFake(core, { size: 64 * 1024 })
    const message = String((run.error as Error)?.message ?? '')
    ok(message.includes('слишком большое'), 'сказано, что видео слишком большое')
    ok(message.includes('нужен сервер'), 'подсказан сервер как выход')
    ok(!/code=8/i.test(message), 'технического Code=8 в сообщении нет')
    ok(message.includes('Оригинал не тронут'), 'оригинал не тронут')
    eq((run.error as { code?: string })?.code, 'extract_failed', 'код ошибки прежний')
    eq(core.calls.unmounts, ['/mnt'], 'unmount вызван и при непрочитанном файле')

    const noMount = fakeCore({ mount: 'missing' })
    const copyFailed = await extractWithFake(noMount, {
      size: 512,
      readBlob: async () => {
        throw new Error('File could not be read! Code=8')
      },
    })
    const copyMessage = String((copyFailed.error as Error)?.message ?? '')
    ok(copyMessage.includes('Не удалось прочитать файл'), 'маленький файл: сообщение про чтение файла')
    ok(!/code=8/i.test(copyMessage), 'и здесь без Code=8')
  })

  // 11. Запасная модель при временном сбое основной.
  await test('решение о запасной модели: временные сбои — да, постоянные — нет', () => {
    const failure = (
      code: TranscriptionError['code'],
      options: { status?: number | null; retriable?: boolean } = {},
    ): TranscriptionError =>
      new TranscriptionError(code, 'причина', {
        status: options.status ?? null,
        retriable: options.retriable ?? false,
      })
    const primary = 'ai-sage/gigaam-v3'
    const fallback = 'openai/whisper-large-v3'

    ok(isTemporaryTranscriptionFailure(failure('server', { status: 500, retriable: true })), '500 — временный сбой')
    ok(isTemporaryTranscriptionFailure(failure('server', { status: 503, retriable: true })), '503 — временный: все провайдеры модели упали')
    ok(isTemporaryTranscriptionFailure(failure('timeout', { retriable: true })), 'таймаут — временный')
    ok(isTemporaryTranscriptionFailure(failure('timeout', { status: 408, retriable: true })), '408 — тоже таймаут')
    ok(isTemporaryTranscriptionFailure(failure('network', { retriable: true })), 'сетевой сбой — временный')

    const permanent: Array<[string, TranscriptionError]> = [
      ['401', failure('auth', { status: 401 })],
      ['403', failure('auth', { status: 403 })],
      ['402', failure('budget', { status: 402 })],
      ['413', failure('too_large', { status: 413 })],
      ['неизвестная модель', failure('http', { status: 404 })],
      ['отмена', failure('aborted')],
      ['нет речи', failure('no_speech')],
      ['429', failure('rate_limit', { status: 429, retriable: true })],
    ]
    for (const [name, error] of permanent) {
      ok(!isTemporaryTranscriptionFailure(error), `${name} — постоянный сбой`)
      ok(!canTryFallbackModel(error, primary, fallback), `${name}: запасная модель не пробуется`)
    }
    ok(
      canTryFallbackModel(failure('server', { status: 503, retriable: true }), primary, fallback),
      '503 и разные модели — запасная пробуется',
    )
    ok(
      !canTryFallbackModel(failure('server', { status: 503, retriable: true }), primary, primary),
      'модели совпали — второй попытки нет',
    )
  })

  await test('обе модели упали: в ошибке причины каждой', () => {
    const primary = new TranscriptionError('server', 'Сервис распознавания недоступен (503).', {
      status: 503,
      retriable: true,
      detail: 'Все провайдеры модели `ai-sage/gigaam-v3` вернули ошибку',
    })
    const fallback = new TranscriptionError('timeout', 'Не ответил.', { retriable: true })
    const text = describeModelFailures(
      { model: 'ai-sage/gigaam-v3', error: primary },
      { model: 'openai/whisper-large-v3', error: fallback },
    )

    ok(text.includes('русская модель'), 'названа основная модель')
    ok(text.includes('общая модель'), 'названа запасная модель')
    ok(text.includes('503'), 'виден код основной ошибки')
    ok(text.includes('Все провайдеры модели'), 'видна причина от провайдера, а не только код')
    ok(text.includes('не ответил'), 'видна причина запасной')
    ok(!text.includes('выберите другую модель'), 'не предлагаем выбор модели')
    ok(text.includes('попробуйте снова'), 'человеку сказано, что делать')
  })

  await test('подпись модели при сбое основной: не врём про язык', () => {
    eq(transcriptionModelName('ai-sage/gigaam-v3'), 'русская модель', 'GigaAM — русская модель')
    eq(transcriptionModelName('openai/whisper-large-v3'), 'общая модель', 'Whisper — общая модель')
    eq(transcriptionModelName(''), 'модель распознавания', 'пустое имя не ломает подпись')

    const label = describeTranscriptionModel('openai/whisper-large-v3', 'ru', true, 'provider')
    ok(label.includes('запасн'), 'сказано, что сработала запасная модель')
    ok(label.includes('общая модель'), 'модель названа по-человечески')
    ok(!label.includes('не на русском'), 'русская речь не названа нерусской')
    eq(
      describeTranscriptionModel('openai/whisper-large-v3', 'other', true),
      'Распознано: общая модель — речь не на русском.',
      'языковая замена подписана как раньше',
    )
  })

  await test('503 на основной: запасная отвечает — её текст и её стоимость', async () => {
    const providerText =
      'Все провайдеры модели `ai-sage/gigaam-v3` вернули ошибку. ' +
      'Повторите запрос позже или выберите другую модель.'
    const { fn, calls } = makeFetch((_call, index) =>
      index === 0
        ? json({ error: { message: providerText } }, 503)
        : transcribeResponse('Привет, это текст запасной модели.', 60),
    )
    const outcome = await service({ fetch: fn }).transcribe({ source: SMALL })

    eq(calls.length, 2, 'две попытки: основная, затем запасная')
    eq(formOf(calls[0]!).get('model'), 'ai-sage/gigaam-v3', 'первый запрос — основная модель')
    eq(formOf(calls[1]!).get('model'), 'openai/whisper-large-v3', 'второй запрос — запасная модель')
    ok(outcome.ok, 'человек получает текст, а не отказ')
    if (!outcome.ok) return
    eq(outcome.result.text, 'Привет, это текст запасной модели.', 'взят текст запасной модели')
    eq(outcome.result.model, 'openai/whisper-large-v3', 'видно, что сработала запасная')
    eq(outcome.result.usedFallback, true, 'вторая попытка отмечена')
    eq(outcome.result.fallbackReason, 'provider', 'причина — сбой основной, а не язык')
    eq(outcome.result.language, 'ru', 'русская речь остаётся русской')
    ok(
      Math.abs(outcome.result.costRub - 0.108) < 1e-12,
      'в стоимости только удачная попытка: 0,108 ₽, а не сумма с неудачной',
    )
    ok(
      outcome.result.costRub < (0.24171 + 0.108),
      'за отказ основной модели ничего не начислено',
    )
    ok(
      outcome.result.note !== null &&
        outcome.result.note.includes('Основная модель не ответила'),
      'примечание объясняет, почему сработала запасная',
    )
    ok(String(outcome.result.note).includes('только за удачную'), 'примечание честно говорит про деньги')
    ok(
      !String(outcome.result.note).includes('выберите другую модель'),
      'в примечании нет совета выбрать модель',
    )
  })

  // Живой сценарий пользователя целиком: GigaAM ответила 503, сработала
  // Whisper Large V3, а та принимает только `json` — раньше на `verbose_json`
  // она отвечала 400, и запасная модель не доходила до конца никогда.
  await test('сценарий: GigaAM 503 → Whisper только с text → расшифровка доведена', async () => {
    const { fn, calls } = makeFetch((_call, index) =>
      index === 0
        ? json(
            {
              error: {
                message:
                  'Все провайдеры модели `ai-sage/gigaam-v3` вернули ошибку. ' +
                  'Повторите запрос позже или выберите другую модель.',
              },
            },
            503,
          )
        : json({ text: 'Привет, это текст запасной модели.' }),
    )
    const outcome = await service({ fetch: fn }).transcribe({ source: SMALL })

    eq(calls.length, 2, 'две попытки: основная и запасная')
    eq(formOf(calls[0]!).get('response_format'), 'json', 'основная просит json')
    eq(
      formOf(calls[1]!).get('response_format'),
      'json',
      'запасная тоже просит json: verbose_json она бы отвергла',
    )
    ok(outcome.ok, 'запасная модель дошла до конца, а не упала на формате')
    if (!outcome.ok) return
    eq(outcome.result.text, 'Привет, это текст запасной модели.', 'взят текст запасной модели')
    eq(outcome.result.model, 'openai/whisper-large-v3', 'модель — запасная')
    eq(outcome.result.fallbackReason, 'provider', 'причина — сбой основной')
    eq(outcome.result.durationSec, 5.5, 'длительность — из метаданных видео')
    eq(
      outcome.result.costRub.toFixed(6),
      '0.009900',
      'только удачная попытка: 5,5 с по тарифу Whisper — 0,0099 ₽',
    )
    ok(
      outcome.result.costRub < (5.5 / 60) * 0.24171,
      'за отказ основной модели ничего не начислено',
    )
  })

  await test('503 на обеих: ошибка называет обе причины, а не только первую', async () => {
    const { fn, calls } = makeFetch((_call, index) =>
      index === 0
        ? json(
            {
              error: {
                message:
                  'Все провайдеры модели `ai-sage/gigaam-v3` вернули ошибку. ' +
                  'Повторите запрос позже или выберите другую модель.',
              },
            },
            503,
          )
        : json({ error: { message: 'Внутренняя ошибка провайдера' } }, 500),
    )
    const outcome = await service({ fetch: fn }).transcribe({ source: SMALL })

    eq(calls.length, 2, 'обе модели были попробованы')
    ok(!outcome.ok, 'текста нет — отдаём ошибку')
    if (outcome.ok) return
    eq(outcome.error.code, 'server', 'код — как у основной ошибки')
    eq(outcome.error.status, 503, 'статус основной сохранён')
    eq(outcome.error.retriable, true, 'повторить имеет смысл')
    ok(outcome.error.message.includes('русская модель'), 'в сообщении названа основная модель')
    ok(outcome.error.message.includes('общая модель'), 'в сообщении названа запасная модель')
    ok(outcome.error.message.includes('503'), 'причина основной — 503')
    ok(outcome.error.message.includes('500'), 'причина запасной — 500')
    ok(outcome.error.message.includes('Все провайдеры модели'), 'пояснение провайдера не потеряно')
    ok(!outcome.error.message.includes('другую модель'), 'не предлагаем выбор модели')
    ok(outcome.error.message.includes('попробуйте снова'), 'сказано, что делать')
  })

  await test('401/402/413/неизвестная модель: второй попытки нет', async () => {
    const cases: Array<{ status: number; code: TranscriptionError['code']; body: unknown }> = [
      { status: 401, code: 'auth', body: { error: { message: 'bad key' } } },
      { status: 402, code: 'budget', body: { error: { message: 'no money' } } },
      { status: 413, code: 'too_large', body: { error: { code: 'PAYLOAD_TOO_LARGE' } } },
      { status: 400, code: 'http', body: { error: { message: 'model not found' } } },
    ]
    for (const item of cases) {
      const { fn, calls } = makeFetch(() => json(item.body, item.status))
      // Файл уже вырезан заранее: 413 не запускает вторую попытку с другим
      // файлом, и остаётся только вопрос «пробовать ли запасную модель».
      const outcome = await service({
        fetch: fn,
        extractAudio: fakeExtractor(512).extractor,
        settings: { maxUploadBytes: 1024 },
      }).transcribe({ source: { blob: blobOf(8192) } })

      eq(calls.length, 1, `${item.status}: запрос ровно один`)
      eq(formOf(calls[0]!).get('model'), 'ai-sage/gigaam-v3', `${item.status}: запасная не вызывалась`)
      ok(!outcome.ok && outcome.error.code === item.code, `${item.status}: код ${item.code}`)
    }
  })

  await test('нет речи на основной: запасную не зовём', async () => {
    const { fn, calls } = makeFetch(() => json({ text: '   ', duration: 3 }))
    const outcome = await service({ fetch: fn }).transcribe({ source: SMALL })
    eq(calls.length, 1, 'второй попытки нет: дело не в модели')
    ok(!outcome.ok && outcome.error.code === 'no_speech', 'код no_speech')
    ok(!outcome.ok && !outcome.error.retriable, 'повтор не предлагается')
  })

  await test('модели совпали: даже 503 не даёт второй попытки', async () => {
    const { fn, calls } = makeFetch(() => json({ error: { message: 'недоступен' } }, 503))
    const outcome = await service({
      fetch: fn,
      fallbackModel: 'ai-sage/gigaam-v3',
    }).transcribe({ source: SMALL })
    eq(calls.length, 1, 'второго запроса нет: он был бы тем же самым')
    ok(!outcome.ok && outcome.error.code === 'server', 'ошибка основной модели как есть')
  })

  await test('таймаут основной: запасная отвечает', async () => {
    const { fn, calls } = makeFetch((call, index) => {
      if (index === 0) {
        return new Promise<Response>((_resolve, reject) => {
          const signal = call.init.signal as AbortSignal
          signal.addEventListener('abort', () => reject(new Error('aborted by timeout')))
        })
      }
      return transcribeResponse('Текст после таймаута основной.', 30)
    })
    const outcome = await service({ fetch: fn, settings: { requestTimeoutMs: 30 } }).transcribe({
      source: SMALL,
    })
    eq(calls.length, 2, 'после таймаута — вторая попытка')
    ok(outcome.ok, 'запасная спасла результат')
    if (outcome.ok) {
      eq(outcome.result.fallbackReason, 'provider', 'причина — сбой основной')
      ok(String(outcome.result.note).includes('не успел ответить'), 'примечание называет таймаут')
    }
  })

  await test('сетевой сбой основной: запасная отвечает', async () => {
    let call = 0
    const fn = (async (): Promise<Response> => {
      call += 1
      if (call === 1) throw new TypeError('Failed to fetch')
      return transcribeResponse('Текст при живом повторе.', 30)
    }) as typeof fetch
    const outcome = await service({ fetch: fn }).transcribe({ source: SMALL })
    eq(call, 2, 'сетевой сбой — повод для запасной')
    ok(outcome.ok && outcome.result.usedFallback, 'запасная ответила')
    if (outcome.ok) ok(String(outcome.result.note).includes('пропала связь'), 'причина названа спокойно')
  })

  await test('отмена во время первой попытки: запасная не запускается', async () => {
    const controller = new AbortController()
    const { fn, calls } = makeFetch(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = call.init.signal as AbortSignal
          signal.addEventListener('abort', () => reject(new Error('AbortError')))
        }),
    )
    const pending = service({ fetch: fn, settings: { requestTimeoutMs: 5_000 } }).transcribe({
      source: SMALL,
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 20)
    const outcome = await pending
    eq(calls.length, 1, 'после отмены второго запроса нет')
    ok(!outcome.ok && outcome.error.code === 'aborted', 'код aborted')
  })

  await test('основная упала, запасная не нашла речи: спокойный no_speech', async () => {
    const { fn, calls } = makeFetch((_call, index) =>
      index === 0 ? json({ error: { message: 'недоступен' } }, 503) : json({ text: '  ', duration: 3 }),
    )
    const outcome = await service({ fetch: fn }).transcribe({ source: SMALL })
    eq(calls.length, 2, 'обе попытки были')
    ok(!outcome.ok && outcome.error.code === 'no_speech', 'это ответ запасной, а не общая ошибка')
    ok(!outcome.ok && !outcome.error.retriable, 'повтор не предлагается')
  })

  await test('совет провайдера «выберите другую модель» не доходит до человека', async () => {
    const { fn } = makeFetch(() =>
      json(
        {
          error: {
            message:
              'Все провайдеры модели `ai-sage/gigaam-v3` вернули ошибку. ' +
              'Повторите запрос позже или выберите другую модель.',
          },
        },
        503,
      ),
    )
    const outcome = await service({
      fetch: fn,
      fallbackModel: 'ai-sage/gigaam-v3',
    }).transcribe({ source: SMALL })
    ok(!outcome.ok, 'ошибка')
    if (outcome.ok) return
    ok(outcome.error.message.includes('Все провайдеры модели'), 'настоящая причина осталась')
    ok(!outcome.error.message.includes('другую модель'), 'совета выбрать модель нет')
    ok(outcome.error.message.includes('подождите'), 'сказано, что делать')

    const english = makeFetch(() =>
      json(
        {
          error: {
            message: 'All providers failed. Please try again later or choose a different model.',
          },
        },
        503,
      ),
    )
    const second = await service({
      fetch: english.fn,
      fallbackModel: 'ai-sage/gigaam-v3',
    }).transcribe({ source: SMALL })
    ok(!second.ok, 'английский отказ — тоже ошибка')
    if (!second.ok) {
      ok(!second.error.message.includes('different model'), 'английский совет убран')
      ok(second.error.message.includes('All providers failed'), 'английская причина сохранена')
    }
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
