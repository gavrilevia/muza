/**
 * IdeaRepository — CRUD идей в IndexedDB.
 *
 * Домен не знает, где лежат данные: он работает через этот репозиторий.
 * Сегодня это IndexedDB, завтра — файлы (см. АРХИТЕКТУРА-PWA.md, раздел 3.2).
 *
 * Все методы асинхронные. Операции идемпотентны там, где это имеет смысл:
 * `create` с готовым id перезаписывает ту же запись, `remove` для уже
 * удалённой идеи ничего не портит.
 *
 * Чтение идёт по индексам `by_status` / `by_direction` / `by_moment`, когда
 * фильтр по ним один; в остальных случаях — один проход `getAll` и отбор
 * в памяти. Для 1000 идей это быстрее и надёжнее, чем десять разных планов.
 */

import { StorageError, countAll, countByIndex, getAll, req, withTx } from './db'
import { normalizeIdea, nowIso } from './records'
import type { Idea, IdeaKind, IdeaPatch, IdeaStatus, NewIdea } from './types'

/** По какому полю сортировать список. */
export type IdeaSortField = 'captured_at' | 'last_activity_at' | 'created_at' | 'moment_at' | 'title'

/** Фильтры и сортировка списка идей. */
export interface IdeaQuery {
  /** Статус или несколько статусов. По умолчанию удалённые не показываются. */
  status?: IdeaStatus | IdeaStatus[]
  /** Направление или несколько направлений; `null` — «без направления». */
  direction_id?: string | null | (string | null)[]
  /** Тип идеи. */
  kind?: IdeaKind | IdeaKind[]
  /** Только ветви конкретного корня. */
  root_of?: string
  /** Поиск по заголовку и тексту: все слова должны найтись (регистр не важен). */
  search?: string
  /** Момент не раньше указанного времени. */
  momentAfter?: string
  /** Момент не позже указанного времени. */
  momentBefore?: string
  /** Захвачено не раньше указанного времени. */
  capturedAfter?: string
  /** Захвачено не позже указанного времени. */
  capturedBefore?: string
  /** Показывать и удалённые тоже. */
  includeDeleted?: boolean
  sortBy?: IdeaSortField
  order?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

/** Значение или массив значений → массив. */
function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

/** Как читать записи: целиком или через индекс. */
type ReadSource = { via: 'store' } | { via: 'index'; index: string; range: IDBKeyRange | null }

/**
 * Выбирает самый узкий источник чтения.
 * Тонкость: `direction_id = null` через индекс не найти — IndexedDB не считает
 * `null` допустимым ключом, такие записи в индекс не попадают. Поэтому
 * «без направления» всегда читается полным проходом и отбирается в памяти.
 */
function pickSource(query: IdeaQuery): ReadSource {
  const statuses = asArray(query.status)
  const directions = asArray(query.direction_id)

  if (statuses.length === 1) {
    return { via: 'index', index: 'by_status', range: IDBKeyRange.only(statuses[0]) }
  }
  if (directions.length === 1 && typeof directions[0] === 'string') {
    return { via: 'index', index: 'by_direction', range: IDBKeyRange.only(directions[0]) }
  }
  if (query.momentAfter && query.momentBefore) {
    return {
      via: 'index',
      index: 'by_moment',
      range: IDBKeyRange.bound(query.momentAfter, query.momentBefore),
    }
  }
  if (query.momentAfter) {
    return { via: 'index', index: 'by_moment', range: IDBKeyRange.lowerBound(query.momentAfter) }
  }
  if (query.momentBefore) {
    return { via: 'index', index: 'by_moment', range: IDBKeyRange.upperBound(query.momentBefore) }
  }
  return { via: 'store' }
}

/** Вхождение всех слов запроса в заголовок и текст. */
function matchesSearch(idea: Idea, search: string): boolean {
  const words = search.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const haystack = `${idea.title}\n${idea.body}`.toLowerCase()
  return words.every((word) => haystack.includes(word))
}

/** Подходит ли идея под фильтры (без сортировки и пагинации). */
function matches(idea: Idea, query: IdeaQuery): boolean {
  const statuses = asArray(query.status)
  if (statuses.length > 0) {
    if (!statuses.includes(idea.status)) return false
  } else if (!query.includeDeleted && idea.status === 'deleted') {
    return false
  }

  const directions = asArray(query.direction_id)
  if (directions.length > 0 && !directions.includes(idea.direction_id)) return false

  const kinds = asArray(query.kind)
  if (kinds.length > 0 && (idea.kind === null || !kinds.includes(idea.kind))) return false

  if (query.root_of !== undefined && idea.root_of !== query.root_of) return false
  if (query.capturedAfter && idea.captured_at < query.capturedAfter) return false
  if (query.capturedBefore && idea.captured_at > query.capturedBefore) return false
  if (query.search && !matchesSearch(idea, query.search)) return false

  return true
}

/** Значение поля для сортировки; пустые моменты уезжают в конец. */
function sortValue(idea: Idea, field: IdeaSortField): string {
  const value = idea[field]
  return typeof value === 'string' ? value : ''
}

/** Сортировка по полю с устойчивым порядком при равных значениях. */
function sortIdeas(ideas: Idea[], field: IdeaSortField, order: 'asc' | 'desc'): Idea[] {
  const sign = order === 'asc' ? 1 : -1
  return [...ideas].sort((a, b) => {
    const left = sortValue(a, field)
    const right = sortValue(b, field)
    if (left !== right) return left < right ? -sign : sign
    if (a.id === b.id) return 0
    return a.id < b.id ? -1 : 1
  })
}

export class IdeaRepository {
  /**
   * Создаёт идею. Все поля, кроме `id`, необязательны и получают значения
   * по умолчанию; мусорные значения отбрасываются нормализацией.
   * Если передать существующий `id`, запись перезаписывается (идемпотентно).
   */
  async create(input: NewIdea = {}): Promise<Idea> {
    const idea = normalizeIdea(input)
    await withTx('ideas', 'readwrite', (tx) => {
      tx.objectStore('ideas').put(idea)
    })
    return idea
  }

