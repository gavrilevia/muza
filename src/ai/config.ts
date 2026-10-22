/**
 * Конфигурация провайдера языковой модели.
 *
 * Главное правило: смена провайдера — это смена конфига, а не переписывание
 * кода (АРХИТЕКТУРА.md, 9a; РЕШЕНИЯ.md, раздел про polza.ai).
 *
 * Ключ API НИКОГДА не хранится в коде. Он берётся во время работы:
 * либо из хранилища `meta` в IndexedDB, либо параметром от вызывающего кода.
 */

/** Цены провайдера: рублей за 1M токенов. */
export interface ModelPricing {
  inputPerMillionRub: number
  outputPerMillionRub: number
  /**
   * Цена токенов, попавших в кэш префикса. В РЕШЕНИЯ.md указано только,
   * что кэш примерно в 50 раз дешевле входа, — поэтому по умолчанию здесь
   * оценка input / 50. Уточните по факту в личном кабинете провайдера.
   */
  cachedInputPerMillionRub: number | null
}

/** Полная конфигурация клиента. */
export interface LlmConfig {
  /** Базовый URL OpenAI-совместимого API (без слэша на конце). */
  baseUrl: string
  /** Идентификатор модели у провайдера. */
  model: string
  /** Ключ API. Пустая строка = ключа нет. В код не вшивается. */
  apiKey: string
  /** Таймаут одного запроса, мс. */
  timeoutMs: number
  /**
   * Сколько ПОВТОРОВ разрешено после первой попытки.
   * По требованию — ровно 1. Значение всегда ограничивается сверху
   * константой MAX_RETRIES, поднять его нельзя.
   */
  retries: number
  /** Пауза перед повтором, мс. */
  retryDelayMs: number
  /** Температура. 0 — чтобы модель не фантазировала. */
  temperature: number
  maxTokens: number
  /** Лимит расходов, ₽. null — без лимита. */
  budgetRub: number | null
  /** Курс рубля к доллару для справочного costUsd; null — не считать. */
  usdRate: number | null
  pricing: ModelPricing
}

/** Больше одного повтора не бывает: деньги (АРХИТЕКТУРА.md, 11). */
export const MAX_RETRIES = 1

/** Базовый URL polza.ai — OpenAI-совместимый (РЕШЕНИЯ.md). */
export const DEFAULT_BASE_URL = 'https://polza.ai/api/v1'

/**
 * Модель по умолчанию — DeepSeek Flash (РЕШЕНИЯ.md: «DeepSeek V4.1 Flash»).
 * Точный идентификатор строки зависит от каталога провайдера, поэтому это
 * конфиг: поменять можно в настройках, без правки кода.
 */
export const DEFAULT_MODEL = 'deepseek-v4.1-flash'

/**
 * Тарифы DeepSeek V4.1 Flash на polza.ai: **5,78 / 17,35 ₽ за 1M**.
 *
 * Цены взяты с витрины провайдера. Прежние 9,19 / 27,57 были из первого
 * разбора и оказались завышены в 1,6 раза — расход считался неверно.
 * «от» в витрине означает, что цена может зависеть от объёма: при
 * расхождении с личным кабинетом правится здесь, без правки кода.
 *
 * Кэш префикса: точной цены провайдер не публикует, берём вход / 50 —
 * это оценка из РЕШЕНИЯ.md, её тоже стоит уточнить по факту.
 */
export const DEEPSEEK_FLASH_PRICING: ModelPricing = {
  inputPerMillionRub: 5.78,
  outputPerMillionRub: 17.35,
  cachedInputPerMillionRub: 0.12,
}

export const DEFAULT_TIMEOUT_MS = 30_000
export const DEFAULT_RETRY_DELAY_MS = 400
export const DEFAULT_MAX_TOKENS = 512
export const DEFAULT_USD_RATE = 80

/** Конфигурация по умолчанию: безопасная, без ключа. */
export const DEFAULT_CONFIG: LlmConfig = {
  baseUrl: DEFAULT_BASE_URL,
  model: DEFAULT_MODEL,
  apiKey: '',
  timeoutMs: DEFAULT_TIMEOUT_MS,
  retries: MAX_RETRIES,
  retryDelayMs: DEFAULT_RETRY_DELAY_MS,
  temperature: 0,
  maxTokens: DEFAULT_MAX_TOKENS,
  budgetRub: null,
  usdRate: DEFAULT_USD_RATE,
  pricing: DEEPSEEK_FLASH_PRICING,
}

/**
 * Минимальный интерфейс хранилища настроек, который нужен клиенту.
 *
 * Слой данных пишет другой агент, поэтому мы НЕ импортируем `src/data/**`,
 * а описываем только то, что нам нужно. Подойдёт любая обёртка над
 * объектным хранилищем `meta` (АРХИТЕКТУРА-PWA.md, 3.3):
 *
 * ```ts
 * const store: MetaStore = {
 *   get: async (key) => (await db.read('meta', key))?.value,
 * }
 * ```
 */
