/**
 * QueueStore — очередь обработки.
 *
 * В очереди живут задачи, которые нельзя сделать мгновенно: разметить идею,
 * извлечь текст, посчитать вектор, распознать речь. Очередь переживает
 * перезагрузку страницы, поэтому она обязана быть в IndexedDB, а не в памяти.
 *
 * Поля задачи: `attempts`, `next_try_at`, `last_error`, `cost` (прозрачность
 * расходов). Повторные попытки разнесены по времени: задержка растёт
 * удвоением, чтобы упавший сервис не долбили в цикле.
 *
 * `takeDue` только читает: она показывает задачи, готовые к работе, но не
 * помечает их «взятыми». Разметку «взято» делает обработчик через `markDone`
 * или `markFailed` — так проще восстанавливаться после падения вкладки.
 */

import { StorageError, iterateIndex, req, withTx } from './db'
import { nowIso } from './records'
import { ulid } from './ulid'
import type { NewQueueItem, QueueItem, QueueStatus } from './types'

/** Базовая задержка перед повтором: одна минута. */
export const RETRY_BASE_MS = 60_000

/** Потолок задержки: сутки. */
export const RETRY_MAX_MS = 24 * 60 * 60 * 1000

/** Пауза перед попыткой: 1 мин, 2 мин, 4 мин… но не больше суток. */
export function retryDelayMs(attempts: number): number {
  const safeAttempts = Math.max(1, Math.trunc(attempts))
  const delay = RETRY_BASE_MS * 2 ** (safeAttempts - 1)
  return Math.min(delay, RETRY_MAX_MS)
}

/** Фильтр списка задач. */
export interface QueueQuery {
  status?: QueueStatus | QueueStatus[]
  idea_id?: string
  stage?: string
  limit?: number
}

/** Значение или массив значений → массив. */
function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

export class QueueStore {
  /**
   * Ставит задачу в очередь.
   *
   * Идемпотентность: если по этой идее и стадии уже есть незавершённая
   * задача, возвращается она же — повторный вызов не плодит дубликаты.
   */
  async enqueue(input: NewQueueItem): Promise<QueueItem> {
    return withTx('queue', 'readwrite', async (tx) => {
      const store = tx.objectStore('queue')
      const siblings = await req<QueueItem[]>(
        store.index('by_idea').getAll(IDBKeyRange.only(input.idea_id)),
      )
      const existing = siblings.find(
        (item) => item.stage === input.stage && item.status === 'pending',
      )
      if (existing) return existing

      const now = nowIso()
      const item: QueueItem = {
        id: ulid(),
        idea_id: input.idea_id,
        stage: input.stage,
        status: 'pending',
        attempts: 0,
        next_try_at: input.next_try_at ?? now,
        last_error: null,
        cost: input.cost ?? 0,
        created_at: now,
        updated_at: now,
      }
      store.put(item)
      return item
    })
  }

  /** Возвращает задачу по id или null. */
  async get(id: string): Promise<QueueItem | null> {
    const item = await withTx('queue', 'readonly', (tx) =>
      req<QueueItem | undefined>(tx.objectStore('queue').get(id)),
    )
    return item ?? null
  }

  /** Список задач с фильтрами; по умолчанию — от ближайшего срока. */
  async list(query: QueueQuery = {}): Promise<QueueItem[]> {
    const statuses = asArray(query.status)
    const ideaId = query.idea_id
    const items = await withTx('queue', 'readonly', (tx) => {
      const store = tx.objectStore('queue')
      return ideaId
        ? req<QueueItem[]>(store.index('by_idea').getAll(IDBKeyRange.only(ideaId)))
        : req<QueueItem[]>(store.getAll())
    })
    const filtered = items.filter((item) => {
      if (statuses.length > 0 && !statuses.includes(item.status)) return false
      if (query.stage !== undefined && item.stage !== query.stage) return false
      return true
    })
    filtered.sort((a, b) =>
      a.next_try_at === b.next_try_at ? (a.id < b.id ? -1 : 1) : a.next_try_at < b.next_try_at ? -1 : 1,
    )
    const limit = query.limit !== undefined ? Math.max(0, Math.trunc(query.limit)) : undefined
    return limit === undefined ? filtered : filtered.slice(0, limit)
  }

