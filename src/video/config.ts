/**
 * Конфиг сжатия видео: цифры, а не код вызова.
 *
 * Здесь собраны параметры, которые меняются решением продукта («по умолчанию
 * 720p», сколько битрейта оставлять), и адрес ядра ffmpeg. Вызывающий код
 * передаёт только то, что действительно отличается от общего случая.
 *
 * ## Про сборку ядра — это важно
 *
 * Берём **@ffmpeg/core** (одиночная сборка), а НЕ `@ffmpeg/core-mt`.
 * Причина простая: многопоточная сборка требует `SharedArrayBuffer`, а тот
 * отдаётся браузером только с заголовками COOP/COEP. GitHub Pages таких
 * заголовков не отдаёт и отдавать не будет — значит, `-mt` на публикации
 * просто не запустится. Одиночное ядро работает без заголовков.
 * Проверено по содержимому пакета: в `dist/esm/ffmpeg-core.js` версии 0.12.9
 * нет ни `SharedArrayBuffer`, ни pthread-вызовов.
 *
 * ## Откуда берётся ядро
 *
 * По умолчанию — с CDN, по точной версии: 31 МБ wasm в репозиторий и в
 * `public/` не кладём (и не раздуваем бандл). Но CDN берётся не один, а
 * несколько (`VIDEO_CORE_MIRRORS`), и загрузка перебирает их по очереди:
 * один CDN может быть недоступен — и тогда 31 МБ просто не скачиваются, а
 * человек видит «ffmpeg не загрузился» без причины. Если ядро понадобится
 * держать у себя, допишите свой адрес в список зеркал — интерфейс от этого
 * не меняется. Оговорка: у `@ffmpeg/core` лицензия GPL-2.0-or-later
 * (как у самого FFmpeg) — при самохостинге это стоит учесть.
 */

import { DEFAULT_METADATA_TIMEOUT_MS } from './metadata'
import type { VideoCompressionSettings, VideoCompressionStage } from './types'

/** Версия однопоточного ядра ffmpeg. Менять только вместе с проверкой. */
export const VIDEO_CORE_VERSION = '0.12.9'

/**
 * Базы, откуда берётся однопоточное ядро, по порядку: первая — основная,
 * остальные — запасные. Перебор делает `loadCoreFromMirrors`.
 *
 * Почему зеркал несколько: ядро нужно живым людям, а не нам. С телефона в
 * России мелкие видео расшифровывались, а крупные падали на вырезании звука,
 * и в логе ffmpeg было пусто — то есть 31 МБ ядра просто не скачались с
 * `unpkg.com`. Зеркало превращает «CDN недоступен» в «ядро с другого CDN».
 *
 * Как добавить своё (самохостинг): положите `ffmpeg-core.js` и
 * `ffmpeg-core.wasm` версии `VIDEO_CORE_VERSION` в свою папку и допишите её
 * адрес в этот список — без слэша на конце и без имени файла, например
 * `/ffmpeg-core` или `https://свой-домен/ffmpeg-core`. Порядок = приоритет.
 * Оба файла загрузчик обязан брать из ОДНОЙ базы: версии js и wasm должны
 * совпадать, смешивать зеркала нельзя.
 *
 * Именно `dist/esm`: ядро загружается как ES-модуль внутри module-worker
 * (так его собирает Vite), и только у esm-сборки есть `export default`.
 */
export const VIDEO_CORE_MIRRORS: readonly string[] = [
  `https://unpkg.com/@ffmpeg/core@${VIDEO_CORE_VERSION}/dist/esm`,
  `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${VIDEO_CORE_VERSION}/dist/esm`,
]

/**
 * База по умолчанию: ровно первое зеркало.
 *
 * Оставлено для совместимости: адрес ядра знали снаружи (и, возможно, знают
 * тесты). Код загрузки ходит по всему списку `VIDEO_CORE_MIRRORS`, а не сюда.
 */
export const VIDEO_CORE_BASE_URL = VIDEO_CORE_MIRRORS[0]

/** Путь к скрипту ядра внутри базы зеркала. */
export const VIDEO_CORE_SCRIPT = 'ffmpeg-core.js'

/** Путь к wasm-модулю ядра внутри базы зеркала. */
export const VIDEO_CORE_WASM = 'ffmpeg-core.wasm'