export interface MetaStore {
  get(key: string): unknown | Promise<unknown>
}

/** Ключи настроек в хранилище `meta`. */
export const META_KEYS = {
  apiKey: 'llm.api_key',
  baseUrl: 'llm.base_url',
  model: 'llm.model',
  timeoutMs: 'llm.timeout_ms',
  budgetRub: 'llm.budget_rub',
} as const

/** Собирает конфиг из значений по умолчанию и переопределений. */
export function createLlmConfig(overrides: Partial<LlmConfig> = {}): LlmConfig {
  const config: LlmConfig = {
    ...DEFAULT_CONFIG,
    ...overrides,
    pricing: { ...DEFAULT_CONFIG.pricing, ...(overrides.pricing ?? {}) },
  }
  // Инварианты, которые нельзя нарушить даже через конфиг.
  config.baseUrl = config.baseUrl.replace(/\/+$/, '')
  config.retries = Math.min(Math.max(Math.trunc(config.retries), 0), MAX_RETRIES)
  if (!Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0) {
    config.timeoutMs = DEFAULT_TIMEOUT_MS
  }
  if (!Number.isFinite(config.maxTokens) || config.maxTokens <= 0) {
    config.maxTokens = DEFAULT_MAX_TOKENS
  }
  return config
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/**
 * Читает конфиг из хранилища настроек.
 *
 * Приоритет: явные переопределения → значения из `meta` → значения по умолчанию.
 * Ключ читается только из `meta` или из параметра — в коде его нет.
 */
export async function loadLlmConfig(
  store?: MetaStore,
  overrides: Partial<LlmConfig> = {},
): Promise<LlmConfig> {
  const fromStore: Partial<LlmConfig> = {}
  if (store) {
    const [apiKey, baseUrl, model, timeoutMs, budgetRub] = await Promise.all([
      Promise.resolve(store.get(META_KEYS.apiKey)).catch(() => undefined),
      Promise.resolve(store.get(META_KEYS.baseUrl)).catch(() => undefined),
      Promise.resolve(store.get(META_KEYS.model)).catch(() => undefined),
      Promise.resolve(store.get(META_KEYS.timeoutMs)).catch(() => undefined),
      Promise.resolve(store.get(META_KEYS.budgetRub)).catch(() => undefined),
    ])
    const key = readString(apiKey)
    if (key) fromStore.apiKey = key
    const url = readString(baseUrl)
    if (url) fromStore.baseUrl = url
    const modelName = readString(model)
    if (modelName) fromStore.model = modelName
    const timeout = readNumber(timeoutMs)
    if (timeout !== null) fromStore.timeoutMs = timeout
    if (budgetRub === null || budgetRub === '') fromStore.budgetRub = null
    else {
      const budget = readNumber(budgetRub)
      if (budget !== null) fromStore.budgetRub = budget
    }
  }
  const merged = createLlmConfig({ ...fromStore, ...overrides })
  // Ключ мог прийти пустой строкой в переопределениях — тогда он «не задан».
  merged.apiKey = merged.apiKey.trim()
  return merged
}

/** Есть ли ключ: без него запрос в сеть не уходит вообще. */
export function hasApiKey(config: LlmConfig): boolean {
  return config.apiKey.trim().length > 0
}

/** Копия конфига для журнала — без ключа (чтобы секрет не попал в логи). */
export function redactConfig(config: LlmConfig): LlmConfig {
  return { ...config, apiKey: config.apiKey ? '***' : '' }
}

/** Стоимость по токенам и тарифу, в рублях и долларах. */
export function costOfTokens(
  tokens: { promptTokens: number; cachedTokens: number; completionTokens: number },
  pricing: ModelPricing,
  usdRate: number | null,
): { costRub: number; costUsd: number | null } {
  const cached = Math.min(Math.max(tokens.cachedTokens, 0), Math.max(tokens.promptTokens, 0))
  const freshInput = Math.max(tokens.promptTokens - cached, 0)
  const cachedPrice = pricing.cachedInputPerMillionRub ?? pricing.inputPerMillionRub
  const costRub =
    (freshInput * pricing.inputPerMillionRub +
      cached * cachedPrice +
      Math.max(tokens.completionTokens, 0) * pricing.outputPerMillionRub) /
    1_000_000
  const costUsd = usdRate && usdRate > 0 ? costRub / usdRate : null
  return { costRub, costUsd }
}

/**
 * Оценка числа токенов по символам, когда провайдер не прислал `usage`.
 * Это именно оценка: точного токенизатора без зависимостей у нас нет.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / 3)
}