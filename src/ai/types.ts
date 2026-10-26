/**
 * Типы модуля обращения к языковой модели.
 *
 * Модуль ничего не знает о хранилище и о том, где лежит ключ: он получает
 * сообщения и конфиг, а возвращает результат и расход. Поэтому его можно
 * использовать и в браузере, и в обычном тесте на Node с подменённым fetch.
 *
 * Формат запроса и ответа — OpenAI-совместимый (ПРОМПТЫ.md, РЕШЕНИЯ.md).
 */

/** Роль автора сообщения — формат OpenAI. */
export type LlmRole = 'system' | 'user' | 'assistant'

/** Куда модель может смотреть: ссылка на картинку в формате OpenAI. */
export interface LlmImageUrl {
  /** `https://…` или `data:image/png;base64,…`. */
  url: string
  /** Насколько подробно разбирать картинку; по умолчанию провайдер решает сам. */
  detail?: 'auto' | 'low' | 'high'
}

/** Часть составного сообщения: текст. */
export interface LlmTextPart {
  type: 'text'
  text: string
}

/**
 * Часть составного сообщения: картинка.
 *
 * Вложенность `image_url: { url }` — не наша выдумка, а формат
 * OpenAI-совместимого чата: именно так картинку понимает шлюз polza.ai.
 */
export interface LlmImagePart {
  type: 'image_url'
  image_url: LlmImageUrl
}

/** Части, из которых может состоять сообщение с картинкой. */
export type LlmContentPart = LlmTextPart | LlmImagePart

/**
 * Содержимое сообщения.
 *
 * Строка — обычный текстовый путь: он остаётся прежним до байта, потому что
 * на нём держатся разбор идей, проверка ключа и расшифровка. Массив частей
 * нужен ТОЛЬКО там, где в сообщении есть изображение: у текстового сообщения
 * составной `content` не появляется никогда.
 */
export type LlmMessageContent = string | readonly LlmContentPart[]

/** Одно сообщение диалога. */
export interface LlmMessage {
  role: LlmRole
  content: LlmMessageContent
}

/**
 * Только текст сообщения — без картинок.
 *
 * Нужен там, где раньше сообщение было строкой: стабильный префикс промпта,
 * оценка токенов, журнал. Для строкового `content` возвращает её как есть,
 * поэтому текстовый путь не меняется.
 */
