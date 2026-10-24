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
   * Цена токенов, попавших в кэш префикса. По каталогу polza.ai она
   * дешевле входа в 12,5 раза (не в 50, как считалось раньше).
   */
  cachedInputPerMillionRub: number | null
}

/**
 * Сколько модель тратит на «размышление» до ответа (`reasoning_effort`).
 *
 * Набор значений задан провайдером. Для наших задач нужен `'none'`:
 * см. пояснение у поля `reasoningEffort` в `LlmConfig`.
 */
export type ReasoningEffort = 'max' | 'high' | 'low' | 'none'

/**
 * Тариф расшифровки речи: рублей за МИНУТУ аудио.
 *
 * Это НЕ `ModelPricing`, и подставлять его в токенную формулу нельзя:
 * у Whisper цена за минуту звука, а не за токены. Отдельный тип нужен
 * именно для того, чтобы две формы нельзя было перепутать на уровне типов
 * (ВИДЕО.md, 8.3: «рублей за минуту аудио»).
 */
export interface TranscriptionPricing {
  perMinuteRub: number
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
  /**
   * `reasoning_effort` — сколько модель тратит на «размышление» до ответа.
   *
   * ⚠️ **Это не тонкая настройка, а условие работоспособности.**
   * `deepseek/deepseek-v4.1-flash` — рассуждающая модель: у неё
   * `default_enabled: true` и `default_effort: "high"`. Она тратит токены
   * на внутреннее рассуждение **до** видимого ответа, и при малом
   * `max_tokens` (например 8 на проверке ключа) бюджет кончается раньше
   * ответа — приходит **пустой `content`**.
   *
   * `'none'` выключает рассуждение: наши задачи (разбор идеи, проверка
   * ключа) не требуют глубоких выводов, а платить за них и ждать — незачем.
   *
   * `null` — параметр не отправляется вовсе (для моделей без поддержки).
   */
  reasoningEffort: ReasoningEffort | null
  /** Лимит расходов, ₽. null — без лимита. */
  budgetRub: number | null
  /** Курс рубля к доллару для справочного costUsd; null — не считать. */
  usdRate: number | null
  pricing: ModelPricing
  /**
   * Модель расшифровки речи. Ключ и адрес те же, что у чата, — отличается
   * только модель: распознавание обслуживает тот же провайдер.
   */
  transcribeModel: string
  /** Тариф расшифровки — за минуту звука, а не за токены. */
  transcribePricing: TranscriptionPricing
}

/** Больше одного повтора не бывает: деньги (АРХИТЕКТУРА.md, 11). */
export const MAX_RETRIES = 1

/** Базовый URL polza.ai — OpenAI-совместимый (РЕШЕНИЯ.md). */
export const DEFAULT_BASE_URL = 'https://polza.ai/api/v1'

/**
 * Модель по умолчанию — DeepSeek V4.1 Flash (РЕШЕНИЯ.md).
 *
 * ⚠️ **Идентификатор обязан содержать префикс провайдера.** В каталоге
 * polza.ai модель называется `deepseek/deepseek-v4.1-flash`. Без префикса
 * (`deepseek-v4.1-flash`) шлюз модель не находит и отвечает **403** — а наш
 * разбор ошибок показывал это как «проверьте ключ», что сбивало с толку.
 * Проверено 24.10.2026 по открытому каталогу `GET /api/v1/models`.
 */
export const DEFAULT_MODEL = 'deepseek/deepseek-v4.1-flash'

/**
 * Тарифы `deepseek/deepseek-v4.1-flash`: **5,72047 / 17,16141 ₽ за 1M**.
 *
 * Взяты из открытого каталога polza.ai (`GET /api/v1/models`), а не с
 * витрины: витрина показывает округлённое «от 5,78 / от 17,35».
 *
 * **Кэш префикса — 0,45764 ₽**, то есть вход дешевле в 12,5 раза, а не
 * в 50, как предполагалось раньше. Прежняя оценка «вход / 50» занижала
 * стоимость кэша вчетверо.
 */
export const DEEPSEEK_FLASH_PRICING: ModelPricing = {
  inputPerMillionRub: 5.72047,
  outputPerMillionRub: 17.16141,
  cachedInputPerMillionRub: 0.45764,
}

