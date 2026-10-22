/**
 * Чистые решения сжатия видео: что за файл, надо ли сжимать, с какими
 * параметрами, что считать прогрессом и как понять ошибку ffmpeg.
 *
 * Здесь нет ни DOM, ни ffmpeg, ни базы — поэтому всё это проверяется
 * Node-тестом (как `capture/logic.ts` и `backup/logic.ts`). Работа с ядром
 * ffmpeg и с `<video>` живёт в `VideoCompressor.ts`.
 *
 * Главное решение модуля — «сжимать или нет». Оно принимается ДО загрузки
 * ядра: скачать 31 МБ и потратить минуту на файл, который и так весит мало,
 * нельзя (ВИДЕО.md, раздел 3: сжатие — приём для больших видео, а не ритуал).
 */

import {
  VIDEO_FALLBACK_INPUT_NAME,
  VIDEO_PROGRESS_STAGES_COLD,
  VIDEO_PROGRESS_STAGES_WARM,
  videoBitrateForHeight,
} from './config'
import type {
  VideoCompressionErrorCode,
  VideoCompressionPlan,
  VideoCompressionSettings,
  VideoCompressionStage,
  VideoCompressionTarget,
  VideoMediaInfo,
  VideoSource,
} from './types'

// --- Числа и слова -----------------------------------------------------------

/** Сколько сэкономлено. Делить на ноль не приходится: пустой файл — не видео. */
export function savingsOf(
  bytesBefore: number,
  bytesAfter: number,
): { savedBytes: number; savedRatio: number; savedPercent: number } {
  const savedBytes = Math.max(0, bytesBefore - bytesAfter)
  const savedRatio = bytesBefore > 0 ? savedBytes / bytesBefore : 0
  return { savedBytes, savedRatio, savedPercent: Math.round(savedRatio * 100) }
}

/** Вес по-человечески: «220 МБ», «1.7 ГБ». */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 МБ'
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} ГБ`
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`
  return `${Math.max(1, Math.round(bytes / 1024))} КБ`
}

/** Битрейт по-человечески: «2.5 Мбит/с». */
export function formatBitrate(kbps: number): string {
  const value = Number.isFinite(kbps) && kbps > 0 ? kbps : 0
  return value >= 1000 ? `${(value / 1000).toFixed(1)} Мбит/с` : `${Math.round(value)} кбит/с`
}

/** Длительность по-человечески: «1 мин 12 с». */
export function formatSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0 с'
  const total = Math.round(seconds)
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  return minutes > 0 ? `${minutes} мин ${rest} с` : `${rest} с`
}

/**
 * Измеренный средний битрейт, бит/с. Без длительности его не посчитать —
 * тогда `null`, и решение «сжимать или нет» опирается только на разрешение.
 */
export function measuredBitrateBps(sizeBytes: number, durationSec: number | null): number | null {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return null
  if (durationSec === null || !Number.isFinite(durationSec) || durationSec <= 0) return null
  return (sizeBytes * 8) / durationSec
}

// --- Собираем метаданные -----------------------------------------------------

/** Что удалось прочитать из `<video>` или из ffmpeg. */
export interface PartialMediaInfo {
  width?: number | null
  height?: number | null
  durationSec?: number | null
}

/** Положительное число из чего угодно; иначе `null`. */
function positiveOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

/**
 * Складывает то, что измерил браузер, с тем, что измерил ffmpeg.
 * Поле за полем приоритет у ffmpeg: он разбирает контейнер, а `<video>`
 * может не знать кодек (например, HEVC в Chrome). `measuredBy = 'ffmpeg'`
 * означает «в измерении участвовал ffmpeg», а не «все поля от него».
 */
