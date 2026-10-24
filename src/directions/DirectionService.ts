/**
 * DirectionService — логика направлений (задача 5, АГЕНТЫ-РАЗРАБОТКИ.md).
 *
 * Что делает:
 *   - `assign` / `assignMany` — раскладывает идеи по направлениям через
 *     промпт «КЛАССИФИКАТОР» (один вызов на идею, не больше);
 *   - `suggestNew` — предлагает имя нового направления по идеям без места;
 *   - `merge` — сливает направления, не теряя ни одной идеи;
 *   - `enforceLimits` — держит лимит 9 и убирает направления без идей.
 *
 * Правила, за которые сервис отвечает:
 *   1. при `confidence < 0.5` направление НЕ присваивается — идея остаётся
 *      без направления (порог накладывает `classifyIdea` из `src/ai`);
 *   2. ошибка модели, обрыв сети или отсутствие ключа НЕ теряют идею:
 *      запись в базе просто не меняется;
 *   3. расход в рублях возвращается наружу — экран обязан его показать.
 *
 * Модель зовётся только по действию пользователя: фоновых вызовов здесь нет.
 */

import {
  buildDirectionNamerMessages,
  classifyIdea,
  createLlmClient,
  DIRECTION_CONFIDENCE_THRESHOLD,
  emptyUsage,
  type LlmClient,
  type MetaStore,
} from '../ai'
import {
  directionStore as defaultDirectionStore,
  ideaRepository as defaultIdeaRepository,
  materialRepository as defaultMaterialRepository,
  type Direction,
  type DirectionStore,
  type Idea,
  type IdeaRepository,
  type Material,
} from '../data'
import { MAX_DIRECTIONS, bestMatch, busiest, findByName, ideaText, normalizeName } from './logic'
import { metaStore } from './meta'
import { parseDirectionSuggestion } from './suggest'
import type {
  AssignManyResult,
  AssignOptions,
  AssignOutcome,
  AssignmentProgress,
  AssignStopReason,
  DirectionServiceOptions,
  EnforceLimitsResult,
  IdeaMaterialsSource,
  MergeResult,
  SuggestNewResult,
} from './types'

/** Прогресс пакетной обработки: «разложено N из M» и потраченные рубли. */
export interface AssignManyOptions extends AssignOptions {
  onProgress?: (progress: AssignmentProgress) => void
}

/** Пустой итог — заготовка, чтобы не повторять поля в каждой ветке. */
function emptyOutcome(ideaId: string): AssignOutcome {
  return {
    idea_id: ideaId,
    status: 'failed',
    direction_id: null,
    direction_name: null,
    suggested_direction: null,
    created_direction: false,
    confidence: null,
    usage: emptyUsage(),
    costRub: 0,
    error_code: null,
    error_message: null,
    reason: '',
    requests: 0,
  }
}