/**
 * Модель расшифровки по умолчанию — **GigaAM v3** (решение автора, 24.10.2026).
 *
 * Это **русская** модель распознавания речи (AI-Sage), сделанная для
 * русского языка, а не обученная на сотне языков, как Whisper. В бытовом
 * сценарии речь русская, поэтому она и стоит по умолчанию.
 *
 * Идентификаторы в каталоге polza.ai идут с префиксом поставщика:
 * `ai-sage/gigaam-v3`. Whisper при этом остаётся доступной заменой —
 * достаточно поменять значение в хранилище, без правки кода.
 */
export const DEFAULT_TRANSCRIBE_MODEL = 'ai-sage/gigaam-v3'

/**
 * Тариф GigaAM v3: **0,24171 ₽ за минуту** звука (каталог polza.ai).
 */
export const GIGAAM_V3_PRICING: TranscriptionPricing = { perMinuteRub: 0.24171 }

/**
 * Тариф Whisper Large V3: **0,108 ₽ за минуту** звука.
 *
 * Точно из каталога (`GET /api/v1/models`, поле `stt_per_minute`), а не с
 * витрины, где показывалось округлённое «0,11».
 *
 * **Соседние модели того же класса** — на случай проверки на бытовой речи:
 * `openai/whisper-large-v3-turbo` 0,048; `ai-sage/gigaam-v3` 0,24171
 * (русская модель, сейчас по умолчанию); `nvidia/parakeet-tdt-0.6b-v3` 0,108.
 *
 * Провайдер тарифицирует распознавание посекундно по длительности аудио,
 * поэтому наша цена за минуту — та же ставка, приведённая к минуте.
 */
export const WHISPER_LARGE_V3_PRICING: TranscriptionPricing = { perMinuteRub: 0.108 }

export const DEFAULT_TIMEOUT_MS = 30_000
export const DEFAULT_RETRY_DELAY_MS = 400
/**
 * Предел длины ответа.
 *
 * ⚠️ **Ставим с запасом, потому что платим за фактические токены, а не за
 * предел.** Если модель уложится в 200 токенов — заплатим за 200, сколько бы
 * ни стояло здесь. А вот если предел мал, ответ **обрежется** и JSON не
 * разберётся: именно так приходил пустой ответ при `max_tokens: 8`.
 *
 * По замерам пользователя модель тратит сотни токенов на рассуждение даже
 * при `reasoning_effort: 'none'` (проверка ключа стоила 0,0029 ₽ ≈ 169
 * токенов на ответ в одно слово). Поэтому 512 — слишком впритык: при
 * разборе идеи ответ уже упирался в предел. 2048 даёт запас, а стоит
 * максимум 0,035 ₽ за запрос, если модель и правда столько напишет.
 */
export const DEFAULT_MAX_TOKENS = 2048
export const DEFAULT_USD_RATE = 80

/**
 * Рассуждение выключено.
 *
 * Не «на всякий случай», а потому что с ним продукт не работает:
 * у `deepseek/deepseek-v4.1-flash` рассуждение включено по умолчанию на
 * усилие «high», и оно съедает бюджет токенов раньше видимого ответа.
 * Проверка ключа (8 токенов) возвращала пустую строку именно поэтому.
 */
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'none'

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
  reasoningEffort: DEFAULT_REASONING_EFFORT,
  budgetRub: null,
  usdRate: DEFAULT_USD_RATE,
  pricing: DEEPSEEK_FLASH_PRICING,
  transcribeModel: DEFAULT_TRANSCRIBE_MODEL,
  transcribePricing: GIGAAM_V3_PRICING,
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
  /** `reasoning_effort`: насколько модель «думает» перед ответом. */
  reasoningEffort: 'llm.reasoning_effort',
  /** Модель расшифровки речи (Whisper) — тот же ключ и адрес, другая модель. */
  transcribeModel: 'llm.transcribe_model',
  /** Цена расшифровки: рублей за минуту звука (не за токены). */
  transcribePriceRub: 'llm.transcribe_price_rub',
} as const