  /**
   * Создаёт пачку идей одной транзакцией.
   * Нужно там, где важна скорость: 1000 идей за одну транзакцию сохраняются
   * на два порядка быстрее, чем 1000 отдельных.
   */
  async createMany(inputs: readonly NewIdea[]): Promise<Idea[]> {
    const ideas = inputs.map((input) => normalizeIdea(input))
    if (ideas.length === 0) return []
    await withTx('ideas', 'readwrite', (tx) => {
      const store = tx.objectStore('ideas')
      for (const idea of ideas) store.put(idea)
    })
    return ideas
  }

  /** Возвращает идею по id или null. */
  async get(id: string): Promise<Idea | null> {
    const idea = await withTx('ideas', 'readonly', (tx) =>
      req<Idea | undefined>(tx.objectStore('ideas').get(id)),
    )
    return idea ?? null
  }

  /**
   * Меняет идею: читает текущую, накладывает патч, пишет обратно — всё
   * в одной транзакции. `id` и `created_at` изменить нельзя, они берутся
   * из текущей записи. `last_activity_at` обновляется на сейчас, если патч
   * не задал его явно (так идея перестаёт считаться застоявшейся).
   */
  async update(id: string, patch: IdeaPatch): Promise<Idea> {
    const next = await withTx('ideas', 'readwrite', async (tx) => {
      const store = tx.objectStore('ideas')
      const current = await req<Idea | undefined>(store.get(id))
      if (!current) throw new StorageError(`Идея ${id} не найдена — обновлять нечего.`)

      const updated: Idea = { ...current }
      if (patch.title !== undefined) updated.title = patch.title
      if (patch.body !== undefined) updated.body = patch.body
      if (patch.status !== undefined) updated.status = patch.status
      if (patch.captured_at !== undefined) updated.captured_at = patch.captured_at
      if (patch.captured_via !== undefined) updated.captured_via = patch.captured_via
      if (patch.sleep_at !== undefined) updated.sleep_at = patch.sleep_at
      if (patch.archived_reason !== undefined) updated.archived_reason = patch.archived_reason
      if (patch.ai_opt_out !== undefined) updated.ai_opt_out = patch.ai_opt_out
      if (patch.root_of !== undefined) updated.root_of = patch.root_of
      if (patch.worked_on !== undefined) updated.worked_on = patch.worked_on
      if (patch.direction_id !== undefined) updated.direction_id = patch.direction_id
      if (patch.kind !== undefined) updated.kind = patch.kind
      if (patch.props !== undefined) updated.props = patch.props
      if (patch.moment_at !== undefined) updated.moment_at = patch.moment_at
      if (patch.moment_rule !== undefined) updated.moment_rule = patch.moment_rule
      updated.last_activity_at = patch.last_activity_at ?? nowIso()

      store.put(updated)
      return updated
    })
    return next
  }

