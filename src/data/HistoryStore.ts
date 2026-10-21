/**
 * HistoryStore — журнал развилок. Только дописывание.
 *
 * Инвариант, который держит вся синхронизация проекта: **ни одна запись
 * журнала не изменяется и не удаляется**. Исправление оформляется новой
 * развилкой `reformulation` со ссылкой на предыдущую.
 *
 * Поэтому в классе сознательно НЕТ методов update и remove: их невозможно
 * вызвать, даже если очень захочется. Единственный способ поправить историю —
 * дописать ещё одну запись.
 *
 * Слияние журналов с разных устройств — объединение по id (`merge`).
 * Так как id — ULID, каждая развилка уникальна, и конфликтов не бывает.
 */

import { req, withTx } from './db'
import { mergeHistory, normalizeHistoryEntry, sortHistory } from './records'
import type { MergeOutcome } from './records'
import type { HistoryEntry, NewHistoryEntry } from './types'

export class HistoryStore {
  /**
   * Дописывает развилку. `id` и `at` можно задать (это нужно при восстановлении
   * из копии), иначе они проставляются сейчас.
   *
   * Если запись с таким `id` уже есть, она возвращается как есть —
   * повторное дописывание не создаёт дубликат.
   */
  async append(input: NewHistoryEntry): Promise<HistoryEntry> {
    return withTx('history', 'readwrite', async (tx) => {
      const store = tx.objectStore('history')
      const entry = normalizeHistoryEntry(input)
      if (input.id) {
        const existing = await req<HistoryEntry | undefined>(store.get(entry.id))
        if (existing) return existing // уже записано — не дублируем
      }
      store.put(entry)
      return entry
    })
  }

  /** Дописывает пачку развилок одной транзакцией. */
  async appendMany(inputs: readonly NewHistoryEntry[]): Promise<HistoryEntry[]> {
    if (inputs.length === 0) return []
    return withTx('history', 'readwrite', async (tx) => {
      const store = tx.objectStore('history')
      const written: HistoryEntry[] = []
      for (const input of inputs) {
        const entry = normalizeHistoryEntry(input)
        if (input.id) {
          const existing = await req<HistoryEntry | undefined>(store.get(entry.id))
          if (existing) {
            written.push(existing)
            continue
          }
        }
        store.put(entry)
        written.push(entry)
      }
      return written
    })
  }

  /** Журнал одной идеи: от старых к новым. */
  async listByIdea(ideaId: string): Promise<HistoryEntry[]> {
    const entries = await withTx('history', 'readonly', (tx) =>
      req<HistoryEntry[]>(tx.objectStore('history').index('by_idea').getAll(IDBKeyRange.only(ideaId))),
    )
    return sortHistory(entries)
  }

  /** Весь журнал: от старых к новым. Для выгрузки и разбора. */
  async listAll(): Promise<HistoryEntry[]> {
    const entries = await withTx('history', 'readonly', (tx) =>
      req<HistoryEntry[]>(tx.objectStore('history').getAll()),
    )
    return sortHistory(entries)
  }

  /** Сколько записей в журнале. */
  async count(): Promise<number> {
    return withTx('history', 'readonly', (tx) => req<number>(tx.objectStore('history').count()))
  }

  /**
   * Сливает входящий журнал с имеющимся: объединение по id.
   * Существующие записи не перетираются. Возвращает отчёт о слиянии.
   */
  async merge(entries: readonly HistoryEntry[]): Promise<MergeOutcome<HistoryEntry>> {
    return withTx('history', 'readwrite', async (tx) => {
      const store = tx.objectStore('history')
      const existing = await req<HistoryEntry[]>(store.getAll())
      const outcome = mergeHistory(existing, entries)
      const known = new Set(existing.map((entry) => entry.id))
      for (const entry of outcome.items) {
        if (!known.has(entry.id)) store.put(entry)
      }
      return outcome
    })
  }
}

/** Готовый экземпляр для приложения. */
export const historyStore = new HistoryStore()