/**
 * Сколько ждать ОДНО зеркало, мс.
 *
 * 31 МБ по сети: 120 с — это ≈2,1 Мбит/с, тот же порог, что и у бюджета
 * загрузки ядра в настройках сжатия (значение по умолчанию берётся отсюда).
 * Меньше — рискованно для медленного, но живого соединения: такая загрузка
 * ещё уложилась бы, а мы бы её уже оборвали. Больше — человек смотрит на
 * неподвижный прогресс, хотя зеркало просто мертво.
 *
 * Таймаут считается на каждое зеркало отдельно, поэтому худший случай при
 * двух зеркалах — вдвое дольше одного. Это плата за независимость от одного
 * CDN, и платится она только тогда, когда первый CDN действительно недоступен.
 */
export const VIDEO_CORE_MIRROR_TIMEOUT_MS = 120_000

/**
 * Адреса обоих файлов ядра на одном зеркале.
 *
 * Отдельная функция не «для красоты»: js и wasm обязаны быть с одного зеркала
 * (версии должны совпадать), и это свойство проверяется тестом — а не глазами
 * в двух модулях сразу.
 */
export function coreFileUrls(mirror: string): { script: string; wasm: string } {
  return {
    script: `${mirror}/${VIDEO_CORE_SCRIPT}`,
    wasm: `${mirror}/${VIDEO_CORE_WASM}`,
  }
}

/**
 * Доля скачанного — для полосы прогресса. `null` означает «неизвестно».
 *
 * Врём мы тут дважды и оба раза не по своей воле. `unpkg` отдаёт ядро
 * chunked, без `Content-Length` — длины нет вовсе. `jsdelivr` длину отдаёт,
 * но от СЖАТОГО тела (≈9 МБ против ≈31 МБ распакованных), и `received`
 * обгоняет `total` с первых же секунд. В обоих случаях честнее показать
 * «идёт загрузка», чем застывшую на 100% полосу, будто всё уже скачано.
 */
export function coreDownloadRatio(event: { total: number; received: number }): number | null {
  if (!(event.total > 0) || event.received > event.total) return null
  return Math.min(1, event.received / event.total)
}

// --- Скачивание ядра без `toBlobURL` -----------------------------------------

/** Прогресс скачивания одного файла ядра: байты, а долю считает `coreDownloadRatio`. */
export interface CoreDownloadProgress {
  /** Ожидаемая длина из `Content-Length`; `-1` — сервер её не сообщил. */
  total: number
  /** Сколько байт тела уже получено. */
  received: number
  /** Последнее событие: тело прочитано до конца. */
  done: boolean
}

/** Необязательные подробности скачивания: отмена и прогресс. */
export interface CoreDownloadOptions {
  /** Отмена: `fetch` и чтение потока прерываются, загрузка не досчитывается. */
  signal?: AbortSignal
  /** Прогресс: вызывается на каждый кусок тела и один раз в конце. */
  onProgress?: (event: CoreDownloadProgress) => void
}

/**
 * Скачивает файл ядра и возвращает `blob:`-адрес.
 *
 * Делает ровно то же, что `toBlobURL(url, mimeType, true, cb)` из
 * `@ffmpeg/util`, — и НЕ вызывает её намеренно. Причина в ошибке самой
 * библиотеки (`@ffmpeg/util@0.12.2`, `downloadWithProgress`):
 *
 * 1. она читает `resp.body` ОДИН раз — ради прогресса;
 * 2. если `received` не сошлось с `Content-Length`, внутри `try` бросается
 *    ошибка, и `catch` лезет читать ТЕЛО ВТОРОЙ РАЗ через `resp.arrayBuffer()`.
 *    Браузер отвечает `TypeError: body stream already read`;
 * 3. а не сходится длина законно: `cdn.jsdelivr.net` отдаёт тело сжатым и
 *    указывает длину СЖАТОГО тела (≈9 МБ), распакованных приходит ≈31 МБ.
 *
 * Итог: запасное зеркало (jsdelivr) не работало вовсе — именно тогда, когда
 * нужно, то есть когда недоступен основной `unpkg.com`. Поэтому здесь:
 *
 * - тело читается строго один раз, второго чтения нет ни на одной ветке;
 * - расхождение `Content-Length` с фактом — НЕ ошибка, а лишь повод показать
 *   прогресс без доли (`coreDownloadRatio` вернёт `null`);
 * - нет потока (`resp.body === null`) — читаем `arrayBuffer()`, тело ещё цело;
 * - не-2xx — понятная ошибка с кодом ответа, а не «загадочный сбой»;
 * - отмена идёт в `fetch` сигналом и обрывает чтение, а не ждёт конца.
 *
 * Не «упрощайте» обратно до `toBlobURL` с прогрессом: это вернёт ту же ошибку.
 */