  /** Сколько задач (при необходимости — только в заданном статусе). */
  async count(status?: QueueStatus): Promise<number> {
    return withTx('queue', 'readonly', (tx) => {
      const store = tx.objectStore('queue')
      if (status) return req<number>(store.index('by_status').count(IDBKeyRange.only(status)))
      return req<number>(store.count())
    })
  }

  /**
   * Задачи, готовые к работе: статус `pending` и `next_try_at` не позже `now`.
   * Возвращает не больше `limit` штук, начиная с самой срочной.
   */
  async takeDue(limit = 1, now: string = nowIso()): Promise<QueueItem[]> {
    const safeLimit = Math.max(0, Math.trunc(limit))
    if (safeLimit === 0) return []

    const due: QueueItem[] = []
    await withTx('queue', 'readonly', (tx) =>
      iterateIndex<QueueItem>(
        tx,
        'queue',
        'by_next_try',
        IDBKeyRange.upperBound(now),
        (item) => {
          if (item.status === 'pending') due.push(item)
        },
      ),
    )
    // Сортировка по сроку уже обеспечена индексом, но при равных сроках
    // порядок курсора задан id — этого достаточно.
    return due.slice(0, safeLimit)
  }

  /** Задача выполнена. `cost` прибавляется к стоимости задачи. */
  async markDone(id: string, options: { cost?: number; at?: string } = {}): Promise<QueueItem> {
    return this.mutate(id, (item, now) => ({
      ...item,
      status: 'done',
      last_error: null,
      cost: item.cost + (options.cost ?? 0),
      updated_at: now,
    }), options.at)
  }

  /**
   * Задача упала.
   * `attempts` растёт, ошибка сохраняется, следующая попытка — через
   * `retryInMs` или по удвоенной задержке. `permanent: true` переводит
   * задачу в статус `failed` — её больше не возьмут автоматически.
   */
  async markFailed(
    id: string,
    error: unknown,
    options: { cost?: number; retryInMs?: number; permanent?: boolean; at?: string } = {},
  ): Promise<QueueItem> {
    return this.mutate(
      id,
      (item, now) => {
        const attempts = item.attempts + 1
        const delay = options.retryInMs ?? retryDelayMs(attempts)
        return {
          ...item,
          attempts,
          status: options.permanent ? 'failed' : 'pending',
          last_error: errorText(error),
          next_try_at: new Date(new Date(now).getTime() + delay).toISOString(),
          cost: item.cost + (options.cost ?? 0),
          updated_at: now,
        }
      },
      options.at,
    )
  }

  /** Убирает задачу совсем. Нужно для чистки завершённых. */
  async remove(id: string): Promise<boolean> {
    return withTx('queue', 'readwrite', async (tx) => {
      const store = tx.objectStore('queue')
      const existing = await req<QueueItem | undefined>(store.get(id))
      if (!existing) return false
      store.delete(id)
      return true
    })
  }

  /** Убирает завершённые задачи старше `olderThanMs` — чтобы база не пухла. */
  async purgeDone(olderThanMs: number, now: string = nowIso()): Promise<number> {
    const threshold = new Date(new Date(now).getTime() - olderThanMs).toISOString()
    return withTx('queue', 'readwrite', async (tx) => {
      const store = tx.objectStore('queue')
      const done = await req<QueueItem[]>(
        store.index('by_status').getAll(IDBKeyRange.only('done')),
      )
      let removed = 0
      for (const item of done) {
        if (item.updated_at < threshold) {
          store.delete(item.id)
          removed++
        }
      }
      return removed
    })
  }

  /** Общая механика изменения задачи в одной транзакции. */
  private async mutate(
    id: string,
    change: (item: QueueItem, now: string) => QueueItem,
    at?: string,
  ): Promise<QueueItem> {
    return withTx('queue', 'readwrite', async (tx) => {
      const store = tx.objectStore('queue')
      const current = await req<QueueItem | undefined>(store.get(id))
      if (!current) throw new StorageError(`Задача ${id} не найдена.`)
      const updated = change(current, at ?? nowIso())
      store.put(updated)
      return updated
    })
  }
}

/** Текст ошибки для поля `last_error`. */
function errorText(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  try {
    return JSON.stringify(error) ?? 'Неизвестная ошибка'
  } catch {
    return 'Неизвестная ошибка'
  }
}

/** Готовый экземпляр для приложения. */
export const queueStore = new QueueStore()