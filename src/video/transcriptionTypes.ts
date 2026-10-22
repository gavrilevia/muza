/**
 * Типы расшифровки речи.
 *
 * Задача сервиса узкая: получить байты видео или голосовой заметки и вернуть
 * текст, длительность и стоимость. Ни базы, ни интерфейса, ни очереди здесь
 * нет — решение «что делать с транскриптом» принимает вызывающий код
 * (СХЕМА-ДАННЫХ.md: поле `transcript` у материала).
 *
 * Типы намеренно не знают ни про ffmpeg, ни про конкретного провайдера:
 * сегодня это polza.ai, завтра — любой OpenAI-совместимый сервис, и
 * меняется только реализация, а не интерфейс.
 */

/** Этап задания: по ним интерфейс рисует, что именно происходит. */
export type TranscriptionStage =
  /** Осмотр файла и решение «влезает или вырезаем звук». */
  | 'check'
  /** Вырезание звуковой дорожки из видео (ffmpeg). */
  | 'extract'
  /** Отправка файла провайдеру. */
  | 'upload'
  /** Ожидание ответа распознавания. */
  | 'wait'
  /** Разбор ответа и подсчёт стоимости. */
  | 'finish'

/** Событие прогресса: 0..1 по всему заданию, чтобы рисовать полосу. */
export interface TranscriptionProgress {
  /** Общий прогресс задания: 0 в начале, 1 в конце. Не убывает. */
  progress: number
  stage: TranscriptionStage
  /** Прогресс внутри этапа, 0..1; `null` — этап неделим. */
  stageProgress: number | null
  /** Готовая фраза для интерфейса. */
  message: string
}

/**
 * Что расшифровываем. Оригинал не изменяется и никуда не записывается:
 * сервис только читает байты.
 */
export interface TranscriptionSource {
  blob: Blob
  /** Тип содержимого (`video/mp4`, `audio/mpeg`, …). */
  mimeType?: string | null
  /** Имя файла: нужно для расширения во временном имени ffmpeg. */
  name?: string | null
  /**
   * Длительность, если вызывающий код её уже знает (например, из метаданных
   * видео). Используется только как запасной источник: точную длительность
   * присылает провайдер вместе с текстом.
   */
  durationSec?: number | null
}

/** Задание на расшифровку. */
export interface TranscriptionJob {
  source: TranscriptionSource
  /** Прогресс 0..1 — длинная загрузка должна быть видна. */
  onProgress?: (event: TranscriptionProgress) => void
  /** Отмена: закрыл карточку — загрузка и вырезание прекращаются. */
  signal?: AbortSignal
}

/** Звук, вырезанный из видео: то, что реально уходит провайдеру. */
export interface TranscriptionAudio {
  blob: Blob
  mimeType: string
  /** Длительность вырезанного звука, если ffmpeg её назвал. */
  durationSec: number | null
}

/**
 * Успех: ровно то, что нужно положить в материал.
 * `durationSec` — длительность отправленного звука (0 — провайдер не назвал
 * и вызывающий код её не знал); `costRub` — стоимость по тарифу за минуту.
 */
export interface TranscriptionResult {
  text: string
  durationSec: number
  costRub: number
}

/**
 * Коды ошибок. По коду вызывающий код решает, ставить ли задачу на повтор
 * и что показать человеку.
 */
export type TranscriptionErrorCode =
  /** Ключ не задан — запрос в сеть не уходит вообще. */
  | 'no_key'
  /** Пустой файл: расшифровывать нечего. */
  | 'invalid_file'
  /** Среда не подходит (нет fetch) или модель не умеет то, что мы просим. */
  | 'unsupported'
  /** Сеть недоступна, соединение оборвалось. */
  | 'network'
  /** Провайдер не ответил за отведённое время. */
  | 'timeout'
  /** Отменено вызывающим кодом. */
  | 'aborted'
  /** 401/403: ключ отклонён или у него нет прав. */
  | 'auth'
  /** 402: не хватает средств на счёте. */
  | 'budget'
  /** 413 или файл больше лимита даже после вырезания звука. */
  | 'too_large'
  /** 429: слишком много запросов. */
  | 'rate_limit'
  /** 5xx: сервис распознавания недоступен. */
  | 'server'
  /** Прочий отказ провайдера (4xx). */
  | 'http'
  /** Ответ не является JSON. */
  | 'invalid_json'
  /** Ответ без текста: тишина, обрезанный ответ или асинхронная модель. */
  | 'empty_response'
  /** Звук не удалось вырезать (ffmpeg не справился). */
  | 'extract_failed'

/**
 * Понятная ошибка вместо «что-то пошло не так».
 * Сервис не бросает её наружу: она приходит в результате (`ok: false`),
 * поэтому исходный материал остаётся у вызывающего кода.
 */
export class TranscriptionError extends Error {
  readonly code: TranscriptionErrorCode
  /** Стоит ли пробовать снова (например, появилась сеть). */
  readonly retriable: boolean
  /** HTTP-код, если ошибка пришла от провайдера. */
  readonly status: number | null

  constructor(
    code: TranscriptionErrorCode,
    message: string,
    options: { retriable?: boolean; status?: number | null; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'TranscriptionError'
    this.code = code
    this.retriable = options.retriable ?? false
    this.status = options.status ?? null
  }
}

/** Итог расшифровки: либо текст со стоимостью, либо понятная причина отказа. */
export type TranscriptionOutcome =
  | { ok: true; result: TranscriptionResult }
  | { ok: false; error: TranscriptionError }