/** Собирает конфиг из значений по умолчанию и переопределений. */
export function createLlmConfig(overrides: Partial<LlmConfig> = {}): LlmConfig {
  const config: LlmConfig = {
    ...DEFAULT_CONFIG,
    ...overrides,
    pricing: { ...DEFAULT_CONFIG.pricing, ...(overrides.pricing ?? {}) },
    // Тариф расшифровки — своя форма (за минуту), поэтому и своё слияние:
    // подставить сюда токенные цены нельзя даже случайно.
    transcribePricing: {
      ...DEFAULT_CONFIG.transcribePricing,
      ...(overrides.transcribePricing ?? {}),
    },
  }
  // Инварианты, которые нельзя нарушить даже через конфиг.
  config.baseUrl = config.baseUrl.replace(/\/+$/, '')
  if (config.transcribeModel.trim() === '') {
    config.transcribeModel = DEFAULT_TRANSCRIBE_MODEL
  }
  if (
    !Number.isFinite(config.transcribePricing.perMinuteRub) ||
    config.transcribePricing.perMinuteRub < 0
  ) {
    config.transcribePricing = { ...DEFAULT_CONFIG.transcribePricing }
  }
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
 * Читает `reasoning_effort` из хранилища.
 *
 * Отсутствие записи — значение по умолчанию (`'none'`).
 * Пустая строка — «не отправлять параметр вовсе» (`null`): так отключается
 * модель, которая `reasoning_effort` не поддерживает.
 * Незнакомое значение игнорируется, чтобы опечатка не сломала запросы.
 */
function readReasoningEffort(value: unknown): ReasoningEffort | null {
  if (value === '') return null
  if (value === null || value === undefined) return DEFAULT_REASONING_EFFORT
  const parsed = readString(value)
  if (parsed === null) return DEFAULT_REASONING_EFFORT
  return REASONING_EFFORTS.includes(parsed as ReasoningEffort)
    ? (parsed as ReasoningEffort)
    : DEFAULT_REASONING_EFFORT
}

/** Допустимые усилия рассуждения — ровно те, что принимает провайдер. */
const REASONING_EFFORTS: readonly string[] = ['max', 'high', 'low', 'none']

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
    const [
      apiKey,
      baseUrl,
      model,
      timeoutMs,
      budgetRub,
      reasoningEffort,
      transcribeModel,
      transcribePriceRub,
    ] = await Promise.all([
      Promise.resolve(store.get(META_KEYS.apiKey)).catch(() => undefined),
      Promise.resolve(store.get(META_KEYS.baseUrl)).catch(() => undefined),
      Promise.resolve(store.get(META_KEYS.model)).catch(() => undefined),
      Promise.resolve(store.get(META_KEYS.timeoutMs)).catch(() => undefined),
      Promise.resolve(store.get(META_KEYS.budgetRub)).catch(() => undefined),
      Promise.resolve(store.get(META_KEYS.reasoningEffort)).catch(() => undefined),
      Promise.resolve(store.get(META_KEYS.transcribeModel)).catch(() => undefined),
      Promise.resolve(store.get(META_KEYS.transcribePriceRub)).catch(() => undefined),
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
    // Пустая строка в хранилище означает «не отправлять параметр вовсе»:
    // это нужно для моделей, которые `reasoning_effort` не поддерживают.
    fromStore.reasoningEffort = readReasoningEffort(reasoningEffort)
    const transcribeName = readString(transcribeModel)
    if (transcribeName) fromStore.transcribeModel = transcribeName
    const transcribePrice = readNumber(transcribePriceRub)
    if (transcribePrice !== null) fromStore.transcribePricing = { perMinuteRub: transcribePrice }
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

/**
 * Стоимость расшифровки: длительность в секундах × цена за минуту.
 *
 * Неизвестная (нулевая, отрицательная, не число) длительность даёт 0 ₽,
 * а не выдуманную оценку: считать деньги наугад нельзя (АРХИТЕКТУРА.md, 11).
 * Форма тарифа здесь принципиально минутная — см. `TranscriptionPricing`.
 */
export function costOfTranscription(
  durationSec: number,
  pricing: TranscriptionPricing,
): number {
  const seconds = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0
  const perMinute =
    Number.isFinite(pricing?.perMinuteRub) && pricing.perMinuteRub > 0 ? pricing.perMinuteRub : 0
  return (seconds / 60) * perMinute
}