export async function downloadCoreToBlobURL(
  url: string,
  mimeType: string,
  options: CoreDownloadOptions = {},
): Promise<string> {
  const { signal, onProgress } = options

  let response: Response
  try {
    response = await fetch(url, signal ? { signal } : {})
  } catch (error) {
    // Отмена — не отказ сети: её узнаёт `loadCoreFromMirrors` по имени ошибки.
    if (signal?.aborted || looksLikeAbort(error)) throw abortFailure()
    throw new Error(`не удалось скачать ядро ffmpeg: ${shortCoreFailureReason(error)}`)
  }

  if (!response.ok) {
    const statusText = response.statusText ? ` (${response.statusText})` : ''
    throw new Error(`не удалось скачать ядро ffmpeg: ответ ${response.status}${statusText}`)
  }

  const bytes = await readCoreBody(response, contentLengthOf(response), onProgress, signal)
  return URL.createObjectURL(new Blob([bytes], { type: mimeType }))
}

/**
 * Длина тела из `Content-Length`: `-1`, если заголовка нет или он нечитаем.
 *
 * Значение может описывать СЖАТОЕ тело — поэтому оно годится для полосы
 * прогресса, но не для проверок «скачано ровно столько».
 */
function contentLengthOf(response: Response): number {
  const raw = response.headers.get('content-length')
  if (raw === null) return -1
  const total = Number.parseInt(raw, 10)
  return Number.isFinite(total) && total >= 0 ? total : -1
}

/**
 * Один проход по телу ответа. Возвращает склеенные байты.
 *
 * Второго чтения здесь нет и быть не должно: именно на нём ломалась
 * `downloadWithProgress` из `@ffmpeg/util`. Поток отсутствует — читаем
 * `arrayBuffer()`: в этом случае тело ещё никто не трогал, это безопасно.
 */
async function readCoreBody(
  response: Response,
  total: number,
  onProgress: ((event: CoreDownloadProgress) => void) | undefined,
  signal: AbortSignal | undefined,
): Promise<Uint8Array<ArrayBuffer>> {
  const body = response.body
  if (body === null) {
    const buffer = await response.arrayBuffer()
    const bytes = new Uint8Array(buffer)
    onProgress?.({ total: bytes.byteLength, received: bytes.byteLength, done: true })
    return bytes
  }

  const reader = body.getReader()
  // Отмена обрывает именно чтение: висящий `read()` завершится, а не будет
  // ждать, пока 31 МБ досчитаются вхолостую после ухода человека.
  const onAbort = (): void => {
    void reader.cancel().catch(() => {})
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) onAbort()

  const chunks: Uint8Array[] = []
  let received = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        chunks.push(value)
        received += value.byteLength
      }
      // Расхождение с `total` здесь никого не останавливает: длина бывает от
      // сжатого тела, и это повод показать «идёт загрузка», а не ошибку.
      onProgress?.({ total, received, done: false })
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }

  // Отмена важнее результата: закрывшийся в тот же миг поток не должен
  // выглядеть как успешно скачанное ядро.
  if (signal?.aborted) throw abortFailure()

  const bytes = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  onProgress?.({ total, received, done: true })
  return bytes
}

/** Тип результата: H.264 + AAC в mp4 — читается везде, где есть браузер. */
export const VIDEO_OUTPUT_MIME = 'video/mp4'

/** Имя результата во внутренней файловой системе ffmpeg. */
export const VIDEO_OUTPUT_NAME = 'muza-compressed.mp4'

/** Имя исходника, когда по типу не удалось понять расширение. */
export const VIDEO_FALLBACK_INPUT_NAME = 'muza-input.mp4'