export function mergeMediaInfo(
  sizeBytes: number,
  fromElement: PartialMediaInfo | null,
  fromFfmpeg: PartialMediaInfo | null,
): VideoMediaInfo {
  const measuredBy: VideoMediaInfo['measuredBy'] = fromFfmpeg
    ? 'ffmpeg'
    : fromElement
      ? 'element'
      : 'none'
  const width = positiveOrNull(fromFfmpeg?.width) ?? positiveOrNull(fromElement?.width)
  const height = positiveOrNull(fromFfmpeg?.height) ?? positiveOrNull(fromElement?.height)
  const durationSec =
    positiveOrNull(fromFfmpeg?.durationSec) ?? positiveOrNull(fromElement?.durationSec)
  return {
    sizeBytes,
    width,
    height,
    durationSec,
    bitrateBps: measuredBitrateBps(sizeBytes, durationSec),
    measuredBy,
  }
}

// --- Цель сжатия -------------------------------------------------------------

/**
 * Каким будет результат по кадру.
 *
 * Уменьшаем только вниз: 720p не растягиваем до 1080p — это было бы
 * «сжатие», которое делает файл больше. Ширина считается от исходных
 * пропорций и округляется до чётной (требование H.264).
 */
export function targetDimensions(
  info: Pick<VideoMediaInfo, 'width' | 'height'>,
  settings: VideoCompressionSettings,
): { width: number | null; height: number | null; downscaled: boolean } {
  const width = positiveOrNull(info.width)
  const height = positiveOrNull(info.height)
  if (width === null || height === null) {
    // Кадр неизвестен: не уменьшаем и не выдумываем числа.
    return { width: null, height: null, downscaled: false }
  }
  if (height <= settings.targetHeight) {
    return { width, height, downscaled: false }
  }
  const scaledWidth = Math.round((width * settings.targetHeight) / height)
  return {
    width: scaledWidth % 2 === 0 ? scaledWidth : scaledWidth + 1,
    height: settings.targetHeight,
    downscaled: true,
  }
}

/**
 * Целевые параметры и ожидаемый вес.
 *
 * `guardSource` включается, когда сжатие уже решено: если исходник сжат
 * сильнее, чем мы привыкли (бывает у пересланных мессенджером видео),
 * битрейт не поднимаем — обрезаем по исходному, чтобы результат не оказался
 * тяжелее оригинала.
 */
export function planTarget(
  info: VideoMediaInfo,
  settings: VideoCompressionSettings,
  guardSource: boolean,
): VideoCompressionTarget {
  const dimensions = targetDimensions(info, settings)
  const configured =
    settings.videoBitrateKbps ??
    videoBitrateForHeight(dimensions.height ?? settings.targetHeight)
  let videoBitrateKbps = configured

  if (guardSource && info.bitrateBps !== null) {
    const sourceTotalKbps = info.bitrateBps / 1000
    // Целимся в 90% от исходного суммарного битрейта: меньше — уже экономия,
    // больше — смысла нет.
    const cap = Math.max(200, Math.round(sourceTotalKbps * 0.9 - settings.audioBitrateKbps))
    videoBitrateKbps = Math.min(videoBitrateKbps, cap)
  }

  const totalBitrateBps = (videoBitrateKbps + settings.audioBitrateKbps) * 1000
  const estimatedBytes =
    info.durationSec !== null ? Math.round((totalBitrateBps * info.durationSec) / 8) : null
  const estimatedRatio =
    estimatedBytes !== null && info.sizeBytes > 0
      ? Math.max(0, 1 - estimatedBytes / info.sizeBytes)
      : null

  return {
    width: dimensions.width,
    height: dimensions.height,
    downscaled: dimensions.downscaled,
    videoBitrateKbps,
    totalBitrateBps,
    estimatedBytes,
    estimatedRatio,
  }
}

// --- Решение: сжимать или нет ------------------------------------------------

/**
 * Решение по файлу. Уверенным оно бывает только тогда, когда известны
 * и кадр, и длительность: без них «уже маленький» не докажешь.
 *
 * Правила:
 *   1. кадр выше целевого — сжимаем (это и есть основная экономия);
 *   2. битрейт выше целевого с запасом (`bitrateTolerance`) — сжимаем;
 *   3. параметры измерить не удалось — сжимаем: отказ был бы решением
 *      наугад, а внутри ffmpeg параметры всё равно уточняются;
 *   4. иначе — честный отказ «сжатие не нужно»: файл уже 720p и не жирнее
 *      цели, время и качество тратить не на что.
 */