/** Текст ошибки для журнала и экрана. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class DirectionService {
  private readonly ideas: IdeaRepository
  private readonly directions: DirectionStore
  private readonly materials: IdeaMaterialsSource
  private readonly store: MetaStore
  private readonly clientSource: () => Promise<LlmClient>

  /** Максимум направлений: по умолчанию 9. */
  readonly maxDirections: number

  constructor(options: DirectionServiceOptions = {}) {
    this.ideas = options.ideas ?? defaultIdeaRepository
    this.directions = options.directions ?? defaultDirectionStore
    this.materials = options.materials ?? defaultMaterialRepository
    this.store = options.store ?? metaStore
    this.maxDirections = Math.max(1, Math.trunc(options.maxDirections ?? MAX_DIRECTIONS))

    // Клиент собирается заново перед каждой обработкой: пользователь мог
    // только что вставить новый ключ, а старый конфиг уже прочитан.
    const client = options.client
    if (typeof client === 'function') {
      this.clientSource = client
    } else if (client) {
      this.clientSource = () => Promise.resolve(client)
    } else {
      this.clientSource = () => createLlmClient({ store: this.store })
    }
  }

  /**
   * Текст идеи вместе с текстом её материалов: расшифровки речи, OCR, текст
   * ссылок. Материалы читаются здесь, а не в `ideaText`: та функция чистая
   * и в базу не ходит.
   *
   * Сбой чтения материалов не отменяет разбор — тогда классифицируем
   * по заголовку и телу, как раньше: идея важнее расшифровки.
   */
  private async textFor(idea: Idea): Promise<string> {
    let materials: Material[] = []
    try {
      materials = await this.materials.listByIdea(idea.id)
    } catch {
      materials = []
    }
    return ideaText(idea, materials)
  }

  /**
   * Контракт задачи 5: классифицирует идею и при уверенности возвращает
   * `direction_id`, иначе `null`. Расход и причину смотрите в `assignOne`.
   */
  async assign(idea: Idea, options: AssignOptions = {}): Promise<string | null> {
    const outcome = await this.assignOne(idea, options)
    return outcome.direction_id
  }

  /**
   * Одна идея со всеми подробностями: статус, расход, догадка модели.
   *
   * Модель вызывается ровно один раз (или ноль, если звать нечего). Любая
   * неудача возвращается как исход, а не как исключение: идея важнее разбора.
   */
  async assignOne(idea: Idea, options: AssignOptions = {}): Promise<AssignOutcome> {
    const base = emptyOutcome(idea.id)

    if (idea.status === 'deleted') {
      return { ...base, status: 'skipped', reason: 'Идея удалена — не обрабатываем.' }
    }
    if (idea.ai_opt_out && options.force !== true) {
      return { ...base, status: 'skipped', reason: 'Для идеи отключена ИИ-обработка (ai_opt_out).' }
    }
    if (idea.direction_id && options.force !== true) {
      return {
        ...base,
        status: 'already',
        direction_id: idea.direction_id,
        reason: 'Направление уже присвоено — модель не звали.',
      }
    }

    const text = await this.textFor(idea)
    if (text === '') {
      return { ...base, status: 'empty', reason: 'У идеи нет текста — классифицировать нечего.' }
    }

    let directions = options.directions ? [...options.directions] : await this.directions.list()

    const client = await this.clientSource()
    if (!client.hasKey()) {
      return {
        ...base,
        status: 'failed',
        error_code: 'no_key',
        error_message: 'Ключ polza.ai не задан.',
        reason: 'Ключ не задан — запрос к модели не отправлен.',
      }
    }

    // Единственный вызов модели на эту идею.
    const result = await classifyIdea(
      client,
      { text },
      {
        directions: directions.map((direction) => direction.name),
        signal: options.signal,
        timeoutMs: options.timeoutMs,
      },
    )
    const costRub = result.usage.costRub
    const requests = 1

    if (!result.ok) {
      return {
        ...base,
        status: 'failed',
        usage: result.usage,
        costRub,
        error_code: result.error.code,
        error_message: result.error.message,
        requests,
        reason: `Модель не ответила: ${result.error.message}`,
      }
    }

    const data = result.data
    const suggested = data.suggested_direction

    if (!data.direction_applied || !data.direction_name) {
      return {
        ...base,
        status: 'low_confidence',
        suggested_direction: suggested,
        confidence: data.confidence,
        usage: result.usage,
        costRub,
        requests,
        reason: data.low_confidence
          ? `Уверенность ${data.confidence.toFixed(2)} ниже порога ${DIRECTION_CONFIDENCE_THRESHOLD} — идея осталась без направления.`
          : 'Модель не предложила направление — идея осталась без направления.',
      }
    }

    const name = data.direction_name
    let direction = findByName(directions, name)
    let created = false

    if (!direction) {
      if (directions.length < this.maxDirections) {
        try {
          direction = await this.directions.create({ name, order: directions.length })
          created = true
          directions = await this.directions.list()
        } catch (e) {
          return {
            ...base,
            status: 'failed',
            suggested_direction: name,
            confidence: data.confidence,
            usage: result.usage,
            costRub,
            requests,
            error_message: messageOf(e),
            reason: 'Не удалось завести направление — идея осталась на месте.',
          }
        }
      } else {
        // Лимит 9: новое имя не заводим, но пытаемся положить идею
        // в самое похожее из существующих. Совсем непохожего — не трогаем.
        direction = bestMatch(directions, name)
        if (!direction) {
          return {
            ...base,
            status: 'limit',
            suggested_direction: name,
            confidence: data.confidence,
            usage: result.usage,
            costRub,
            requests,
            reason: `Направлений уже ${directions.length} (лимит ${this.maxDirections}), похожего на «${name}» нет.`,
          }
        }
      }
    }

    try {
      await this.ideas.update(idea.id, { direction_id: direction.id })
    } catch (e) {
      return {
        ...base,
        status: 'failed',
        suggested_direction: name,
        confidence: data.confidence,
        usage: result.usage,
        costRub,
        requests,
        error_message: messageOf(e),
        reason: 'Не удалось записать направление — идея осталась без него.',
      }
    }

    return {
      ...base,
      status: 'assigned',
      direction_id: direction.id,
      direction_name: direction.name,
      suggested_direction: name,
      created_direction: created,
      confidence: data.confidence,
      usage: result.usage,
      costRub,
      requests,
      reason: created
        ? `Завели направление «${direction.name}» и присвоили его идее.`
        : `Присвоили направление «${direction.name}».`,
    }
  }

  /**
   * Пакетная обработка с учётом расходов.
   *
   * Идём по идеям по очереди: каждое обращение — деньги, поэтому после каждой
   * идеи сообщаем прогресс и проверяем лимит бюджета. Идеи, до которых
   * не дошли, остаются в инбоксе как были.
   */
  async assignMany(ideas: readonly Idea[], options: AssignManyOptions = {}): Promise<AssignManyResult> {
    const list = [...ideas]
    const outcomes: AssignOutcome[] = []
    let costRub = 0
    let assigned = 0
    let lowConfidence = 0
    let skipped = 0
    let failed = 0
    let createdDirections = 0
    let withDirection = 0
    let stopped = false
    let stopReason: AssignStopReason = null
    let limits: EnforceLimitsResult | null = null

    const result = (): AssignManyResult => ({
      outcomes,
      total: list.length,
      assigned,
      lowConfidence,
      skipped,
      failed,
      createdDirections,
      costRub,
      unassigned: list.length - withDirection,
      stopped,
      stopReason,
      limits,
    })

    const client = await this.clientSource()
    if (!client.hasKey()) {
      stopped = true
      stopReason = 'no_key'
      return result()
    }

    let directions = options.directions ? [...options.directions] : await this.directions.list()
    const budget = client.config.budgetRub

    for (let index = 0; index < list.length; index += 1) {
      if (options.signal?.aborted) {
        stopped = true
        stopReason = 'aborted'
        break
      }
      if (budget !== null && budget !== undefined && client.spent >= budget) {
        stopped = true
        stopReason = 'budget'
        break
      }

      const outcome = await this.assignOne(list[index], { ...options, directions })
      outcomes.push(outcome)

      if (outcome.created_direction && outcome.direction_id) {
        createdDirections += 1
        directions = await this.directions.list()
      }
      costRub += outcome.costRub
      if (outcome.status === 'assigned' || outcome.status === 'already') withDirection += 1
      if (outcome.status === 'assigned') assigned += 1
      else if (outcome.status === 'low_confidence') lowConfidence += 1
      else if (outcome.status === 'skipped') skipped += 1
      else if (outcome.status === 'failed') failed += 1

      options.onProgress?.({ done: index + 1, total: list.length, assigned, costRub, last: outcome })

      if (outcome.status === 'failed' && outcome.error_code === 'no_key') {
        stopped = true
        stopReason = 'no_key'
        break
      }
    }

    // Лимит 9 и «в каждом направлении хотя бы одна идея» — держим без модели.
    try {
      limits = await this.enforceLimits()
    } catch {
      limits = null
    }

    return result()
  }

  /**
   * Предлагает имя нового направления по идеям без места (ПРОМПТЫ.md, 4).
   *
   * Ничего не создаёт: это кандидат для человека. Один вызов модели.
   */
  async suggestNew(
    options: { limit?: number; signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<SuggestNewResult> {
    const empty: SuggestNewResult = {
      ok: false,
      name: null,
      reasoning: '',
      confidence: null,
      usage: emptyUsage(),
      costRub: 0,
      error_code: null,
      reason: '',
    }

    let unassigned: Idea[]
    try {
      unassigned = await this.ideas.list({ direction_id: null })
    } catch (e) {
      return { ...empty, error_code: 'network', reason: `Не удалось прочитать идеи: ${messageOf(e)}` }
    }

    const limit = Math.max(1, Math.min(options.limit ?? 7, 7))
    // Расшифровки материалов идут в называтель так же, как в классификатор:
    // имя файла из Instagram о теме идеи ничего не говорит.
    const texts: string[] = []
    for (const idea of unassigned) {
      if (texts.length >= limit) break
      const text = await this.textFor(idea)
      if (text !== '') texts.push(text)
    }
    if (texts.length === 0) {
      return { ...empty, reason: 'Нет идей без направления — предлагать не из чего.' }
    }

    const client = await this.clientSource()
    if (!client.hasKey()) {
      return {
        ...empty,
        error_code: 'no_key',
        reason: 'Ключ polza.ai не задан — запрос к модели не отправлен.',
      }
    }

    const result = await client.chatJson(
      buildDirectionNamerMessages({ ideas: texts }),
      parseDirectionSuggestion,
      { task: 'direction_name', signal: options.signal, timeoutMs: options.timeoutMs, maxTokens: 128 },
    )

    if (!result.ok) {
      return {
        ...empty,
        usage: result.usage,
        costRub: result.usage.costRub,
        error_code: result.error.code,
        reason: `Модель не предложила название: ${result.error.message}`,
      }
    }

    const data = result.data
    if (data.name === null) {
      return {
        ...empty,
        reasoning: data.reasoning,
        confidence: data.confidence,
        usage: result.usage,
        costRub: result.usage.costRub,
        reason: 'Модель не увидела связи между идеями.',
      }
    }
    if (data.confidence < DIRECTION_CONFIDENCE_THRESHOLD) {
      return {
        ...empty,
        name: data.name,
        reasoning: data.reasoning,
        confidence: data.confidence,
        usage: result.usage,
        costRub: result.usage.costRub,
        reason: 'Уверенность ниже порога — имя не предлагаем.',
      }
    }

    return {
      ok: true,
      name: data.name,
      reasoning: data.reasoning,
      confidence: data.confidence,
      usage: result.usage,
      costRub: result.usage.costRub,
      error_code: null,
      reason: `Можно завести направление «${data.name}».`,
    }
  }

  /**
   * Слить направление `from` в `into`, не потеряв ни одной идеи.
   *
   * Сначала переносим идеи по одной, и только убедившись, что в `from`
   * не осталось ни одной, удаляем его. Если перенос оборвался — `from`
   * остаётся на месте, а идеи не теряются: повторный вызов доведёт дело
   * до конца (операция идемпотентна).
   */
  async merge(from: string, into: string): Promise<MergeResult> {
    const result: MergeResult = {
      ok: false,
      from,
      into,
      movedIdeas: 0,
      failedIdeas: 0,
      removed: false,
      reason: '',
    }

    const source = await this.resolveDirection(from)
    const target = await this.resolveDirection(into)
    if (!source) return { ...result, reason: `Направление «${from}» не найдено.` }
    if (!target) return { ...result, reason: `Направление «${into}» не найдено.` }
    if (source.id === target.id) {
      return { ...result, ok: true, reason: 'Это одно и то же направление — сливать нечего.' }
    }

    const ideas = await this.ideas.list({ direction_id: source.id })
    for (const idea of ideas) {
      try {
        await this.ideas.update(idea.id, { direction_id: target.id })
        result.movedIdeas += 1
      } catch {
        result.failedIdeas += 1
      }
    }

    if (result.failedIdeas === 0) {
      const left = await this.ideas.count({ direction_id: source.id })
      if (left > 0) {
        result.failedIdeas = left
      } else {
        try {
          const removal = await this.directions.remove(source.id)
          result.removed = removal.removed
        } catch {
          result.failedIdeas = 1
        }
      }
    }

    result.ok = result.failedIdeas === 0
    result.reason = result.ok
      ? `Идеи переехали в «${target.name}», направление «${source.name}» убрано.`
      : `Часть идей (${result.failedIdeas}) перенести не удалось — «${source.name}» оставлено, идеи целы.`
    return result
  }

  /**
   * Приводит направления к правилам продукта: не больше 9 и в каждом
   * хотя бы одна идея. Модель не зовётся — это бесплатная уборка.
   *
   * Лишние направления сливаются в самое похожее по названию среди
   * оставшихся (при равной похожести — в самое полное). Так при лимите
   * теряется форма, а не идеи.
   */
  async enforceLimits(): Promise<EnforceLimitsResult> {
    const result: EnforceLimitsResult = {
      ok: true,
      directionCount: 0,
      removed: [],
      merged: [],
      movedIdeas: 0,
      reason: '',
    }

    let all = await this.directions.list()
    const counts = new Map<string, number>()
    for (const direction of all) {
      counts.set(direction.id, await this.ideas.count({ direction_id: direction.id }))
    }

    // 1. Пустые направления не имеют права на существование.
    const removedIds = new Set<string>()
    for (const direction of all) {
      if ((counts.get(direction.id) ?? 0) === 0) {
        try {
          await this.directions.remove(direction.id)
          removedIds.add(direction.id)
          result.removed.push(direction.id)
        } catch {
          // Не смогли убрать — направление просто останется, идеи целы.
        }
      }
    }
    let remaining = all.filter((direction) => !removedIds.has(direction.id))

    // 2. Сверх лимита — сливаем самое маленькое в похожее.
    while (remaining.length > this.maxDirections) {
      const sorted = [...remaining].sort(
        (a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0) || a.order - b.order,
      )
      const extra = sorted[sorted.length - 1]
      const keep = sorted.slice(0, this.maxDirections)
      const into = bestMatch(keep, extra.name, 0) ?? busiest(counts, keep)
      if (!into) break

      const merged = await this.merge(extra.id, into.id)
      if (!merged.ok) {
        result.ok = false
        result.reason = merged.reason
        break
      }
      result.merged.push({ from: extra.id, into: into.id, movedIdeas: merged.movedIdeas })
      result.movedIdeas += merged.movedIdeas
      counts.set(into.id, (counts.get(into.id) ?? 0) + (counts.get(extra.id) ?? 0))
      counts.delete(extra.id)
      remaining = remaining.filter((direction) => direction.id !== extra.id)
    }

    result.directionCount = remaining.length
    if (result.ok) {
      const parts = [`Осталось направлений: ${remaining.length}.`]
      if (result.removed.length > 0) parts.push(`Убрано пустых: ${result.removed.length}.`)
      if (result.merged.length > 0) parts.push(`Слито сверх лимита: ${result.merged.length}.`)
      result.reason = parts.join(' ')
    }
    return result
  }

  /** Направление по id или по имени — удобно и из интерфейса, и из теста. */
  private async resolveDirection(reference: string): Promise<Direction | null> {
    const byId = await this.directions.get(reference)
    if (byId) return byId
    const target = normalizeName(reference)
    if (target === '') return null
    const all = await this.directions.list()
    return all.find((direction) => normalizeName(direction.name) === target) ?? null
  }
}

/** Готовый экземпляр для приложения (боевые репозитории и хранилище настроек). */
export const directionService = new DirectionService()