/**
 * Разумный битрейт по высоте кадра (H.264, одна дорожка видео).
 * Значения — «смотрибельно на телефоне», не максимум качества: задача сжатия —
 * освободить место, а не сохранить 4K.
 */
export const VIDEO_BITRATE_BY_HEIGHT: ReadonlyArray<{ height: number; kbps: number }> = [
  { height: 2160, kbps: 14000 },
  { height: 1440, kbps: 7000 },
  { height: 1080, kbps: 4500 },
  { height: 720, kbps: 2500 },
  { height: 480, kbps: 1200 },
  { height: 360, kbps: 700 },
  { height: 240, kbps: 400 },
]

/**
 * Значения по умолчанию.
 *
 * Почему 720 и 2500 кбит/с: по ВИДЕО.md это даёт −60% для своей съёмки 1080p
 * и −75% для 4K, а картинка остаётся «посмотреть через год». Reels 720p
 * обычно и так лежат около 2.5 Мбит/с — такие файлы модуль не трогает
 * (см. `bitrateTolerance`).
 */
export const DEFAULT_VIDEO_COMPRESSION_SETTINGS: VideoCompressionSettings = {
  targetHeight: 720,
  videoBitrateKbps: null, // null — берём из таблицы по целевой высоте
  audioBitrateKbps: 128,
  videoCodec: 'libx264',
  audioCodec: 'aac',
  preset: 'veryfast',
  pixelFormat: 'yuv420p',
  maxrateFactor: 1.5,
  bufsizeSeconds: 3,
  bitrateTolerance: 1.25,
  // Выше этого файл целиком копируется в память wasm, а heap у wasm32 —
  // 2 ГБ на всё. Такой файл честнее отдать серверной реализации.
  maxInputBytes: 1024 * 1024 * 1024,
  metadataTimeoutMs: DEFAULT_METADATA_TIMEOUT_MS,
  coreLoadTimeoutMs: VIDEO_CORE_MIRROR_TIMEOUT_MS,
  encodeTimeoutMs: 30 * 60_000,
}

/**
 * Доли общего прогресса по этапам.
 *
 * Холодный запуск включает скачивание ядра (десятки мегабайт) — оно заметно
 * на глаз, поэтому ему отдана треть полосы. В тёплом запуске ядро уже
 * загружено, и почти вся полоса принадлежит кодированию.
 */
export const VIDEO_PROGRESS_STAGES_COLD: Readonly<
  Record<VideoCompressionStage, readonly [number, number]>
> = {
  check: [0, 0.02],
  download: [0.02, 0.35],
  probe: [0.35, 0.4],
  encode: [0.4, 0.98],
  finish: [0.98, 1],
}

/** То же, но ядро уже загружено — скачивания в полосе нет. */
export const VIDEO_PROGRESS_STAGES_WARM: Readonly<
  Record<VideoCompressionStage, readonly [number, number]>
> = {
  check: [0, 0.02],
  download: [0.02, 0.02],
  probe: [0.02, 0.05],
  encode: [0.05, 0.98],
  finish: [0.98, 1],
}

/**
 * Битрейт под целевую высоту: берём ближайшую табличную строку, а за
 * пределами таблицы — пересчитываем по площади кадра (битрейт растёт
 * примерно как высота в степени 1.5).
 */
export function videoBitrateForHeight(height: number): number {
  const wanted = Number.isFinite(height) && height > 0 ? height : 720
  const table = VIDEO_BITRATE_BY_HEIGHT
  let nearest = table[table.length - 1]
  let best = Number.POSITIVE_INFINITY
  for (const row of table) {
    const distance = Math.abs(row.height - wanted)
    if (distance < best) {
      best = distance
      nearest = row
    }
  }
  if (wanted === nearest.height) return nearest.kbps
  // Одна формула на оба направления: битрейт растёт как высота в степени 1.5.
  const scaled = nearest.kbps * (wanted / nearest.height) ** 1.5
  return Math.max(100, Math.round(scaled / 50) * 50)
}

/** Чётное число: H.264 требует чётных сторон кадра. */
function clampEven(value: number, min: number, max: number): number {
  const bounded = Math.min(Math.max(Math.round(value), min), max)
  return bounded % 2 === 0 ? bounded : bounded + 1
}

