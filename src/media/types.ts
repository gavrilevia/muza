/**
 * Типы «понять картинку».
 *
 * Задача сервиса узкая: получить байты изображения и вернуть ОДИН текст —
 * что на нём написано и что на нём изображено. Ни базы, ни интерфейса,
 * ни очереди здесь нет: решение «куда положить текст» принимает вызывающий
 * код (он пишет `extracted_text` материала).
 *
 * Типы не знают ни про polza.ai, ни про canvas: сегодня это OpenAI-совместимый
 * чат и браузер, завтра — другой провайдер или среда. Поэтому их можно
 * проверить обычным тестом на Node, без DOM.
 *
 * Никакой автоматики: сервис вызывается только по нажатию кнопки. Это
 * платная операция, и решение принимает человек.
 */

import type { LlmUsage } from '../ai'

/**
 * Форматы, которые сервис берётся отправлять.
 *
 * Ровно те, что понимает OpenAI-совместимый `image_url` и что мы умеем
 * прочитать в браузере. Формат определяется по байтам файла, а не по
 * расширению или `blob.type`: у файлов из буфера и «Поделиться» тип часто
 * пустой или неверный.
 */
export type SupportedImageMime = 'image/png' | 'image/jpeg' | 'image/webp'

/** Что просим понять. Оригинал не изменяется: сервис только читает байты. */
export interface ImageUnderstandingSource {
  blob: Blob
  /**
   * Тип «как его назвал браузер». Для решения о формате НЕ используется:
   * тип определяется по сигнатуре файла. Поле остаётся для журнала и
   * совместимости с `Material.mime`.
   */
  mimeType?: string | null
  /** Имя файла — только для сообщений, на запрос не влияет. */
  name?: string | null
}

/** Этап задания: по ним интерфейс рисует, что именно происходит. */
export type ImageUnderstandingStage =
  /** Чтение файла и определение формата. */
  | 'check'
  /** Уменьшение картинки до безопасной длинной стороны. */
  | 'resize'
  /** Отправка запроса модели. */
  | 'request'
  /** Разбор ответа и подсчёт стоимости. */
  | 'finish'

/** Событие прогресса: 0..1 по всему заданию. */
export interface ImageUnderstandingProgress {
  /** Общий прогресс: 0 в начале, 1 в конце. Не убывает. */
  progress: number
  stage: ImageUnderstandingStage
  /** Прогресс внутри этапа, 0..1; `null` — этап неделим. */
  stageProgress: number | null
  /** Готовая фраза для интерфейса. */
  message: string
}

/** Задание «понять картинку». */
export interface ImageUnderstandingJob {
  source: ImageUnderstandingSource
  /** Прогресс 0..1 — уменьшение и ожидание ответа должны быть видны. */
  onProgress?: (event: ImageUnderstandingProgress) => void
  /** Отмена: закрыл карточку — запрос прекращается. */
  signal?: AbortSignal
}

/** Что ушло модели после подготовки. Нужно для честного результата и тестов. */
export interface PreparedImage {
  /** `data:image/png;base64,…` — ровно то, что попадёт в `image_url.url`. */
  dataUrl: string
  /** Тип, определённый по байтам уже подготовленной картинки. */
  mimeType: SupportedImageMime
  /** Размер, который реально ушёл модели. */
  width: number
  height: number
  /** Размер исходника до уменьшения. */
  originalWidth: number
  originalHeight: number
  /** Байт в подготовленной картинке (без учёта base64-раздутия). */
  bytes: number
  /** true — картинку пришлось уменьшить. */
  resized: boolean
}

/** Успешный результат: текст с картинки и короткое описание одним ответом. */
export interface ImageUnderstandingResult {
  /** Что вернула модель. Кладётся в `extracted_text` материала. */
  text: string
  /** Тип, определённый по файлу. */
  mimeType: SupportedImageMime
  /** Размер, который ушёл модели (после уменьшения). */
  width: number
  height: number
  /** Байт в подготовленной картинке. */
  bytes: number
  resized: boolean
  originalWidth: number
  originalHeight: number
  /** Стоимость всех попыток этого вызова, ₽ — из `usage` клиента. */
  costRub: number
  /** Расход по токенам: то же, что вернул клиент ИИ. */
  usage: LlmUsage
  model: string
  attempts: number
}

/**
 * Коды ошибок. По коду вызывающий код решает, что показать человеку.
 * Материал и идея при любой ошибке остаются на месте: сервис ничего не пишет.
 */
export type ImageUnderstandingErrorCode =
  /** Ключ не задан — запрос в сеть не уходит вообще. */
  | 'no_key'
  /** Пустой файл: смотреть нечего. */
  | 'empty_file'
  /** Формат не поддержан (не PNG/JPEG/WebP) — запрос не отправлен. */
  | 'unsupported_format'
  /** Браузер не смог прочитать картинку (битые байты, нет памяти). */
  | 'decode_failed'
  /** Не удалось уменьшить картинку (нет canvas или он не отдал данные). */
  | 'prepare_failed'
  /** Сеть недоступна, соединение оборвалось. */
  | 'network'
  /** Провайдер не ответил за отведённое время. */
  | 'timeout'
  /** Отменено вызывающим кодом. */
  | 'aborted'
  /** 401/403: ключ отклонён или у него нет прав. */
  | 'auth'
  /** 402 или исчерпан лимит расходов приложения. */
  | 'budget'
  /** 413: даже уменьшенная картинка не прошла по лимиту. */
  | 'too_large'
  /** 429: слишком много запросов. */
  | 'rate_limit'
  /** 5xx: сервис модели недоступен. */
  | 'server'
  /** Прочий отказ провайдера (4xx). */
  | 'http'
  /** Ответ не JSON или пустой — модель не дала текст. */
  | 'invalid_response'

/**
 * Понятная ошибка вместо «что-то пошло не так».
 * Сервис не бросает её наружу: она приходит в результате (`ok: false`).
 */
export class ImageUnderstandingError extends Error {
  readonly code: ImageUnderstandingErrorCode
  /** Стоит ли пробовать снова (например, появилась сеть). */
  readonly retriable: boolean
  /** HTTP-код, если ошибка пришла от провайдера. */
  readonly status: number | null
  /**
   * Сколько уже списано за этот вызов, ₽. При ошибке после сетевой попытки
   * это не ноль: провайдер мог списать деньги, и скрывать это нельзя.
   */
  readonly costRub: number

  constructor(
    code: ImageUnderstandingErrorCode,
    message: string,
    options: { retriable?: boolean; status?: number | null; costRub?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'ImageUnderstandingError'
    this.code = code
    this.retriable = options.retriable ?? false
    this.status = options.status ?? null
    this.costRub = options.costRub ?? 0
  }
}

/** Итог: либо текст и стоимость, либо понятная причина отказа. */
export type ImageUnderstandingOutcome =
  | { ok: true; result: ImageUnderstandingResult }
  | { ok: false; error: ImageUnderstandingError }
