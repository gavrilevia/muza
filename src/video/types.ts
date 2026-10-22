/**
 * Типы модуля сжатия видео.
 *
 * Задача модуля узкая: получить байты видео и вернуть НОВЫЕ байты меньшего
 * размера. Решение о том, что делать с оригиналом, принимает вызывающий код
 * (в «Музе» оригинал хранится всегда — ВИДЕО.md, раздел 3), поэтому здесь нет
 * ни базы, ни файлов: только байты на входе и байты на выходе.
 *
 * Типы намеренно не знают про ffmpeg. Сегодня реализация браузерная
 * (ffmpeg.wasm), завтра появится серверная (прокси всё равно нужен для
 * расшифровки речи) — меняется реализация, интерфейс `VideoCompressor`
 * остаётся (РЕШЕНИЯ.md, вопрос 2: «интерфейс `OcrService` один, две
 * реализации»).
 *
 * Размеры здесь честно необязательные: до сжатия метаданные читает браузер,
 * а если кодек ему незнаком — их добудет ffmpeg уже внутри `compress`.
 */

/** Что сжимаем: байты и необязательные подсказки о файле. */
export interface VideoSource {
  /** Содержимое файла. Оригинал не изменяется и не перезаписывается. */
  blob: Blob
  /** Имя файла: нужно только для расширения во временном имени ffmpeg. */
  name?: string | null
  /** Тип содержимого (`video/mp4`, `video/quicktime`, …). */
  mimeType?: string | null
}

/** Что известно об исходнике. Неизвестное помечено `null`, а не нулём. */
export interface VideoMediaInfo {
  /** Вес файла в байтах. */
  sizeBytes: number
  /** Ширина кадра; `null` — измерить не удалось. */
  width: number | null
  /** Высота кадра; `null` — измерить не удалось. */
  height: number | null
  /** Длительность в секундах; `null` — измерить не удалось. */
  durationSec: number | null
  /** Средний битрейт исходника, бит/с; `null` — без длительности не считается. */
  bitrateBps: number | null
  /** Чем измерено: `<video>` браузера, ffmpeg или ничем. */
  measuredBy: 'element' | 'ffmpeg' | 'none'
}

/** Этап задания. Интерфейс по ним рисует, что именно происходит. */
export type VideoCompressionStage =
  /** Чтение метаданных и решение «надо ли вообще». */
  | 'check'
  /** Скачивание ядра ffmpeg: десятки мегабайт, только при первом сжатии. */
  | 'download'
  /** Разбор файла и подготовка его во внутренней файловой системе. */
  | 'probe'
  /** Кодирование — самая долгая часть (десятки секунд). */
  | 'encode'
  /** Чтение готовых байтов. */
  | 'finish'

/** Событие прогресса: 0..1 по всему заданию, чтобы рисовать полосу. */
export interface VideoCompressionProgress {
  /** Общий прогресс задания: 0 в начале, 1 в конце. Не убывает. */
  progress: number
  stage: VideoCompressionStage
  /** Прогресс внутри этапа, 0..1; `null` — этап неделим. */
  stageProgress: number | null
  /** Сколько секунд видео уже закодировано (этап `encode`). */
  encodedSec: number | null
  /** Готовая фраза для интерфейса. */
  message: string
}

/**
 * Параметры сжатия. Живут в конфиге (`config.ts`), а не в коде вызова:
 * «по умолчанию 720p» — это решение продукта, а не деталь вызова.
 */
export interface VideoCompressionSettings {
  /** Целевая высота кадра. По умолчанию 720. Выше исходной не поднимаем. */
  targetHeight: number
  /** Битрейт видео, кбит/с; `null` — взять из таблицы по целевой высоте. */
  videoBitrateKbps: number | null
  /** Битрейт звука, кбит/с. */
  audioBitrateKbps: number
  /** Кодек видео. В однопоточном ядре есть только `libx264`. */
  videoCodec: string
  /** Кодек звука. AAC читают все телефоны. */
  audioCodec: string
  /** Скорость кодирования x264: на телефоне важнее время, чем 3% битрейта. */
  preset: string
  /** Пиксельный формат: `yuv420p` понимают все плееры и телефоны. */
  pixelFormat: string
  /** Во сколько раз пик битрейта может превышать средний (VBV). */
  maxrateFactor: number
  /** Размер буфера VBV в секундах. */
  bufsizeSeconds: number
  /**
   * Во сколько раз измеренный битрейт должен превышать целевой, чтобы
   * перекодирование имело смысл. Ниже — экономия не стоит потери качества
   * и времени.
   */
  bitrateTolerance: number
  /** Файл больше этого браузеру не отдать: нужен серверный путь. */
  maxInputBytes: number
  /** Сколько ждать появления метаданных у `<video>`, мс. */
  metadataTimeoutMs: number
  /** Сколько ждать загрузку ядра ffmpeg, мс. */
  coreLoadTimeoutMs: number
  /** Сколько ждать само кодирование, мс. */
  encodeTimeoutMs: number
}

