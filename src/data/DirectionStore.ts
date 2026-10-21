/**
 * DirectionStore — CRUD направлений.
 *
 * Направлений мало (5–9 на всю базу), они общие для всех идей, поэтому
 * хранятся списком и читаются целиком. Порядок в сетке — поле `order`.
 *
 * Удаление направления не оставляет идеи «в никуда»: у связанных идей
 * обнуляется `direction_id` в той же транзакции. Так в базе не появляется
 * ссылок на несуществующее направление.
 */

import { StorageError, iterateIndex, req, withTx } from './db'
import { normalizeDirection, nowIso } from './records'
import type { Direction, Idea, NewDirection } from './types'

/** Что можно менять у направления. */
export type DirectionPatch = Partial<Omit<Direction, 'id' | 'created_at'>>

/** Итог удаления направления. */
export interface RemoveDirectionResult {
  removed: boolean
  /** Сколько идей осталось без направления. */
  clearedIdeas: number
}

export class DirectionStore {
  /**
   * Создаёт направление. Если `order` не задан, новое направление встаёт
   * в конец списка.
   */
  async create(input: NewDirection = {}): Promise<Direction> {
    const direction = await withTx('directions', 'readwrite', async (tx) => {
      const store = tx.objectStore('directions')
      const existing = await req<Direction[]>(store.getAll())
      const maxOrder = existing.reduce((max, item) => Math.max(max, item.order ?? 0), -1)
      const created = normalizeDirection(input, maxOrder + 1)
      store.put(created)
      return created
    })
    return direction
  }

  /** Возвращает направление по id или null. */
  async get(id: string): Promise<Direction | null> {
    const direction = await withTx('directions', 'readonly', (tx) =>
      req<Direction | undefined>(tx.objectStore('directions').get(id)),
    )
    return direction ?? null
  }

  /** Меняет направление (кроме `id` и `created_at`). */
  async update(id: string, patch: DirectionPatch): Promise<Direction> {
    const next = await withTx('directions', 'readwrite', async (tx) => {
      const store = tx.objectStore('directions')
      const current = await req<Direction | undefined>(store.get(id))
      if (!current) throw new StorageError(`Направление ${id} не найдено — обновлять нечего.`)

      const updated: Direction = { ...current }
      if (patch.name !== undefined) updated.name = patch.name
      if (patch.icon !== undefined) updated.icon = patch.icon
      if (patch.review_hint !== undefined) updated.review_hint = patch.review_hint
      if (patch.order !== undefined) updated.order = patch.order
      if (patch.window_days !== undefined) updated.window_days = patch.window_days
      if (patch.last_reviewed_at !== undefined) updated.last_reviewed_at = patch.last_reviewed_at

      store.put(updated)
      return updated
    })
    return next
  }

  /**
   * Удаляет направление.
   * По умолчанию у связанных идей обнуляется `direction_id` (см. шапку файла).
   * `keepIdeas: true` оставляет ссылки как есть — для редких случаев импорта.
   */
  async remove(id: string, options: { keepIdeas?: boolean } = {}): Promise<RemoveDirectionResult> {
    const keepIdeas = options.keepIdeas === true
    return withTx(['directions', 'ideas'], 'readwrite', async (tx) => {
      const store = tx.objectStore('directions')
      const current = await req<Direction | undefined>(store.get(id))
      if (!current) return { removed: false, clearedIdeas: 0 }

      let cleared = 0
      if (!keepIdeas) {
        const now = nowIso()
        await iterateIndex<Idea>(
          tx,
          'ideas',
          'by_direction',
          IDBKeyRange.only(id),
          (idea, cursor) => {
            cursor.update({ ...idea, direction_id: null, last_activity_at: now })
            cleared++
          },
        )
      }

      store.delete(id)
      return { removed: true, clearedIdeas: cleared }
    })
  }

  /** Все направления: порядок в сетке, затем имя. */
  async list(): Promise<Direction[]> {
    const directions = await withTx('directions', 'readonly', (tx) =>
      req<Direction[]>(tx.objectStore('directions').getAll()),
    )
    return directions.sort((a, b) =>
      a.order === b.order ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : a.order - b.order,
    )
  }

  /** Сколько направлений заведено. */
  async count(): Promise<number> {
    return withTx('directions', 'readonly', (tx) =>
      req<number>(tx.objectStore('directions').count()),
    )
  }

  /** Отмечает, что направление разобрали — для «какое застоялось». */
  async touchReviewed(id: string, at: string = nowIso()): Promise<Direction> {
    return this.update(id, { last_reviewed_at: at })
  }
}

/** Готовый экземпляр для приложения. */
export const directionStore = new DirectionStore()