function positive(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * Собирает итоговые параметры: значения по умолчанию + правки.
 * Всё, что может прийти из настроек пользователя, здесь причёсывается —
 * дальше по коду параметры уже валидные.
 */
export function resolveCompressionSettings(
  base: VideoCompressionSettings = DEFAULT_VIDEO_COMPRESSION_SETTINGS,
  overrides: Partial<VideoCompressionSettings> = {},
): VideoCompressionSettings {
  const merged: VideoCompressionSettings = { ...base, ...overrides }
  return {
    ...merged,
    // 144p — нижняя граница, выше 4320p сжимать в браузере бессмысленно.
    targetHeight: clampEven(merged.targetHeight, 144, 4320),
    videoBitrateKbps:
      merged.videoBitrateKbps === null || merged.videoBitrateKbps === undefined
        ? null
        : positive(merged.videoBitrateKbps, 2500),
    audioBitrateKbps: positive(merged.audioBitrateKbps, 128),
    maxrateFactor: Math.max(1, positive(merged.maxrateFactor, 1.5)),
    bufsizeSeconds: positive(merged.bufsizeSeconds, 3),
    bitrateTolerance: Math.max(1, positive(merged.bitrateTolerance, 1.25)),
    maxInputBytes: positive(merged.maxInputBytes, DEFAULT_VIDEO_COMPRESSION_SETTINGS.maxInputBytes),
    metadataTimeoutMs: positive(merged.metadataTimeoutMs, DEFAULT_METADATA_TIMEOUT_MS),
    coreLoadTimeoutMs: positive(merged.coreLoadTimeoutMs, VIDEO_CORE_MIRROR_TIMEOUT_MS),
    encodeTimeoutMs: positive(merged.encodeTimeoutMs, 30 * 60_000),
  }
}

// --- Перебор зеркал ----------------------------------------------------------

/**
 * Отказ одного зеркала: адрес и короткая причина — для сообщения человеку.
 *
 * Не «ядро не загрузилось», а что именно ответило зеркало. Без этого живой
 * сбой с телефона выглядел как загадка: ffmpeg молчит, лог пуст, и непонятно,
 * сеть это, CDN или кодек.
 */
export interface CoreMirrorFailure {
  /** База зеркала, которое не сработало. */
  mirror: string
  /** Короткая причина: одна строка, без стека и без простыни. */
  reason: string
}

/** Чем закончился перебор зеркал: ядро, отмена или причины всех отказов. */
export type CoreMirrorOutcome<TCore> =
  | { ok: true; core: TCore; mirror: string }
  | { ok: false; aborted: boolean; failures: readonly CoreMirrorFailure[] }

/** Что нужно, чтобы забрать ядро с зеркал по очереди. */
export interface CoreMirrorLoadOptions<TCore> {
  /** Зеркала по порядку: первое — основное, остальные — запасные. */
  mirrors: readonly string[]
  /**
   * Загрузчик одного зеркала. Обязан взять из переданной базы И скрипт,
   * И wasm: версии файлов с разных зеркал могут не совпасть.
   */
  load: (mirror: string, signal: AbortSignal) => Promise<TCore>
  /** Отмена: перебор останавливается, следующее зеркало не запускается. */
  signal?: AbortSignal
  /** Сколько ждать одно зеркало, мс. */
  timeoutMs: number
  /**
   * Переход на следующее зеркало: причина уже короткая.
   * `nextMirror` — `null`, если зеркала кончились.
   */
  onMirrorFailed?: (failure: CoreMirrorFailure, nextMirror: string | null) => void
  /** Как понять, что ошибка — это отмена. По умолчанию — по тексту ошибки. */
  isAbort?: (error: unknown) => boolean
}

/**
 * Перебор зеркал — одна чистая функция на оба модуля: сжатие видео и
 * вырезание звука.
 *
 * Почему отдельно: настоящий ffmpeg в Node не запускается, а перебор обязан
 * быть проверен тестом — с подменённым загрузчиком, без сети и без ядра.
 *
 * Правила простые: JS и wasm — с одного зеркала (за это отвечает загрузчик,
 * он получает ровно одну базу); упавшее зеркало не отменяет следующее; при
 * отмене перебор не идёт дальше; зависшее зеркало обрывается по таймауту и
 * уступает место следующему.
 */
export async function loadCoreFromMirrors<TCore>(
  options: CoreMirrorLoadOptions<TCore>,
): Promise<CoreMirrorOutcome<TCore>> {
  const { mirrors, load, signal, timeoutMs } = options
  const isAbort = options.isAbort ?? looksLikeAbort
  const failures: CoreMirrorFailure[] = []

  for (let index = 0; index < mirrors.length; index += 1) {
    const mirror = mirrors[index]
    // Отмена — значит отмена: следующее зеркало не запускаем.
    if (signal?.aborted) return { ok: false, aborted: true, failures }

    // Свой контроллер на попытку: таймаут должен прервать именно это зеркало,
    // а не всю загрузку.
    const attempt = new AbortController()
    const onExternalAbort = (): void => attempt.abort()
    signal?.addEventListener('abort', onExternalAbort)
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      attempt.abort()
    }, timeoutMs)

    try {
      const core = await raceWithAbort(load(mirror, attempt.signal), attempt.signal)
      return { ok: true, core, mirror }
    } catch (error) {
      if (signal?.aborted) return { ok: false, aborted: true, failures }
      // Загрузчик сам сказал «отменено» — второе зеркало тут не поможет.
      if (!timedOut && isAbort(error)) return { ok: false, aborted: true, failures }
      const reason = timedOut ? timeoutReason(timeoutMs) : shortCoreFailureReason(error)
      const failure: CoreMirrorFailure = { mirror, reason }
      failures.push(failure)
      options.onMirrorFailed?.(failure, mirrors[index + 1] ?? null)
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onExternalAbort)
    }
  }

  return { ok: false, aborted: false, failures }
}