export function llmMessageText(message: LlmMessage): string {
  if (typeof message.content === 'string') return message.content
  return message.content
    .filter((part): part is LlmTextPart => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
}

/**
 * Типы идей — из ПРОМПТЫ.md, раздел «Типы: как различать».
 * Порядок здесь не важен, но набор менять нельзя: он же идёт в JSON-схему.
 */
export const IDEA_KINDS = [
  'recipe',
  'purchase',
  'gift',
  'place',
  'read',
  'do',
  'note',
] as const

export type IdeaKind = (typeof IDEA_KINDS)[number]

/**
 * Виды момента — из ПРОМПТЫ.md (раздел 9: date|season|event|manual|none).
 * `price` добавлен, потому что встречается в СХЕМА-ДАННЫХ.md
 * (`moment_rule`): ответ модели с ним не должен считаться невалидным.
 */
export const MOMENT_TYPES = ['date', 'season', 'event', 'manual', 'price', 'none'] as const

export type MomentType = (typeof MOMENT_TYPES)[number]

/** Момент — когда идея станет нужной. */
export interface Moment {
  type: MomentType
  /** Что известно: «день рождения Ани», «лето» и т. п. Для `none` — null. */
  value: string | null
  reasoning: string
}

/**
 * То, что вернула модель по промпту «КЛАССИФИКАТОР» (ПРОМПТЫ.md, раздел 1),
 * уже проверенное схемой и приведённое к нашим типам.
 *
 * Это ещё НЕ применённые данные: порог `confidence` накладывается в
 * `classify.ts`, потому что решение «применять или нет» — логика продукта.
 */
export interface ModelClassification {
  kind: IdeaKind
  direction_name: string | null
  is_new_direction: boolean
  confidence: number
  props: string[]
  moment: Moment | null
  reasoning: string
}

/**
 * Коды ошибок. По коду вызывающий код решает, что показать пользователю
 * и стоит ли ставить задачу в очередь на повтор.
 */
export type LlmErrorCode =
  /** Ключ не задан — запрос даже не уходит в сеть. */
  | 'no_key'
  /** Сеть недоступна, соединение оборвалось. */
  | 'network'
  /** Модель не ответила за отведённое время. */
  | 'timeout'
  /** Запрос отменил вызывающий код (уход со экрана, новая задача). */
  | 'aborted'
  /** Провайдер ответил ошибкой (4xx, кроме 429). */
  | 'http'
  /** Слишком много запросов (429). */
  | 'rate_limit'
  /** Ответ не удалось разобрать как JSON. */
  | 'invalid_json'
  /** JSON разобран, но не соответствует схеме. */
  | 'invalid_schema'
  /** Достигнут лимит расходов (АРХИТЕКТУРА.md, «Ошибки и деградация»). */
  | 'budget'
  /** Пустой текст идеи — классифицировать нечего. */
  | 'empty_input'

/** Понятная ошибка вместо «что-то пошло не так». */
export class LlmError extends Error {
  readonly code: LlmErrorCode
  /** Код HTTP, если ошибка пришла от провайдера. */
  readonly status?: number
  /** Стоит ли повторять запрос. Правило: не больше одного повтора. */
  readonly retriable: boolean

  constructor(
    code: LlmErrorCode,
    message: string,
    options: { status?: number; retriable?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'LlmError'
    this.code = code
    this.status = options.status
    this.retriable = options.retriable ?? false
  }
}

/**
 * Расход одного обращения (по всем попыткам вместе).
 * Стоимость считаем в рублях: тарифы polza.ai — в рублях за 1M токенов.
 */
export interface LlmUsage {
  promptTokens: number
  /** Часть promptTokens, которая попала в кэш префикса. */
  cachedTokens: number
  completionTokens: number
  totalTokens: number
  costRub: number
  /** Пересчёт в доллары по курсу из конфига; null — если курс не задан. */
  costUsd: number | null
  /** true — провайдер не прислал usage, токены посчитаны по символам (оценка). */
  estimated: boolean
}

/** Успешный результат. */
export interface LlmSuccess<T> {
  ok: true
  data: T
  /** Сырой текст ответа модели — для журнала и разбора ошибок. */
  raw: string
  usage: LlmUsage
  /** Сколько запросов реально ушло (1 или 2 — попытка и повтор). */
  attempts: number
  model: string
  task: string | null
}

/** Неудачный результат: приложение не падает, а получает понятную причину. */
export interface LlmFailure {
  ok: false
  error: LlmError
  usage: LlmUsage
  attempts: number
  model: string
  task: string | null
  raw: string | null
}

export type LlmResult<T> = LlmSuccess<T> | LlmFailure

/** Результат разбора ответа моделью: разбор JSON или проверка схемы. */
export type LlmParseOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; kind: 'invalid_json' | 'invalid_schema'; issues: string[] }

/** Разбор сырого ответа в нужный тип. Ошибки — списком, для повтора. */
export type LlmParser<T> = (raw: string) => LlmParseOutcome<T>

/** Параметры одного вызова. */
export interface LlmCallOptions {
  /** Метка задачи для журнала расходов: 'classify', 'rank', ... */
  task?: string
  temperature?: number
  maxTokens?: number
  /** Просить у провайдера строгий JSON (`response_format`). */
  json?: boolean
  /** Свой таймаут на вызов; по умолчанию — из конфига. */
  timeoutMs?: number
  /** Свой лимит расходов; по умолчанию — из конфига. */
  budgetRub?: number | null
  /** Отмена извне (например, пользователь закрыл экран). */
  signal?: AbortSignal
  /** Выключить повтор при невалидном JSON. */
  retryOnInvalidJson?: boolean
}