export function buildPlan(
  info: VideoMediaInfo,
  settings: VideoCompressionSettings,
): VideoCompressionPlan {
  const confident = info.width !== null && info.height !== null && info.durationSec !== null
  const configuredKbps = settings.videoBitrateKbps ?? videoBitrateForHeight(settings.targetHeight)
  const targetTotalBps = (configuredKbps + settings.audioBitrateKbps) * 1000
  const downscale = info.height !== null && info.height > settings.targetHeight
  const overBitrate = info.bitrateBps !== null && info.bitrateBps > targetTotalBps * settings.bitrateTolerance
  const needed = !confident || downscale || overBitrate

  const target = planTarget(info, settings, needed)
  if (!needed) {
    return {
      info,
      needed: false,
      code: 'not_needed',
      message: buildNotNeededMessage(info, settings, configuredKbps),
      target,
    }
  }
  return {
    info,
    needed: true,
    code: null,
    message: buildNeededMessage(info, settings, target, !confident),
    target,
  }
}

/** Почему сжимать не нужно — с цифрами, а не «файл слишком маленький». */
function buildNotNeededMessage(
  info: VideoMediaInfo,
  settings: VideoCompressionSettings,
  configuredKbps: number,
): string {
  const size = formatBytes(info.sizeBytes)
  const frame =
    info.width !== null && info.height !== null ? `${info.width}×${info.height}` : 'разрешение неизвестно'
  const bitrate = info.bitrateBps !== null ? formatBitrate(info.bitrateBps / 1000) : 'битрейт неизвестен'
  // Порог отказа — тот же, что у решения: ниже него перекодирование не окупается.
  const belowThreshold = Math.round((1 - 1 / settings.bitrateTolerance) * 100)
  return (
    `Сжатие не нужно: ${frame}, ${bitrate}, ${size}. ` +
    `Цель — ${settings.targetHeight}p и ${formatBitrate(configuredKbps + settings.audioBitrateKbps)}; ` +
    `файл уже не больше неё, экономия была бы меньше ${belowThreshold}%.`
  )
}

/** Что именно произойдёт с файлом. */
function buildNeededMessage(
  info: VideoMediaInfo,
  settings: VideoCompressionSettings,
  target: VideoCompressionTarget,
  uncertain: boolean,
): string {
  const size = formatBytes(info.sizeBytes)
  const frame =
    info.width !== null && info.height !== null ? `${info.width}×${info.height}` : 'кадр неизвестен'
  const outFrame =
    target.downscaled && target.width !== null && target.height !== null
      ? `${target.width}×${target.height}`
      : frame
  const estimate =
    target.estimatedBytes !== null
      ? `Ожидаемый вес ≈ ${formatBytes(target.estimatedBytes)} вместо ${size}`
      : `Текущий вес ${size}`
  const gain =
    target.estimatedRatio !== null ? ` (−${Math.round(target.estimatedRatio * 100)}%)` : ''
  const prefix = uncertain
    ? 'Параметры файла браузер не сообщил — разберём внутри ffmpeg. '
    : ''
  return (
    `${prefix}Сожмём: ${frame} → ${outFrame}, ${formatBitrate(target.videoBitrateKbps)} + звук ` +
    `${settings.audioBitrateKbps} кбит/с. ${estimate}${gain}.`
  )
}

// --- Прогресс ----------------------------------------------------------------

/**
 * Общий прогресс 0..1 по этапу и его прогрессу.
 * Полоса устроена так, чтобы длинные части (скачивание ядра, кодирование)
 * занимали почти всё время, а мгновенные (`check`, `finish`) — края
 * (см. `VIDEO_PROGRESS_STAGES_*`).
 */
