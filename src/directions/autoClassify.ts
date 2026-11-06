/**
 * Авторазбор: модель сама раскладывает новые идеи по направлениям.
 *
 * ПРАВИЛА (одобрены автором):
 *   - раз в сутки, при открытии приложения, а не на каждое действие;
 *   - только идеи, у которых ТЕКСТ ИЗМЕНИЛСЯ с прошлой попытки: появилась
 *     расшифровка — идея снова в очереди; не изменилось — не трогаем,
 *     даже если прошлая попытка не удалась;
 *   - применяем только при уверенности 0.9 и выше И подтверждённой цитате
 *     (порог `auto` накладывает `classifyIdea`);
 *   - потолок расхода на сутки: авторазбор не должен стоить как сюрприз;
 *   - учимся ТОЛЬКО на ручных правках человека: автоматически применённая
 *     метка в уроки не попадает, иначе модель закрепляла бы свои ошибки.
 *
 * ПОЧЕМУ ХЕШ ТЕКСТА, А НЕ «ПРОБОВАЛИ ИЛИ НЕТ». Провал бывает разным: сеть
 * пропала, модель вернула мусор, текста ещё не было. Если хранить только
 * «пробовали», неудача навсегда оставила бы идею без разбора. Если хранить
 * текст — новая расшифровка сама вернёт идею в очередь, а та же самая
 * ошибка не будет оплачиваться дважды.
 */

import {
  directionStore as defaultDirectionStore,
  ideaRepository as defaultIdeaRepository,
  type Direction,
  type DirectionStore,
  type Idea,
  type IdeaRepository,
} from '../data'
import { DirectionService } from './DirectionService'
import { readMetaValue, writeMetaValue } from './meta'
import type { AssignOutcome, AssignStatus } from './types'

/** Как часто запускаем: раз в сутки. */
export const AUTO_RUN_INTERVAL_MS = 24 * 60 * 60 * 1000
/** Сколько идей пробуем за один запуск: даже если новых много, ждём. */
export const AUTO_MAX_PER_RUN = 20
/** Потолок расхода авторазбора за сутки, ₽. */
export const AUTO_DAILY_BUDGET_RUB = 10
/**
 * Версия правил. Растёт, когда меняется промпт или порог: тогда ВСЕ идеи
 * считаются «изменившимися» и получают ещё одну попытку.
 */
export const AUTO_VERSION = 1

/** Что помним про одну попытку. */
export interface AutoRecord {
  version: number
  /** Отпечаток текста, по которому разбирали. */
  hash: string
  at: string
  status: AssignStatus
  confidence: number | null
}

/** Состояние авторазбора: одно значение в `meta`. */
export interface AutoClassifyState {
  enabled: boolean
  lastRunAt: string | null
  /** День, за который считаем расход (`YYYY-MM-DD`). */
  day: string | null
  spentRub: number
  records: Record<string, AutoRecord>
}

/** Ключ в `meta`. */
const STATE_KEY = 'auto_classify'

/** Состояние по умолчанию: включено. */
export function defaultAutoState(): AutoClassifyState {
  return { enabled: true, lastRunAt: null, day: null, spentRub: 0, records: {} }
}

