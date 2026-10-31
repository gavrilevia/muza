/**
 * Журнал расходов: сколько потрачено, на что и сколько пришло из кэша.
 *
 * Зачем отдельный журнал, если цена показывается после каждого действия:
 * **по одной цифре нельзя решить, что улучшать**. Видно «0,01 ₽», но не
 * видно, из чего она сложилась — а сложиться она может очень по-разному:
 *
 * - если промпт **попал в кэш**, он стоит в 12 раз дешевле;
 * - если нет — платим как за обычный текст, и это втрое дороже;
 * - а иногда дороже всего оказывается не промпт, а **содержимое идеи**:
 *   длинная расшифровка ролика весит больше половины запроса.
 *
 * Поэтому пишем не только сумму, но и **токены по частям**: сколько всего,
 * сколько из кэша, сколько в ответе. По этим числам уже можно судить,
 * окупается ли усложнение промпта.
 *
 * Хранится в том же месте, что настройки, — отдельного хранилища не заводим:
 * это несколько чисел, а не данные человека.
 */
import { readMetaValue, writeMetaValue } from './meta'

/** Одна запись: один запрос к модели. */
export interface ExpenseEntry {
  at: string
  /** Для чего звали: разбор, подбор, расшифровка, имя направления. */
  task: string
  model: string
  promptTokens: number
  /** Сколько из `promptTokens` взято из кэша — это и есть предмет анализа. */
  cachedTokens: number
  completionTokens: number
  /** Сколько из ответа ушло на размышление. Ноль — модель не думала. */
  reasoningTokens: number
  costRub: number
}

/** Ключ в настройках. */
const KEY = 'expense_log'

/** Сколько записей храним: хватает для анализа, но не пухнет бесконечно. */
const MAX_ENTRIES = 500

/**
 * Подписчики: журнал на экране должен обновляться САМ.
 *
 * Без этого он читал данные один раз при открытии и не замечал новых трат —
 * то есть показывал пустоту сразу после того, как деньги потрачены.
 */
const listeners = new Set<() => void>()

/** Сообщать о новой записи. Возвращает функцию отписки. */
export function onExpenseRecorded(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Дописывает запись. Никогда не бросает: расходы не важнее самой работы. */
export async function recordExpense(entry: ExpenseEntry): Promise<void> {
  try {
    const current = await readExpenses()
    const next = [...current, entry].slice(-MAX_ENTRIES)
    await writeMetaValue(KEY, next)
    for (const listener of listeners) {
      try {
        listener()
      } catch {
        /* подписчик не важнее запроса */
      }
    }
  } catch {
    /* журнал — не повод ломать запрос */
  }
}

/** Все записи журнала, старые вперёд. */
export async function readExpenses(): Promise<ExpenseEntry[]> {
  try {
    const raw = await readMetaValue(KEY)
    if (!Array.isArray(raw)) return []
    return raw.filter((item): item is ExpenseEntry => {
      if (typeof item !== 'object' || item === null) return false
      const entry = item as Record<string, unknown>
      return typeof entry.costRub === 'number' && typeof entry.task === 'string'
    })
  } catch {
    return []
  }
}

/** Итоги: общее и по задачам. Отдельно — доля кэша, ради неё всё и затевалось. */
export interface ExpenseSummary {
  requests: number
  promptTokens: number
  cachedTokens: number
  completionTokens: number
  reasoningTokens: number
  costRub: number
  /** Доля кэша в запросе, 0…1. Ноль означает, что кэш не работает. */
  cacheShare: number
  /** Доля размышления в ответе, 0…1. Высокая — платим за невидимую работу. */
  reasoningShare: number
  byTask: {
    task: string
    requests: number
    promptTokens: number
    cachedTokens: number
    reasoningTokens: number
    costRub: number
  }[]
}

export function summarize(entries: readonly ExpenseEntry[]): ExpenseSummary {
  let promptTokens = 0
  let cachedTokens = 0
  let completionTokens = 0
  let reasoningTokens = 0
  let costRub = 0
  const tasks = new Map<
    string,
    { requests: number; promptTokens: number; cachedTokens: number; reasoningTokens: number; costRub: number }
  >()

  for (const entry of entries) {
    promptTokens += entry.promptTokens
    cachedTokens += entry.cachedTokens
    completionTokens += entry.completionTokens
    reasoningTokens += entry.reasoningTokens ?? 0
    costRub += entry.costRub
    const bucket = tasks.get(entry.task) ?? {
      requests: 0,
      promptTokens: 0,
      cachedTokens: 0,
      reasoningTokens: 0,
      costRub: 0,
    }
    bucket.requests += 1
    bucket.promptTokens += entry.promptTokens
    bucket.cachedTokens += entry.cachedTokens
    bucket.reasoningTokens += entry.reasoningTokens ?? 0
    bucket.costRub += entry.costRub
    tasks.set(entry.task, bucket)
  }

  return {
    requests: entries.length,
    promptTokens,
    cachedTokens,
    completionTokens,
    reasoningTokens,
    costRub,
    cacheShare: promptTokens > 0 ? cachedTokens / promptTokens : 0,
    reasoningShare: completionTokens > 0 ? reasoningTokens / completionTokens : 0,
    byTask: [...tasks.entries()]
      .map(([task, bucket]) => ({ task, ...bucket }))
      .sort((a, b) => b.costRub - a.costRub),
  }
}

/** Стирает журнал: начать измерение заново. */
export async function clearExpenses(): Promise<void> {
  try {
    await writeMetaValue(KEY, [])
  } catch {
    /* нечего чистить — не беда */
  }
}
