/**
 * Клиент языковой модели: один интерфейс для любого OpenAI-совместимого
 * провайдера (АРХИТЕКТУРА.md, 9a — «переключение провайдера это конфиг,
 * а не переписывание кода»).
 *
 * Что здесь есть по требованиям:
 * - вызов чата в формате OpenAI (`messages`, `model`, `response_format`);
 * - таймаут запроса и отмена через AbortController;
 * - ровно ОДИН повтор при невалидном JSON или сетевой ошибке, затем `failed`
 *   (АРХИТЕКТУРА.md, 11: «не ретраить бесконечно — это деньги»);
 * - учёт токенов и стоимости вызова, стоимость возвращается в результате;
 * - понятные ошибки: нет ключа, нет сети, таймаут, плохой ответ.
 *
 * Сеть клиент не трогает напрямую: `fetch` можно подменить в тестах.
 */

import {
  costOfTokens,
  estimateTokens,
  hasApiKey,
  MAX_RETRIES,
  type LlmConfig,
} from './config'
import {
  LlmError,
  type LlmCallOptions,
  type LlmFailure,
  type LlmMessage,
  type LlmParseOutcome,
  type LlmParser,
  type LlmResult,
  type LlmUsage,
} from './types'

/** Событие расхода — для CostService и журнала `llm_call` (МЕТРИКИ.md). */
export interface LlmUsageEvent extends LlmUsage {
  task: string | null
  model: string
}