/**
 * Ждём загрузку, но не дольше, чем живёт сигнал попытки.
 *
 * Наше скачивание (`downloadCoreToBlobURL`) сигнал уважает и обрывается само,
 * но гонка остаётся страховкой на случай, когда до сигнала дело не доходит:
 * например, `module.load` внутри воркера или чужой загрузчик в тесте. Без неё
 * зависшее зеркало держало бы перебор вечно — таймаут просто не сдвинул бы
 * его с места. Брошенная загрузка сама уберёт за собой blob-адреса (в
 * загрузчиках стоит `finally`), но ждать её мы не обязаны.
 */
function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortFailure())
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error instanceof Error || typeof error === 'string' ? error : new Error(String(error)))
      },
    )
  })
}

/** Ошибка «попытка прервана»: имя важно — по нему её узнаёт наш же разбор. */
function abortFailure(): Error {
  const error = new Error('aborted')
  error.name = 'AbortError'
  return error
}

/** Похоже ли на отмену по тексту ошибки: формулировки у браузеров разные. */
function looksLikeAbort(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /AbortError|aborted|was aborted/i.test(message)
}

/** Причина таймаута: коротко, без «0 с» и без миллисекунд. */
function timeoutReason(timeoutMs: number): string {
  const seconds = Math.round(timeoutMs / 1000)
  return seconds >= 1 ? `не ответило за ${seconds} с` : 'не ответило вовремя'
}

/** Короткая причина отказа: одна строка для сообщения человеку. */
export function shortCoreFailureReason(error: unknown, limit = 160): string {
  const object = error !== null && typeof error === 'object' ? (error as { message?: unknown }) : null
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : typeof object?.message === 'string'
          ? object.message
          : ''
  const compact = raw.replace(/\s+/g, ' ').trim()
  if (compact === '') return 'причина не сообщена'
  return compact.length > limit ? `${compact.slice(0, limit)}…` : compact
}

/** Короткий список причин по всем зеркалам: «unpkg.com: …; cdn.jsdelivr.net: …». */
export function describeCoreMirrorFailures(failures: readonly CoreMirrorFailure[]): string {
  if (failures.length === 0) return 'причины не записаны'
  return failures.map((failure) => `${mirrorName(failure.mirror)}: ${failure.reason}`).join('; ')
}

/** Имя зеркала для сообщения: хост, а не длинный адрес с версией. */
export function mirrorName(mirror: string): string {
  try {
    return new URL(mirror).host
  } catch {
    // Самохостинг может задать относительный путь — покажем его как есть.
    return mirror
  }
}