  /**
   * Мягкое удаление: статус `deleted`.
   * Запись остаётся в базе — её можно вернуть через `restore`, и она не
   * пропадает из резервной копии.
   */
  async remove(id: string): Promise<Idea> {
    return this.update(id, { status: 'deleted' })
  }

  /** Возвращает мягко удалённую идею (по умолчанию — во «входящие»). */
  async restore(id: string, status: IdeaStatus = 'inbox'): Promise<Idea> {
    return this.update(id, { status })
  }

  /**
   * Список идей с фильтрами, сортировкой и пагинацией.
   * Удалённые по умолчанию не показываются.
   */
  async list(query: IdeaQuery = {}): Promise<Idea[]> {
    const source = pickSource(query)
    const candidates = await withTx('ideas', 'readonly', (tx) => {
      const store = tx.objectStore('ideas')
      return source.via === 'index'
        ? req<Idea[]>(store.index(source.index).getAll(source.range))
        : req<Idea[]>(store.getAll())
    })

    const filtered = candidates.filter((idea) => matches(idea, query))
    const sorted = sortIdeas(filtered, query.sortBy ?? 'captured_at', query.order ?? 'desc')

    const offset = query.offset && query.offset > 0 ? Math.trunc(query.offset) : 0
    const limit = query.limit !== undefined ? Math.max(0, Math.trunc(query.limit)) : undefined
    return limit === undefined ? sorted.slice(offset) : sorted.slice(offset, offset + limit)
  }

  /**
   * Сколько идей подходит под фильтр.
   *
   * Для простых фильтров считается встроенным `count()` по индексу —
   * без чтения самих записей. Сложные фильтры (поиск по тексту, свойства,
   * диапазоны дат захвата) честно считаются через `list`.
   */
  async count(query: IdeaQuery = {}): Promise<number> {
    const statuses = asArray(query.status)
    const directions = asArray(query.direction_id)
    // Фильтры, которые индекс посчитать не может.
    const extra =
      asArray(query.kind).length > 0 ||
      query.root_of !== undefined ||
      !!query.search ||
      !!query.momentAfter ||
      !!query.momentBefore ||
      !!query.capturedAfter ||
      !!query.capturedBefore

    if (!extra && statuses.length === 0 && directions.length === 0 && !query.includeDeleted) {
      return withTx('ideas', 'readonly', async (tx) => {
        const total = await req<number>(tx.objectStore('ideas').count())
        const deleted = await req<number>(
          tx.objectStore('ideas').index('by_status').count(IDBKeyRange.only('deleted')),
        )
        return total - deleted
      })
    }

    if (!extra && statuses.length === 1 && directions.length === 0) {
      return countByIndex('ideas', 'by_status', IDBKeyRange.only(statuses[0]))
    }

    if (!extra && directions.length === 1 && statuses.length === 0 && typeof directions[0] === 'string') {
      return countByIndex('ideas', 'by_direction', IDBKeyRange.only(directions[0]))
    }

    return (await this.list({ ...query, limit: undefined, offset: undefined })).length
  }

  /** Сколько всего записей в хранилище, включая удалённые. */
  async countAllRecords(): Promise<number> {
    return countAll('ideas')
  }

  /** Все идеи без фильтров — для выгрузки и обслуживания. */
  async listAll(): Promise<Idea[]> {
    return getAll<Idea>('ideas')
  }
}

/** Готовый экземпляр для приложения. */
export const ideaRepository = new IdeaRepository()