/** Внешние зависимости: подменяются в тестах, в бою — значения по умолчанию. */
export interface LlmClientDeps {
  /** Подмена сети: в тестах сюда приходит своя функция. */
  fetch?: typeof fetch
  /** Куда отдавать расход каждого вызова. */
  onUsage?: (event: LlmUsageEvent) => void
  /** Пауза перед повтором; в тестах — нулевая. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

/** Минимум того, что мы читаем из ответа OpenAI-совместимого API. */
interface OpenAiChatPayload {
  model?: string
  choices?: Array<{
    message?: {
      content?: unknown
      /** Рассуждающие модели отдают «размышление» отдельным полем. */
      reasoning_content?: unknown
    }
    text?: unknown
    /** `length` — токенов не хватило; частая причина пустого ответа. */
    finish_reason?: unknown
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
  }
  error?: { message?: string; type?: string }
}

interface RequestOutcome {
  raw: string
  usage: LlmUsage
  model: string
}

export function emptyUsage(): LlmUsage {
  return {
    promptTokens: 0,
    cachedTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    costRub: 0,
    costUsd: null,
    estimated: false,
  }
}

/**
 * Готовый неудачный результат без обращения к сети: нужен там, где запрос
 * вообще не имеет смысла (например, пустой текст идеи).
 */
export function failureResult(
  error: LlmError,
  context: { model: string; task?: string | null; attempts?: number; raw?: string | null },
): LlmFailure {
  return {
    ok: false,
    error,
    usage: emptyUsage(),
    attempts: context.attempts ?? 0,
    model: context.model,
    task: context.task ?? null,
    raw: context.raw ?? null,
  }
}

/**
 * Складывает расход нескольких попыток.
 * `costUsd` здесь не считается: он пересчитывается один раз в конце
 * из суммы `costRub` (см. `finalizeUsage`), иначе нулевая «пустая» запись
 * обнуляла бы признак «курс не задан».
 */
function addUsage(left: LlmUsage, right: LlmUsage): LlmUsage {
  return {
    promptTokens: left.promptTokens + right.promptTokens,
    cachedTokens: left.cachedTokens + right.cachedTokens,
    completionTokens: left.completionTokens + right.completionTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    costRub: left.costRub + right.costRub,
    costUsd: null,
    estimated: left.estimated || right.estimated,
  }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Считает расход: из `usage` провайдера, а если его нет — по символам (оценка). */
function usageFromResponse(
  payload: OpenAiChatPayload,
  promptText: string,
  completionText: string,
  config: LlmConfig,
): LlmUsage {
  const promptTokens = numberOrNull(payload.usage?.prompt_tokens)
  const completionTokens = numberOrNull(payload.usage?.completion_tokens)
  const cachedTokens = Math.max(numberOrNull(payload.usage?.prompt_tokens_details?.cached_tokens) ?? 0, 0)
  const estimated = promptTokens === null || completionTokens === null
  const prompt = promptTokens ?? estimateTokens(promptText)
  const completion = completionTokens ?? estimateTokens(completionText)
  const total = numberOrNull(payload.usage?.total_tokens) ?? prompt + completion
  const { costRub, costUsd } = costOfTokens(
    { promptTokens: prompt, cachedTokens, completionTokens: completion },
    config.pricing,
    config.usdRate,
  )
  return {
    promptTokens: prompt,
    cachedTokens,
    completionTokens: completion,
    totalTokens: total,
    costRub,
    costUsd,
    estimated,
  }
}

/** Короткий хвост тела ответа — для понятного текста ошибки. */
function shortBody(text: string, limit = 200): string {
  const compact = (text ?? '').replace(/\s+/g, ' ').trim()
  return compact.length > limit ? `${compact.slice(0, limit)}…` : compact
}

/** Ошибка от провайдера: понятный текст и решение «повторять или нет». */
function httpError(status: number, body: string): LlmError {
  const tail = shortBody(body)
  if (status === 401 || status === 403) {
    // Текст провайдера обязательно показываем: у polza.ai 403 приходит не
    // только на плохой ключ, но и на неизвестную модель — без ответа сервера
    // это выглядит как «проверьте ключ» и уводит в сторону. Именно так
    // потерялся целый вечер на модели без префикса `deepseek/`.
    return new LlmError(
      'http',
      `Запрос отклонён провайдером (${status}). ${tail || 'Проверьте ключ и название модели в настройках.'}`,
      { status, retriable: false, cause: body },
    )
  }
  if (status === 404) {
    return new LlmError('http', `Адрес или модель не найдены (404). Проверьте базовый URL и название модели.`, {
      status,
      retriable: false,
    })
  }
  if (status === 429) {
    return new LlmError('rate_limit', `Провайдер ограничил частоту запросов (429). Попробую ещё раз позже.`, {
      status,
      retriable: true,
    })
  }
  if (status >= 500) {
    return new LlmError('http', `Сервис модели недоступен (${status}). ${tail}`, {
      status,
      retriable: true,
    })
  }
  return new LlmError('http', `Запрос отклонён (${status}): ${tail || 'без пояснений'}`, {
    status,
    retriable: false,
  })
}

/** Текст второго запроса: что именно не так и что вернуть. */
function correctionMessage(outcome: Extract<LlmParseOutcome<unknown>, { ok: false }>): string {
  const reasons = outcome.issues.slice(0, 5).join('; ') || 'неизвестная причина'
  return `Ответ не соответствует схеме: ${reasons}.\nВерни ТОЛЬКО валидный JSON по схеме из системного сообщения. Без markdown, без пояснений.`
}

function toLlmError(error: unknown): LlmError {
  if (error instanceof LlmError) return error
  const message = error instanceof Error ? error.message : String(error)
  return new LlmError('network', `Сбой обращения к модели: ${message}`, {
    retriable: true,
    cause: error,
  })
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Клиент чата. Один экземпляр на приложение: он помнит суммарный расход,
 * чтобы работал лимит из настроек.
 */
export class LlmClient {
  private readonly settings: LlmConfig
  private readonly fetchImpl: typeof fetch
  private readonly onUsage?: (event: LlmUsageEvent) => void
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  private spentRub = 0

  constructor(config: LlmConfig, deps: LlmClientDeps = {}) {
    this.settings = config
    const fetchImpl = deps.fetch ?? (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined)
    if (!fetchImpl) {
      throw new LlmError('network', 'В этой среде недоступен fetch: обратиться к модели нельзя.', {
        retriable: false,
      })
    }
    this.fetchImpl = fetchImpl
    this.onUsage = deps.onUsage
    this.sleep = deps.sleep ?? defaultSleep
  }

  /** Конфиг, с которым работает клиент (ключ здесь есть — не логировать целиком). */
  get config(): LlmConfig {
    return this.settings
  }

  /** Сколько уже потрачено этим клиентом, ₽. */
  get spent(): number {
    return this.spentRub
  }

  /** Есть ли ключ: если нет — запрос не уходит и возвращается понятная ошибка. */
  hasKey(): boolean {
    return hasApiKey(this.settings)
  }

  /**
   * Обычный вызов чата. Повторы — только при сетевой ошибке, таймауте или 5xx.
   * Ответ возвращается как есть, без разбора JSON.
   */
  async chat(messages: readonly LlmMessage[], options: LlmCallOptions = {}): Promise<LlmResult<string>> {
    return this.execute<string>(messages, options, (raw) => ({ ok: true, value: raw }), false)
  }

  /**
   * Вызов чата с разбором JSON. Невалидный JSON или несоответствие схеме —
   * повод для ОДНОГО повтора с уточнением «верни строго JSON по схеме»,
   * после чего результат помечается `failed`.
   */
  async chatJson<T>(
    messages: readonly LlmMessage[],
    parse: LlmParser<T>,
    options: LlmCallOptions = {},
  ): Promise<LlmResult<T>> {
    return this.execute<T>(
      messages,
      { ...options, json: options.json ?? true },
      parse,
      options.retryOnInvalidJson !== false,
    )
  }

  /** Общий цикл: попытка → разбор → один повтор → результат. */
  private async execute<T>(
    baseMessages: readonly LlmMessage[],
    options: LlmCallOptions,
    parse: LlmParser<T>,
    retryOnInvalidJson: boolean,
  ): Promise<LlmResult<T>> {
    const task = options.task ?? null
    const maxAttempts = 1 + Math.min(Math.max(this.settings.retries, 0), MAX_RETRIES)
    let messages: LlmMessage[] = [...baseMessages]
    let attempts = 0
    let usage = emptyUsage()
    let lastRaw: string | null = null
    let lastError: LlmError | null = null
    let model = this.settings.model

    // Проверки до сети: нет ключа, исчерпан лимит, запрос уже отменён.
    // Здесь запросов ноль, поэтому и попыток ноль — вызывающему коду это важно.
    const preflight = this.preflight(options)
    if (preflight) {
      return { ok: false, error: preflight, usage, attempts: 0, model, task, raw: null }
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      attempts = attempt
      try {
        const response = await this.request(messages, options)
        model = response.model
        lastRaw = response.raw
        usage = addUsage(usage, response.usage)
        this.registerSpend(response.usage, task, response.model)

        const parsed = parse(response.raw)
        if (parsed.ok) {
          return {
            ok: true,
            data: parsed.value,
            raw: response.raw,
            usage: this.finalizeUsage(usage),
            attempts,
            model,
            task,
          }
        }

        lastError = new LlmError(
          parsed.kind,
          parsed.kind === 'invalid_json'
            ? `Модель вернула не JSON: ${parsed.issues[0] ?? 'нет пояснений'}`
            : `Ответ модели не соответствует схеме: ${parsed.issues.slice(0, 3).join('; ')}`,
          { retriable: true },
        )
        if (!retryOnInvalidJson || attempt === maxAttempts) break

        // Второй (и последний) запрос: показываем модели её ответ и просим
        // строгий JSON по схеме (АРХИТЕКТУРА.md, 11).
        messages = [
          ...messages,
          { role: 'assistant', content: response.raw },
          { role: 'user', content: correctionMessage(parsed) },
        ]
        await this.pause(options)
        continue
      } catch (error) {
        const llmError = toLlmError(error)
        lastError = llmError
        if (!llmError.retriable || attempt === maxAttempts) break
        await this.pause(options)
        continue
      }
    }

    return {
      ok: false,
      error: lastError ?? new LlmError('network', 'Не удалось обратиться к модели.', { retriable: true }),
      usage: this.finalizeUsage(usage),
      attempts,
      model,
      task,
      raw: lastRaw,
    }
  }

  /**
   * Проверки, при которых запрос в сеть не уходит вообще.
   * Возвращает готовую ошибку или null, если можно обращаться к модели.
   */
  private preflight(options: LlmCallOptions): LlmError | null {
    const config = this.settings
    if (!hasApiKey(config)) {
      return new LlmError(
        'no_key',
        'Не задан ключ API языковой модели. Добавьте его в настройках — запрос не отправлен.',
        { retriable: false },
      )
    }
    const budget = options.budgetRub === undefined ? config.budgetRub : options.budgetRub
    if (budget !== null && budget !== undefined && this.spentRub >= budget) {
      return new LlmError(
        'budget',
        `Достигнут лимит расходов на модель (${budget} ₽). Обработка приостановлена, идеи не потеряны.`,
        { retriable: false },
      )
    }
    if (options.signal?.aborted) {
      return new LlmError('aborted', 'Запрос отменён до отправки.', { retriable: false })
    }
    return null
  }

  /** Пересчитывает `costUsd` по итоговой сумме — один раз на весь вызов. */
  private finalizeUsage(usage: LlmUsage): LlmUsage {
    const rate = this.settings.usdRate
    return {
      ...usage,
      costUsd: rate && rate > 0 ? usage.costRub / rate : null,
    }
  }

  /** Один сетевой запрос: ключ, лимит, таймаут, отмена, разбор ответа. */
  private async request(messages: readonly LlmMessage[], options: LlmCallOptions): Promise<RequestOutcome> {
    const config = this.settings
    const preflight = this.preflight(options)
    if (preflight) throw preflight

    const body: Record<string, unknown> = {
      model: config.model,
      messages: messages.map((message) => ({ role: message.role, content: message.content })),
      temperature: options.temperature ?? config.temperature,
      max_tokens: options.maxTokens ?? config.maxTokens,
      stream: false,
    }
    // Без этого рассуждающая модель тратит бюджет на «размышление» и
    // возвращает пустой ответ — так падала проверка ключа с её 8 токенами.
    if (config.reasoningEffort) body.reasoning_effort = config.reasoningEffort
    if (options.json) body.response_format = { type: 'json_object' }

    const controller = new AbortController()
    const timeoutMs = options.timeoutMs ?? config.timeoutMs
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    const externalSignal = options.signal
    const onExternalAbort = () => controller.abort()
    if (externalSignal) externalSignal.addEventListener('abort', onExternalAbort)

    let response: Response
    let text = ''
    try {
      response = await this.fetchImpl(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      text = await response.text()
    } catch (cause) {
      if (timedOut) {
        throw new LlmError('timeout', `Модель не ответила за ${timeoutMs} мс. Попробую ещё раз.`, {
          retriable: true,
          cause,
        })
      }
      if (externalSignal?.aborted) {
        throw new LlmError('aborted', 'Запрос отменён.', { retriable: false, cause })
      }
      throw new LlmError('network', 'Нет связи с сервисом модели. Проверьте интернет и попробуйте позже.', {
        retriable: true,
        cause,
      })
    } finally {
      clearTimeout(timer)
      externalSignal?.removeEventListener('abort', onExternalAbort)
    }

    if (!response.ok) throw httpError(response.status, text)

    let payload: OpenAiChatPayload
    try {
      payload = JSON.parse(text) as OpenAiChatPayload
    } catch (cause) {
      throw new LlmError('invalid_json', 'Провайдер вернул ответ, который не является JSON.', {
        retriable: true,
        cause,
      })
    }

    if (payload?.error) {
      throw new LlmError('http', `Провайдер вернул ошибку: ${payload.error.message ?? payload.error.type ?? 'без пояснений'}`, {
        retriable: false,
      })
    }

    const choice = payload?.choices?.[0]
    const content = typeof choice?.message?.content === 'string'
      ? choice.message.content
      : typeof choice?.text === 'string'
        ? choice.text
        : ''
    if (content.trim() === '') {
      // Пустой ответ — самый неинформативный отказ: причин может быть
      // несколько, и по одному тексту их не различить. Поэтому показываем
      // и причину остановки, и сам ответ сервера: рассуждающая модель,
      // исчерпавшая бюджет токенов, выглядит именно так.
      const finish = typeof choice?.finish_reason === 'string' ? choice.finish_reason : null
      const message = choice?.message as Record<string, unknown> | undefined
      const reasoning = typeof message?.reasoning_content === 'string' ? message.reasoning_content : ''
      const parts = ['Модель вернула пустой ответ.']
      if (finish === 'length') {
        parts.push('Ответ обрезан по лимиту токенов — вероятно, они ушли на рассуждение.')
      } else if (finish) {
        parts.push(`Причина остановки: ${finish}.`)
      }
      if (reasoning) parts.push('Пришло только рассуждение, без самого ответа.')
      parts.push(`Ответ сервера: ${shortBody(text, 200)}`)
      throw new LlmError('invalid_json', parts.join(' '), { retriable: true })
    }

    const promptText = messages.map((message) => message.content).join('\n')
    return {
      raw: content,
      usage: usageFromResponse(payload, promptText, content, config),
      model: typeof payload?.model === 'string' && payload.model ? payload.model : config.model,
    }
  }

  /** Пауза перед повтором. */
  private async pause(options: LlmCallOptions): Promise<void> {
    const delay = this.settings.retryDelayMs
    if (delay <= 0) return
    try {
      await this.sleep(delay, options.signal)
    } catch {
      // Отмена во время паузы не должна превращаться в исключение:
      // следующий круг сам увидит signal.aborted.
    }
  }

  /** Учитывает расход: суммарно по клиенту и во внешний приёмник. */
  private registerSpend(usage: LlmUsage, task: string | null, model: string): void {
    this.spentRub += usage.costRub
    if (this.onUsage) {
      try {
        this.onUsage({ ...usage, task, model })
      } catch {
        // Журнал расходов не должен ломать сам вызов модели.
      }
    }
  }
}