/** Отпечаток текста: версия + сам текст. Стабилен между запусками. */
export function autoFingerprint(text: string, version: number = AUTO_VERSION): string {
  const seed = `${version}\u0000${text}`
  let hash = 0x811c9dc5
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** Читает состояние. Битое или чужое — считаем «по умолчанию». */
export async function readAutoState(): Promise<AutoClassifyState> {
  let raw: unknown
  try {
    raw = await readMetaValue(STATE_KEY)
  } catch {
    return defaultAutoState()
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaultAutoState()
  const source = raw as Record<string, unknown>
  const records: Record<string, AutoRecord> = {}
  const rawRecords = source.records
  if (rawRecords && typeof rawRecords === 'object' && !Array.isArray(rawRecords)) {
    for (const [id, value] of Object.entries(rawRecords as Record<string, unknown>)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      const record = value as Record<string, unknown>
      if (typeof record.hash !== 'string') continue
      records[id] = {
        version: typeof record.version === 'number' ? record.version : 0,
        hash: record.hash,
        at: typeof record.at === 'string' ? record.at : '',
        status: (typeof record.status === 'string' ? record.status : 'failed') as AssignStatus,
        confidence: typeof record.confidence === 'number' ? record.confidence : null,
      }
    }
  }
  return {
    enabled: source.enabled !== false,
    lastRunAt: typeof source.lastRunAt === 'string' ? source.lastRunAt : null,
    day: typeof source.day === 'string' ? source.day : null,
    spentRub: typeof source.spentRub === 'number' && Number.isFinite(source.spentRub)
      ? Math.max(0, source.spentRub)
      : 0,
    records,
  }
}

/** Записывает состояние. */
export async function writeAutoState(state: AutoClassifyState): Promise<void> {
  await writeMetaValue(STATE_KEY, state)
}

/** Включён ли авторазбор. */
export async function isAutoClassifyEnabled(): Promise<boolean> {
  return (await readAutoState()).enabled
}

/** Включает или выключает авторазбор. */
export async function setAutoClassifyEnabled(enabled: boolean): Promise<void> {
  const state = await readAutoState()
  state.enabled = enabled
  await writeAutoState(state)
}

/**
 * Берём ли эту идею в авторазбор.
 *
 * `text` — уже собранный текст (заголовок, тело и расшифровки материалов).
 */
export function autoEligible(
  idea: Idea,
  text: string,
  state: AutoClassifyState,
  version: number = AUTO_VERSION,
): boolean {
  // Архив, удалённое и сон — решения человека, авторазбор их не трогает.
  if (idea.status === 'archived' || idea.status === 'deleted' || idea.status === 'dormant') {
    return false
  }
  if (idea.ai_opt_out) return false
  // Уже разложено — второго мнения не спрашиваем.
  if (idea.direction_id) return false
  if (text.trim() === '') return false
  const record = state.records[idea.id]
  if (!record) return true
  // Та же версия правил и тот же текст: повторять нечего, даже если провал.
  return !(record.version === version && record.hash === autoFingerprint(text, version))
}

/** Почему авторазбор не пошёл или как закончился. */
export type AutoRunReason =
  | 'disabled'
  | 'too_soon'
  | 'nothing'
  | 'budget'
  | 'done'
  | 'error'

/** Итог одного запуска: цифры для журнала и проверок. */
export interface AutoClassifyReport {
  ran: boolean
  reason: AutoRunReason
  /** Сколько идей подошло под правила. */
  considered: number
  /** Сколько раз звали модель. */
  attempted: number
  assigned: number
  lowConfidence: number
  failed: number
  /** Расход этого запуска, ₽. */
  costRub: number
  /** Потолок на сутки ещё не достигнут? */
  budgetLeftRub: number
}

/** Что можно подменить в проверках. */
export interface AutoClassifyOptions {
  ideas?: readonly Idea[]
  service?: DirectionService
  ideasRepo?: IdeaRepository
  directions?: DirectionStore
  now?: Date
  signal?: AbortSignal
  budgetRub?: number
  maxPerRun?: number
  version?: number
}

function emptyReport(reason: AutoRunReason, budgetLeftRub: number): AutoClassifyReport {
  return {
    ran: false,
    reason,
    considered: 0,
    attempted: 0,
    assigned: 0,
    lowConfidence: 0,
    failed: 0,
    costRub: 0,
    budgetLeftRub,
  }
}

/**
 * Один запуск авторазбора.
 *
 * Никогда не бросает: автоматика не должна ломать открытие приложения.
 * Возвращает отчёт, чтобы вызывающий мог перечитать список, если что-то
 * действительно разложилось.
 */
export async function runAutoClassify(
  options: AutoClassifyOptions = {},
): Promise<AutoClassifyReport> {
  const now = options.now ?? new Date()
  const version = options.version ?? AUTO_VERSION
  const maxPerRun = Math.max(1, options.maxPerRun ?? AUTO_MAX_PER_RUN)
  const budgetRub = Math.max(0, options.budgetRub ?? AUTO_DAILY_BUDGET_RUB)

  let state: AutoClassifyState
  try {
    state = await readAutoState()
  } catch {
    return emptyReport('error', budgetRub)
  }

  if (!state.enabled) return emptyReport('disabled', Math.max(0, budgetRub - state.spentRub))

  if (state.lastRunAt) {
    const last = new Date(state.lastRunAt).getTime()
    if (Number.isFinite(last) && now.getTime() - last < AUTO_RUN_INTERVAL_MS) {
      return emptyReport('too_soon', Math.max(0, budgetRub - state.spentRub))
    }
  }

  // Новый день — новый потолок.
  const day = now.toISOString().slice(0, 10)
  if (state.day !== day) {
    state.day = day
    state.spentRub = 0
  }

  const remaining = Math.max(0, budgetRub - state.spentRub)
  if (remaining <= 0) {
    await writeAutoState(state).catch(() => {})
    return emptyReport('budget', 0)
  }

  let ideas: readonly Idea[]
  try {
    ideas = options.ideas ?? (await (options.ideasRepo ?? defaultIdeaRepository).list({}))
  } catch {
    await writeAutoState(state).catch(() => {})
    return emptyReport('error', remaining)
  }

  const service = options.service ?? new DirectionService()
  const report: AutoClassifyReport = {
    ran: true,
    reason: 'nothing',
    considered: 0,
    attempted: 0,
    assigned: 0,
    lowConfidence: 0,
    failed: 0,
    costRub: 0,
    budgetLeftRub: remaining,
  }

  let stoppedByBudget = false
  for (const idea of ideas) {
    if (report.attempted >= maxPerRun) break
    if (options.signal?.aborted) break

    let text: string
    try {
      text = await service.textFor(idea)
    } catch {
      continue
    }
    if (!autoEligible(idea, text, state, version)) continue
    report.considered += 1

    if (state.spentRub >= budgetRub) {
      stoppedByBudget = true
      break
    }

    let outcome: AssignOutcome
    try {
      outcome = await service.assignOne(idea, { mode: 'auto', signal: options.signal })
    } catch (e) {
      // Сервис обычно возвращает исход, а не бросает; но автоматика
      // обязана пережить и это.
      report.failed += 1
      state.records[idea.id] = {
        version,
        hash: autoFingerprint(text, version),
        at: now.toISOString(),
        status: 'failed',
        confidence: null,
      }
      await writeAutoState(state).catch(() => {})
      continue
    }

    report.attempted += 1
    report.costRub += outcome.costRub
    state.spentRub += outcome.costRub
    state.records[idea.id] = {
      version,
      hash: autoFingerprint(text, version),
      at: now.toISOString(),
      status: outcome.status,
      confidence: outcome.confidence,
    }

    if (outcome.direction_id) report.assigned += 1
    else if (outcome.status === 'failed') report.failed += 1
    else if (outcome.status === 'low_confidence') report.lowConfidence += 1

    // Сохраняем после каждой идеи: закрытая вкладка не должна отменять
    // уже оплаченные решения.
    await writeAutoState(state).catch(() => {})
    if (state.spentRub >= budgetRub) {
      stoppedByBudget = true
      break
    }
  }

  // Сутки считаем ТОЛЬКО если реально пробовали. Иначе пустое открытие
  // съедало бы день, и идеи, добавленные после него, ждали бы следующего.
  if (report.attempted > 0) state.lastRunAt = now.toISOString()

  // Чистим память о тех, кого больше нет или кто уже разложен: иначе
  // `meta` росла бы годами.
  const alive = new Set(ideas.filter((idea) => !idea.direction_id).map((idea) => idea.id))
  for (const id of Object.keys(state.records)) {
    if (!alive.has(id)) delete state.records[id]
  }
  await writeAutoState(state).catch(() => {})

  report.reason = stoppedByBudget
    ? 'budget'
    : report.attempted === 0
      ? 'nothing'
      : 'done'
  report.budgetLeftRub = Math.max(0, budgetRub - state.spentRub)
  return report
}

/** Сколько потрачено сегодня и сколько осталось — для экрана настроек. */
export async function autoBudgetStatus(
  now: Date = new Date(),
  budgetRub: number = AUTO_DAILY_BUDGET_RUB,
): Promise<{ spentRub: number; leftRub: number; budgetRub: number }> {
  const state = await readAutoState()
  const day = now.toISOString().slice(0, 10)
  const spent = state.day === day ? state.spentRub : 0
  return {
    spentRub: spent,
    leftRub: Math.max(0, budgetRub - spent),
    budgetRub,
  }
}