export function progressAt(
  stage: VideoCompressionStage,
  stageProgress: number | null,
  needDownload: boolean,
): number {
  const ranges = needDownload ? VIDEO_PROGRESS_STAGES_COLD : VIDEO_PROGRESS_STAGES_WARM
  const [start, end] = ranges[stage]
  const within = stageProgress === null ? 0 : Math.min(Math.max(stageProgress, 0), 1)
  const value = start + (end - start) * within
  return Math.min(1, Math.max(0, value))
}

// --- Строки лога ffmpeg ------------------------------------------------------

/** Лог ffmpeg приходит кусками и разделён и `\n`, и `\r` (строка прогресса). */
export function splitLogLines(chunk: string): string[] {
  return chunk
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

/**
 * Разбор одной строки лога «до кодирования»: длительность и кадр.
 *
 * Строка вида
 *   `  Duration: 00:00:30.02, start: 0.000000, bitrate: 5068 kb/s`
 *   `  Stream #0:0(und): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 1920x1080, 5060 kb/s`
 *
 * Кадр берём только из строки видеопотока и только в виде «число x число»
 * по 2–5 цифр: так «0x31637661» (тег кодека) в размеры не попадает.
 */
export function parseProbeLine(line: string): PartialMediaInfo {
  const duration = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(line)
  if (duration) {
    const seconds =
      Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])
    return { durationSec: Number.isFinite(seconds) && seconds > 0 ? seconds : null }
  }
  if (/Stream #\d+:\d+.*Video:/.test(line)) {
    const size = /(\d{2,5})x(\d{2,5})/.exec(line)
    if (size) return { width: Number(size[1]), height: Number(size[2]) }
  }
  return {}
}

/** Собирает метаданные из всех строк лога «до кодирования». */
export function probeFromLines(lines: readonly string[]): PartialMediaInfo {
  const merged: PartialMediaInfo = {}
  for (const line of lines) {
    const part = parseProbeLine(line)
    if (part.durationSec !== undefined) merged.durationSec = part.durationSec
    if (part.width !== undefined) merged.width = part.width
    if (part.height !== undefined) merged.height = part.height
  }
  return merged
}

/**
 * Сколько секунд уже закодировано — из строки прогресса ffmpeg
 * (`frame= 120 fps=20 q=28.0 … time=00:00:04.00 bitrate=…`).
 * Своих вычислений не доверяем: у ffmpeg.wasm прогресс ломается, если
 * длительность не распознана, а нам нужен прогресс всегда.
 */
export function parseEncodedSeconds(line: string): number | null {
  const match = /time=\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(line)
  if (!match) return null
  const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null
}

// --- Команда ffmpeg ----------------------------------------------------------

/** Расширение по типу содержимого — ffmpeg угадывает контейнер по имени. */
const EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
  'video/mp4': 'mp4',
  'video/x-m4v': 'm4v',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv',
  'video/x-msvideo': 'avi',
  'video/mpeg': 'mpeg',
  'video/3gpp': '3gp',
  'video/ogg': 'ogv',
  'video/x-flv': 'flv',
  'video/mp2t': 'ts',
  'audio/mp4': 'm4a',
  'audio/webm': 'weba',
}

/** Расширение по типу или имени; `null` — понять не удалось. */
function knownExtension(source: VideoSource): string | null {
  const mime = (source.mimeType ?? source.blob.type ?? '').split(';')[0]?.trim().toLowerCase()
  if (mime && EXTENSION_BY_MIME[mime]) return EXTENSION_BY_MIME[mime]
  const name = source.name ?? ''
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  return /^[a-z0-9]{2,5}$/.test(ext) ? ext : null
}

/** Имя исходника во внутренней файловой системе ffmpeg. */
export function inputFileNameFor(source: VideoSource): string {
  const ext = knownExtension(source)
  return ext === null ? VIDEO_FALLBACK_INPUT_NAME : `muza-input.${ext}`
}

/**
 * Аргументы кодирования. Ничего лишнего: то же видео, меньший кадр и
 * меньший битрейт, звук AAC, mp4 с `faststart` (иначе видео не начнёт
 * играть, пока не скачается целиком).
 */