/** Что должно получиться: цель по кадру, битрейту и весу. */
export interface VideoCompressionTarget {
  /**
   * Ширина результата (чётная: требование H.264); `null` — кадр не
   * уменьшается, а исходную ширину измерить не удалось.
   */
  width: number | null
  /** Высота результата; `null` — то же, что и у ширины. */
  height: number | null
  /** Будет ли кадр уменьшаться. */
  downscaled: boolean
  /** Средний битрейт видео, кбит/с. */
  videoBitrateKbps: number
  /** Видео + звук, бит/с. */
  totalBitrateBps: number
  /** Ожидаемый вес, байт; `null` — длительность неизвестна. */
  estimatedBytes: number | null
  /** Ожидаемая экономия, 0..1; `null` — вес посчитать нельзя. */
  estimatedRatio: number | null
}

/**
 * Решение «сжимать или нет» — принимается ДО загрузки ffmpeg, чтобы не
 * тратить десятки секунд на файл, который и так маленький.
 */
export interface VideoCompressionPlan {
  info: VideoMediaInfo
  /** Нужно ли сжатие. */
  needed: boolean
  /** Почему не нужно — код отказа; `null`, если сжатие нужно. */
  code: VideoCompressionErrorCode | null
  /** Понятная фраза: почему решили так и что будет на выходе. */
  message: string
  /** Что получится, если сжимать. */
  target: VideoCompressionTarget
}

/** Результат осмотра: метаданные и решение. ffmpeg при этом не грузится. */
export type VideoInspectionOutcome =
  | { ok: true; plan: VideoCompressionPlan }
  | { ok: false; error: VideoCompressionError }

/** Задание на сжатие. */
export interface VideoCompressionJob {
  source: VideoSource
  /** Прогресс 0..1 — длинная работа должна быть видна. */
  onProgress?: (event: VideoCompressionProgress) => void
  /** Отмена: закрыл карточку — сжатие прекращается. */
  signal?: AbortSignal
  /** Правки параметров поверх конфига сервиса. */
  settings?: Partial<VideoCompressionSettings>
  /** Строки лога ffmpeg — для отладки, наружу их показывать не нужно. */
  onLog?: (line: string) => void
}

/** Успешное сжатие: НОВЫЕ байты. Оригинал остаётся у вызывающего кода. */
export interface VideoCompressionResult {
  /** Готовое видео. Тип — `video/mp4` (H.264 + AAC). */
  blob: Blob
  /** Вес исходника, байт. */
  bytesBefore: number
  /** Вес результата, байт. */
  bytesAfter: number
  /** Ширина результата. */
  width: number
  /** Высота результата. */
  height: number
  /** Длительность результата, секунды (0 — ffmpeg не сообщил). */
  durationSec: number
  /** Сколько байтов сэкономлено. */
  savedBytes: number
  /** Доля экономии, 0..1 (сколько от исходника отняли). */
  savedRatio: number
  /** Сколько заняло времени, мс. */
  elapsedMs: number
  /** С какими параметрами сжимали. */
  settings: VideoCompressionSettings
}

/** Итог сжатия: либо новые байты, либо понятная причина отказа. */
export type VideoCompressionOutcome =
  | { ok: true; result: VideoCompressionResult }
  | { ok: false; error: VideoCompressionError; info?: VideoMediaInfo }

/** Итог предварительной загрузки ядра. */
export type VideoPreloadOutcome = { ok: true } | { ok: false; error: VideoCompressionError }

/**
 * Коды ошибок. По коду вызывающий код решает, стоит ли повторять и что
 * показать человеку.
 */
export type VideoCompressionErrorCode =
  /** Среда не подходит: нет WebAssembly, Worker или DOM. */
  | 'unsupported'
  /** Уже идёт другое сжатие: один ffmpeg — одно задание. */
  | 'busy'
  /** Сжатие не нужно: и разрешение, и битрейт уже не выше цели. */
  | 'not_needed'
  /** Файл больше, чем браузер может принять в память. */
  | 'too_large'
  /** Не видео, битый файл или неизвестный контейнер. */
  | 'invalid_file'
  /** Ядро ffmpeg не скачалось: нет сети или CDN недоступен. */
  | 'core_load_failed'
  /** Не хватило памяти на файл или на ядро. */
  | 'out_of_memory'
  /** Не уложились в отведённое время. */
  | 'timeout'
  /** Отменено вызывающим кодом. */
  | 'aborted'
  /** ffmpeg отказался кодировать. */
  | 'encode_failed'
  /** Результат не удалось прочитать. */
  | 'read_failed'

/**
 * Понятная ошибка вместо «что-то пошло не так».
 * Модуль не бросает её наружу: она приходит в результате (`ok: false`),
 * поэтому интерфейс не падает.
 */
export class VideoCompressionError extends Error {
  readonly code: VideoCompressionErrorCode
  /** Стоит ли пробовать снова (например, появилась сеть). */
  readonly retriable: boolean

  constructor(
    code: VideoCompressionErrorCode,
    message: string,
    options: { retriable?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'VideoCompressionError'
    this.code = code
    this.retriable = options.retriable ?? false
  }
}