export function buildCompressArgs(
  inputName: string,
  outputName: string,
  settings: VideoCompressionSettings,
  target: VideoCompressionTarget,
): string[] {
  const maxrate = Math.round(target.videoBitrateKbps * settings.maxrateFactor)
  const args = ['-hide_banner', '-y', '-i', inputName]
  // Кадр уменьшаем только вниз и ровно до целевой высоты: ширина считается
  // по пропорциям и получается чётной (`-2`).
  if (target.downscaled) args.push('-vf', `scale=-2:${target.height}`)
  args.push(
    '-c:v',
    settings.videoCodec,
    '-preset',
    settings.preset,
    '-b:v',
    `${target.videoBitrateKbps}k`,
    '-maxrate',
    `${maxrate}k`,
    '-bufsize',
    `${Math.round(maxrate * settings.bufsizeSeconds)}k`,
    '-pix_fmt',
    settings.pixelFormat,
    '-c:a',
    settings.audioCodec,
    '-b:a',
    `${settings.audioBitrateKbps}k`,
    '-movflags',
    '+faststart',
    outputName,
  )
  return args
}

// --- Ошибки ------------------------------------------------------------------

/**
 * Что случилось по тексту ошибки ffmpeg.
 *
 * Тексты ffmpeg нестабильны, поэтому смотрим на устойчивые признаки
 * (память, битый контейнер) и во всём остальном честно говорим «не вышло».
 */
export function classifyFfmpegFailure(message: string): {
  code: VideoCompressionErrorCode
  message: string
  retriable: boolean
} {
  const text = message ?? ''
  if (/out of memory|OOM|Cannot enlarge memory|Aborted\(|memory access out of bounds|Array buffer allocation failed|allocation failed|failed to allocate/i.test(text)) {
    return {
      code: 'out_of_memory',
      message:
        'Браузеру не хватило памяти на это видео. Закройте лишние вкладки и попробуйте ещё раз — ' +
        'или сожмите файл на компьютере: для больших видео нужен серверный путь.',
      retriable: true,
    }
  }
  if (/Invalid data found|moov atom not found|Unknown format|does not contain any stream|Error opening input|could not find codec parameters|No such file or directory|End of file/i.test(text)) {
    return {
      code: 'invalid_file',
      message:
        'Файл не читается как видео: возможно, он повреждён или записан в формате, которого нет ' +
        'в браузерной сборке ffmpeg. Оригинал не тронут.',
      retriable: false,
    }
  }
  return {
    code: 'encode_failed',
    message: `Не удалось сжать видео: ffmpeg вернул ошибку. Оригинал не тронут.`,
    retriable: true,
  }
}

// --- Среда -------------------------------------------------------------------

/** Что есть в текущей среде. Вынесено отдельно, чтобы это можно было проверить. */
export interface VideoRuntimeEnv {
  hasWebAssembly: boolean
  hasWorker: boolean
  hasBlob: boolean
  hasDocument: boolean
}

/** Что доступно прямо сейчас. */
export function detectRuntimeEnv(): VideoRuntimeEnv {
  return {
    hasWebAssembly: typeof WebAssembly !== 'undefined',
    hasWorker: typeof Worker !== 'undefined',
    hasBlob: typeof Blob !== 'undefined',
    hasDocument: typeof document !== 'undefined',
  }
}

/**
 * Чего не хватает для сжатия. Пустой список — всё есть.
 * Без DOM сжатие невозможно не из-за ffmpeg, а из-за чтения метаданных
 * и создания ссылок на файлы: это браузерная реализация, и так и должно быть.
 */
export function missingRuntimeFeatures(env: VideoRuntimeEnv): string[] {
  const missing: string[] = []
  if (!env.hasWebAssembly) missing.push('WebAssembly')
  if (!env.hasWorker) missing.push('Web Worker')
  if (!env.hasBlob) missing.push('Blob')
  if (!env.hasDocument) missing.push('DOM')
  return missing
}
