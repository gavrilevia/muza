/**
 * Проверка слоя данных «Музы» без браузера и без зависимостей.
 *
 * Запуск:
 *   node_modules/.bin/rolldown tools/data-selftest.ts -o node_modules/.tmp/selftest.mjs --format esm
 *   node node_modules/.tmp/selftest.mjs
 *
 * Что здесь есть:
 *   1) настоящая проверка чистых функций — ULID, слияние журналов, формат копии;
 *   2) подделка IndexedDB, написанная вручную по спецификации, — чтобы прогнать
 *      репозитории, очередь, направления и импорт/экспорт целиком;
 *   3) захват: несколько выбранных файлов — это несколько идей, по одной
 *      на файл, и сбой на одном файле не отменяет остальные.
 *
 * Чего здесь НЕТ: браузера. Подделка не проверяет реальные особенности
 * Chrome и Safari (время жизни транзакции при await, квоты, поведение при
 * нехватке места). Это конечная проверка на устройстве.
 */

// ---------------------------------------------------------------------------
// Подделка IndexedDB. Реализованы только те части, которыми пользуется db.ts.
// ---------------------------------------------------------------------------

type StubKey = string | number

interface StubRange {
  lower: StubKey | undefined
  upper: StubKey | undefined
  lowerOpen: boolean
  upperOpen: boolean
}

class StubRequest {
  onsuccess: ((event: unknown) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  result: unknown = undefined
  error: unknown = null
}

/** Значение считается ключом, если это строка, конечное число или дата. */
function isValidKey(value: unknown): value is StubKey {
  return (
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    value instanceof Date
  )
}

/** Достаёт ключ по keyPath; отсутствие поля — недопустимый ключ. */
function keyOf(value: unknown, keyPath: string): unknown {
  let current: unknown = value
  for (const part of keyPath.split('.')) {
    if (!current || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

/** Порядок ключей IndexedDB: число < дата < строка. */
function compareKeys(a: unknown, b: unknown): number {
  const rank = (key: unknown) => (typeof key === 'number' ? 0 : key instanceof Date ? 1 : 2)
  const byRank = rank(a) - rank(b)
  if (byRank !== 0) return byRank
  const left = a instanceof Date ? a.getTime() : a
  const right = b instanceof Date ? b.getTime() : b
  return (left as number) < (right as number) ? -1 : (left as number) > (right as number) ? 1 : 0
}

function inRange(key: unknown, range: StubRange | null): boolean {
  if (!range) return true
  if (range.lower !== undefined) {
    const cmp = compareKeys(key, range.lower)
    if (cmp < 0 || (cmp === 0 && range.lowerOpen)) return false
  }
  if (range.upper !== undefined) {
    const cmp = compareKeys(key, range.upper)
    if (cmp > 0 || (cmp === 0 && range.upperOpen)) return false
  }
  return true
}

/** Планирует событие успеха микрозадачей — как настоящая IndexedDB. */
function fire(request: StubRequest, result: unknown): void {
  request.result = result
  queueMicrotask(() => request.onsuccess?.({ target: request }))
}

class StubCursor {
  index = 0

  constructor(
    private readonly store: StubStore,
    private readonly entries: [StubKey, unknown][],
    private readonly request: StubRequest,
    private readonly direction: 'next' | 'prev',
  ) {}

  get value(): unknown {
    return this.entries[this.index]?.[1]
  }

  get primaryKey(): StubKey {
    return this.entries[this.index]?.[0]
  }

  continue(): void {
    const nextIndex = this.index + 1
    const nextCursor = nextIndex < this.entries.length ? this.at(nextIndex) : null
    this.request.result = nextCursor
    queueMicrotask(() => this.request.onsuccess?.({ target: this.request }))
  }

  update(value: unknown): void {
    this.store.records.set(this.primaryKey, value)
  }

  delete(): void {
    this.store.records.delete(this.primaryKey)
  }

  /** Курсор на ту же выборку, но с другим номером позиции. */
  private at(index: number): StubCursor {
    const cursor = new StubCursor(this.store, this.entries, this.request, this.direction)
    cursor.index = index
    return cursor
  }
}

class StubIndex {
  constructor(
    readonly name: string,
    private readonly keyPath: string,
    private readonly store: StubStore,
  ) {}

  private entries(range: StubRange | null): [StubKey, unknown][] {
    const found: [StubKey, unknown][] = []
    for (const [primaryKey, record] of this.store.records) {
      const indexKey = keyOf(record, this.keyPath)
      if (!isValidKey(indexKey)) continue // null/undefined в индекс не попадают
      if (!inRange(indexKey, range)) continue
      found.push([primaryKey, record])
    }
    found.sort((a, b) => {
      const byIndex = compareKeys(keyOf(a[1], this.keyPath), keyOf(b[1], this.keyPath))
      return byIndex !== 0 ? byIndex : compareKeys(a[0], b[0])
    })
    return found
  }

  count(range: StubRange | null = null): StubRequest {
    const request = new StubRequest()
    fire(request, this.entries(range).length)
    return request
  }

  getAll(range: StubRange | null = null): StubRequest {
    const request = new StubRequest()
    fire(
      request,
      this.entries(range).map(([, record]) => record),
    )
    return request
  }

  openCursor(range: StubRange | null = null, direction: 'next' | 'prev' = 'next'): StubRequest {
    const request = new StubRequest()
    const entries = this.entries(range)
    if (direction === 'prev') entries.reverse()
    fire(request, entries.length > 0 ? new StubCursor(this.store, entries, request, direction) : null)
    return request
  }
}

class StubStore {
  records = new Map<StubKey, unknown>()
  indexes = new Map<string, StubIndex>()
  indexNames = {
    contains: (name: string) => this.indexes.has(name),
  }

  constructor(
    readonly name: string,
    readonly keyPath: string,
  ) {}

  createIndex(name: string, keyPath: string, options: { unique?: boolean } = {}): StubIndex {
    if (this.indexes.has(name)) throw new Error(`IndexExistsError: ${name}`)
    const index = new StubIndex(name, keyPath, this)
    this.indexes.set(name, index)
    void options
    return index
  }

  index(name: string): StubIndex {
    const index = this.indexes.get(name)
    if (!index) throw new Error(`NotFoundError: индекс ${name} не создан`)
    return index
  }

  put(value: unknown): StubRequest {
    const request = new StubRequest()
    const key = keyOf(value, this.keyPath)
    if (!isValidKey(key)) {
      request.error = new Error('DataError: недопустимый ключ')
      queueMicrotask(() => request.onerror?.({ target: request }))
      return request
    }
    this.records.set(key, value)
    fire(request, key)
    return request
  }

  get(key: StubKey): StubRequest {
    const request = new StubRequest()
    fire(request, this.records.get(key))
    return request
  }

  delete(key: StubKey): StubRequest {
    const request = new StubRequest()
    this.records.delete(key)
    fire(request, undefined)
    return request
  }

  clear(): StubRequest {
    const request = new StubRequest()
    this.records.clear()
    fire(request, undefined)
    return request
  }

  private sorted(): [StubKey, unknown][] {
    return [...this.records.entries()].sort((a, b) => compareKeys(a[0], b[0]))
  }

  count(range: StubRange | null = null): StubRequest {
    const request = new StubRequest()
    fire(
      request,
      this.sorted().filter(([key]) => inRange(key, range)).length,
    )
    return request
  }

  getAll(range: StubRange | null = null): StubRequest {
    const request = new StubRequest()
    fire(
      request,
      this.sorted()
        .filter(([key]) => inRange(key, range))
        .map(([, value]) => value),
    )
    return request
  }

  openCursor(range: StubRange | null = null, direction: 'next' | 'prev' = 'next'): StubRequest {
    const request = new StubRequest()
    const entries = this.sorted().filter(([key]) => inRange(key, range))
    if (direction === 'prev') entries.reverse()
    fire(request, entries.length > 0 ? new StubCursor(this, entries, request, direction) : null)
    return request
  }
}

class StubTransaction {
  oncomplete: ((event: unknown) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  onabort: ((event: unknown) => void) | null = null
  error: unknown = null
  aborted = false

  constructor(
    private readonly db: StubDatabase,
    readonly names: string[],
    readonly mode: string,
  ) {
    // Завершение — макрозадачей: все микрозадачи запросов успевают пройти.
    setTimeout(() => {
      if (!this.aborted) this.oncomplete?.({ target: this })
    }, 0)
  }

  objectStore(name: string): StubStore {
    // В транзакции смены версии доступны все существующие хранилища.
    if (this.mode !== 'versionchange' && !this.names.includes(name)) {
      throw new Error(`NotFoundError: ${name} вне транзакции`)
    }
    const store = this.db.stores.get(name)
    if (!store) throw new Error(`NotFoundError: хранилище ${name}`)
    return store
  }

  abort(): void {
    this.aborted = true
    queueMicrotask(() => this.onabort?.({ target: this }))
  }
}

class StubDatabase {
  stores = new Map<string, StubStore>()
  onversionchange: (() => void) | null = null

  objectStoreNames = {
    contains: (name: string) => this.stores.has(name),
  }

  constructor(
    readonly name: string,
    public version: number,
  ) {}

  createObjectStore(name: string, options: { keyPath: string }): StubStore {
    if (this.stores.has(name)) throw new Error(`ConstraintError: ${name}`)
    const store = new StubStore(name, options.keyPath)
    this.stores.set(name, store)
    return store
  }

  transaction(names: string | string[], mode: string): StubTransaction {
    const list = Array.isArray(names) ? names : [names]
    for (const name of list) {
      if (!this.stores.has(name)) throw new Error(`NotFoundError: хранилище ${name}`)
    }
    return new StubTransaction(this, list, mode)
  }

  close(): void {}
}

class StubOpenRequest extends StubRequest {
  onupgradeneeded: ((event: { target: unknown; oldVersion: number }) => void) | null = null
  onblocked: ((event: unknown) => void) | null = null
  transaction: StubTransaction | null = null
}

const databases = new Map<string, StubDatabase>()

const indexedDBStub = {
  open(name: string, version: number): StubOpenRequest {
    const request = new StubOpenRequest()
    queueMicrotask(() => {
      let db = databases.get(name)
      const isNew = !db
      const oldVersion = db ? db.version : 0
      if (!db) {
        db = new StubDatabase(name, version)
        databases.set(name, db)
      }
      if (isNew || version > db.version) {
        db.version = version
        // request.result выставляется ДО события, как в браузере:
        // обработчик миграции читает request.result.
        request.result = db
        request.transaction = new StubTransaction(db, [], 'versionchange')
        request.onupgradeneeded?.({ target: request, oldVersion })
        // Миграция выполняется синхронно в обработчике, как в браузере.
      }
      request.result = db
      queueMicrotask(() => request.onsuccess?.({ target: request }))
    })
    return request
  },

  deleteDatabase(name: string): StubRequest {
    const request = new StubRequest()
    queueMicrotask(() => {
      databases.delete(name)
      request.onsuccess?.({ target: request })
    })
    return request
  },
}

const keyRangeStub = {
  only(key: StubKey): StubRange {
    return { lower: key, upper: key, lowerOpen: false, upperOpen: false }
  },
  lowerBound(key: StubKey, open = false): StubRange {
    return { lower: key, upper: undefined, lowerOpen: open, upperOpen: false }
  },
  upperBound(key: StubKey, open = false): StubRange {
    return { lower: undefined, upper: key, lowerOpen: false, upperOpen: open }
  },
  bound(lower: StubKey, upper: StubKey, lowerOpen = false, upperOpen = false): StubRange {
    return { lower, upper, lowerOpen, upperOpen }
  },
}

// Ставим подделку в глобальные имена ДО вызова функций слоя данных.
;(globalThis as Record<string, unknown>).indexedDB = indexedDBStub
;(globalThis as Record<string, unknown>).IDBKeyRange = keyRangeStub

// ---------------------------------------------------------------------------
// Проверки
// ---------------------------------------------------------------------------

import {
  IdeaRepository,
  DirectionStore,
  HistoryStore,
  QueueStore,
  ideaRepository,
  materialRepository,
  buildBackup,
  buildBackupFile,
  collectBackupData,
  importBackupText,
  parseBackup,
  serializeBackup,
  mergeHistory,
  unionHistory,
  normalizeIdea,
  deepEqual,
  ulid,
  isUlid,
  ulidTime,
  ulidReset,
  closeDb,
  deleteDb,
  openDb,
  retryDelayMs,
  StorageError,
} from '../src/data'
import type { HistoryEntry, Idea } from '../src/data'
import {
  ARCHIVE_REASONS,
  archiveIdea,
  buildIdeaExport,
  buildIdeaMarkdown,
  exportIdea,
  extensionFor,
  restoreIdea,
  safeFileName,
} from '../src/data/exit'
import { strFromU8, unzipSync } from 'fflate'
import { captureMany, ideaRequestsFor } from '../src/capture/captureService'
import { asCaptureFile, pluralRu, suggestTitle } from '../src/capture/logic'
import type { CaptureFile, CaptureRequest } from '../src/capture/types'

let passed = 0
const failures: string[] = []

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed++
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function equal(name: string, actual: unknown, expected: unknown): void {
  check(name, deepEqual(actual, expected), `получено ${JSON.stringify(actual)}, ждали ${JSON.stringify(expected)}`)
}

function section(title: string): void {
  console.log(`\n== ${title}`)
}

/** Короткая идея для проверок. */
function makeIdea(title: string, extra: Partial<Idea> = {}): Partial<Idea> {
  return { title, body: `${title} — текст`, ...extra }
}

// --- ULID -----------------------------------------------------------------

section('ULID')
{
  const id = ulid()
  check('длина 26', id.length === 26, String(id.length))
  check('алфавит Crockford', isUlid(id), id)
  check('время читается обратно', Math.abs(ulidTime(id) - Date.now()) < 5000, String(ulidTime(id)))

  const sorted = Array.from({ length: 5000 }, () => ulid()).sort()
  check('5000 штук без повторов', new Set(sorted).size === 5000, String(new Set(sorted).size))

  const raw: string[] = []
  for (let i = 0; i < 2000; i++) raw.push(ulid())
  let monotone = true
  for (let i = 1; i < raw.length; i++) if (raw[i - 1] >= raw[i]) monotone = false
  check('монотонность внутри миллисекунды', monotone)

  // Явное время проверяем на чистом генераторе: иначе срабатывает защита
  // от ухода часов назад и время не откатывается (это и нужно в жизни).
  ulidReset()
  const early = ulid(1_700_000_000_000)
  const late = ulid(1_800_000_000_000)
  check('сортировка по времени', early < late, `${early} < ${late}`)
  equal('время из старших символов', ulidTime(early), 1_700_000_000_000)
  check('не ULID отбраковывается', !isUlid('01JQ8K7M') && !isUlid(123))

  // Часы ушли назад: генератор не должен выдать меньший id.
  const beforeRollback = ulid()
  const afterRollback = ulid(Date.now() - 60_000)
  check('часы назад — монотонность сохраняется', afterRollback > beforeRollback)
}

// --- Схема хранилищ --------------------------------------------------------

section('Схема хранилищ (АРХИТЕКТУРА-PWA.md, 3.3)')
{
  await deleteDb()
  const db = await openDb()
  const expectedStores = [
    'ideas',
    'materials',
    'directions',
    'history',
    'queue',
    'vectors',
    'events',
    'meta',
  ]
  for (const name of expectedStores) {
    check(`хранилище ${name} создано`, db.objectStoreNames.contains(name))
  }

  const tx = db.transaction('ideas', 'readonly')
  const ideas = tx.objectStore('ideas')
  equal('ключ ideas — id', ideas.keyPath, 'id')
  for (const index of ['by_direction', 'by_moment', 'by_status', 'by_activity']) {
    check(`индекс ideas.${index} создан`, ideas.indexNames.contains(index))
  }

  const queueTx = db.transaction('queue', 'readonly')
  const queue = queueTx.objectStore('queue')
  for (const index of ['by_next_try', 'by_status', 'by_idea']) {
    check(`индекс queue.${index} создан`, queue.indexNames.contains(index))
  }

  const historyTx = db.transaction('history', 'readonly')
  check('индекс history.by_idea создан', historyTx.objectStore('history').indexNames.contains('by_idea'))

  // Повторное открытие не должно пересоздавать хранилища (миграция идемпотентна).
  await closeDb()
  const again = await openDb()
  check('повторное открытие: хранилища на месте', expectedStores.every((n) => again.objectStoreNames.contains(n)))
}

// --- База, репозиторий идей ------------------------------------------------

section('База и IdeaRepository')
{
  await deleteDb()
  const repo = new IdeaRepository()

  const created = await repo.create(makeIdea('Аэрогриль'))
  check('идея получила ULID', isUlid(created.id), created.id)
  equal('статус по умолчанию', created.status, 'inbox')
  equal('props по умолчанию', created.props, {})
  equal('direction_id пуст', created.direction_id, null)

  await repo.createMany([makeIdea('Второе'), makeIdea('Третье'), makeIdea('Четвёртое')])
  equal('всего идей', await repo.count(), 4)

  // «Перезагрузка страницы»: закрываем соединение и открываем заново.
  await closeDb()
  const reopened = new IdeaRepository()
  equal('после перезагрузки идей столько же', await reopened.count(), 4)
  check('идея читается после перезагрузки', (await reopened.get(created.id))?.title === 'Аэрогриль')

  const updated = await reopened.update(created.id, { title: 'Аэрогриль 5 л', kind: 'purchase' })
  equal('патч применился', updated.title, 'Аэрогриль 5 л')
  equal('id не изменился', updated.id, created.id)
  equal('created_at не изменился', updated.created_at, created.created_at)
  check('last_activity_at сдвинулся', updated.last_activity_at >= created.last_activity_at)

  await reopened.remove(created.id)
  const afterRemove = await reopened.get(created.id)
  equal('мягкое удаление: запись на месте', afterRemove?.id, created.id)
  equal('мягкое удаление: статус deleted', afterRemove?.status, 'deleted')
  equal('в списке удалённой нет', (await reopened.list()).length, 3)
  equal('с includeDeleted — есть', (await reopened.list({ includeDeleted: true })).length, 4)
  equal('count тоже без удалённых', await reopened.count(), 3)

  await reopened.restore(created.id)
  equal('возврат из удалённых', await reopened.count(), 4)

  await reopened.update(created.id, { direction_id: 'dir-1', status: 'incubating' })
  equal('фильтр по направлению', (await reopened.list({ direction_id: 'dir-1' })).length, 1)
  equal('фильтр по статусу', (await reopened.list({ status: 'incubating' })).length, 1)
  equal('count по статусу', await reopened.count({ status: 'incubating' }), 1)
  equal('поиск по слову', (await reopened.list({ search: 'аэрогриль' })).length, 1)
  equal('поиск без совпадений', (await reopened.list({ search: 'вертолёт' })).length, 0)
  equal('поиск по двум словам', (await reopened.list({ search: 'аэрогриль л' })).length, 1)
  equal('пагинация: limit', (await reopened.list({ limit: 2 })).length, 2)
  equal('пагинация: offset', (await reopened.list({ limit: 2, offset: 3 })).length, 1)

  const parent = await reopened.create(makeIdea('Корень'))
  await reopened.create(makeIdea('Ветвь', { root_of: parent.id }))
  equal('фильтр по корню', (await reopened.list({ root_of: parent.id })).length, 1)
  equal('filter по kind', (await reopened.list({ kind: 'purchase' })).length, 1)

  const momentA = await reopened.create(makeIdea('Момент А', { moment_at: '2026-06-01T00:00:00.000Z' }))
  await reopened.create(makeIdea('Момент Б', { moment_at: '2026-12-01T00:00:00.000Z' }))
  equal(
    'фильтр по моменту (диапазон)',
    (await reopened.list({ momentAfter: '2026-05-01T00:00:00.000Z', momentBefore: '2026-07-01T00:00:00.000Z' }))
      .length,
    1,
  )
  equal('без момента в диапазон не попадает', (await reopened.list({ momentBefore: '2030-01-01T00:00:00.000Z' })).length, 2)
  await reopened.update(momentA.id, { moment_at: null })
  equal('обновление до null работает', (await reopened.get(momentA.id))?.moment_at, null)

  let threw = false
  try {
    await reopened.update('нет-такой-идеи', { title: 'x' })
  } catch (e) {
    threw = e instanceof StorageError
  }
  check('update несуществующей идеи бросает StorageError', threw)
}

// --- История: append-only --------------------------------------------------

section('HistoryStore — append-only')
{
  const history = new HistoryStore()
  const ideaId = '01JQ8K7M0000000000000000AA'

  const first = await history.append({ idea_id: ideaId, type: 'origin', summary: 'Появилась мысль' })
  const second = await history.append({ idea_id: ideaId, type: 'development', summary: 'Первая развилка', actor: 'ai' })
  const third = await history.append({ idea_id: ideaId, type: 'doubt', summary: 'Сомнение' })

  const snapshot = await history.listByIdea(ideaId)
  equal('журнал: три записи', snapshot.length, 3)
  equal('порядок по времени', snapshot.map((e) => e.id), [first.id, second.id, third.id].sort())

  const frozen = JSON.stringify(snapshot)

  await history.append({ idea_id: ideaId, type: 'freeze', summary: 'Заморозили' })
  await history.append({ idea_id: 'другая-идея', type: 'link', summary: 'Связь' })

  const after = await history.listByIdea(ideaId)
  equal('после дописывания записей больше', after.length, 4)
  equal(
    'ранее записанные записи не изменились',
    JSON.stringify(after.filter((e) => snapshot.some((s) => s.id === e.id))),
    frozen,
  )
  equal('всего в журнале', await history.count(), 5)

  const repeated = await history.append({
    id: second.id,
    idea_id: ideaId,
    type: 'development',
    summary: 'Первая развилка',
    actor: 'ai',
  })
  equal('append с тем же id не создаёт дубликат', repeated.id, second.id)
  equal('количество не выросло', await history.count(), 5)

  let hasUpdate = false
  let hasRemove = false
  for (const key of ['update', 'remove', 'delete'] as const) {
    if (typeof (history as unknown as Record<string, unknown>)[key] === 'function') {
      if (key === 'remove') hasRemove = true
      else hasUpdate = true
    }
  }
  check('у журнала нет методов update/remove', !hasUpdate && !hasRemove)
}

// --- Числа -----------------------------------------------------------------

section('Нормализация')
{
  const idea = normalizeIdea({ title: 'x', status: 'чушь' as never, kind: 'нет' as never, props: 'строка' as never })
  equal('мусорный статус → inbox', idea.status, 'inbox')
  equal('мусорный kind → null', idea.kind, null)
  equal('мусорные props → {}', idea.props, {})
  check('captured_at заполнен', !!idea.captured_at && !Number.isNaN(Date.parse(idea.captured_at)))

  const withDates = normalizeIdea({ captured_at: 1_700_000_000_000 as never, moment_at: '2026-06-01' as never })
  equal('число превращается в ISO', withDates.captured_at, new Date(1_700_000_000_000).toISOString())
  equal('дата без времени нормализуется', withDates.moment_at, '2026-06-01T00:00:00.000Z')
  equal('битая дата → null', normalizeIdea({ moment_at: 'не дата' as never }).moment_at, null)
}

// --- Очередь ---------------------------------------------------------------

section('QueueStore')
{
  const queue = new QueueStore()
  const a = await queue.enqueue({ idea_id: 'idea-1', stage: 'classify' })
  const again = await queue.enqueue({ idea_id: 'idea-1', stage: 'classify' })
  equal('повторный enqueue возвращает ту же задачу', again.id, a.id)
  equal('задач по идее — одна', (await queue.list({ idea_id: 'idea-1' })).length, 1)

  const b = await queue.enqueue({ idea_id: 'idea-2', stage: 'embed', next_try_at: '2030-01-01T00:00:00.000Z' })
  equal('всего задач', await queue.count(), 2)

  const due = await queue.takeDue(10)
  equal('готова только первая', due.map((i) => i.id), [a.id])

  const done = await queue.markDone(a.id, { cost: 0.12 })
  equal('markDone: статус', done.status, 'done')
  equal('markDone: стоимость', done.cost, 0.12)
  equal('готовых задач больше нет', (await queue.takeDue(10)).length, 0)

  const failed = await queue.markFailed(b.id, new Error('сервис недоступен'), { cost: 0.05 })
  equal('markFailed: попыток', failed.attempts, 1)
  equal('markFailed: текст ошибки', failed.last_error, 'сервис недоступен')
  equal('markFailed: стоимость накоплена', failed.cost, 0.05)
  check('markFailed: повтор отложен', new Date(failed.next_try_at).getTime() > Date.now())
  equal('markFailed: статус pending', failed.status, 'pending')

  const permanent = await queue.markFailed(b.id, 'нет доступа', { permanent: true })
  equal('permanent → failed', permanent.status, 'failed')
  equal('попыток стало две', permanent.attempts, 2)

  check('задержка повтора растёт', retryDelayMs(1) === 60_000 && retryDelayMs(2) === 120_000)
  check('задержка ограничена сутками', retryDelayMs(50) === 24 * 60 * 60 * 1000)

  await queue.enqueue({ idea_id: 'idea-3', stage: 'ocr' })
  const purged = await queue.purgeDone(0, new Date(Date.now() + 1000).toISOString())
  equal('чистка завершённых', purged, 1)
}

// --- Направления -----------------------------------------------------------

section('DirectionStore')
{
  const directions = new DirectionStore()
  const repo = new IdeaRepository()

  const dacha = await directions.create({ name: 'Дача', icon: '🌿' })
  const gifts = await directions.create({ name: 'Подарки' })
  equal('порядок выставляется автоматически', [dacha.order, gifts.order], [0, 1])

  const list = await directions.list()
  equal('список направлений', list.map((d) => d.name), ['Дача', 'Подарки'])

  const idea = await repo.create(makeIdea('Теплица', { direction_id: dacha.id }))
  const result = await directions.remove(dacha.id)
  equal('удалено направление', result.removed, true)
  equal('идея осталась без направления', result.clearedIdeas, 1)
  equal('direction_id обнулён', (await repo.get(idea.id))?.direction_id, null)
  equal('направлений осталось', await directions.count(), 1)

  const touched = await directions.touchReviewed(gifts.id)
  check('last_reviewed_at записан', !!touched.last_reviewed_at)
}

// --- Захват: один файл — одна идея -----------------------------------------

section('Захват: один файл — одна идея')
{
  await deleteDb()
  const repo = new IdeaRepository()

  /** Файл для проверок: здесь важно имя, а содержимое — любое. */
  const file = (name: string, type = 'video/mp4'): CaptureFile =>
    asCaptureFile(new Blob([name], { type }), name, type)

  // Разбор запроса: три файла — три заготовки, порядок тот же.
  {
    const request: CaptureRequest = {
      channel: 'file',
      text: 'разобрать рилсы',
      files: [file('a.mp4'), file('b.mp4'), file('c.mp4')],
    }
    const parts = ideaRequestsFor(request)
    equal('три файла — три заготовки', parts.length, 3)
    equal('в каждой заготовке один файл', parts.map((part) => part.files?.length), [1, 1, 1])
    equal('порядок файлов сохранён', parts.map((part) => part.files?.[0]?.name), ['a.mp4', 'b.mp4', 'c.mp4'])
    equal('текст достался первой заготовке', parts.map((part) => part.text ?? null), ['разобрать рилсы', null, null])
  }

  // Один файл и пустой список остаются одним запросом.
  equal('один файл — один запрос', ideaRequestsFor({ channel: 'file', files: [file('один.mp4')] }).length, 1)
  equal('пустой список — один запрос', ideaRequestsFor({ channel: 'file' }).length, 1)

  // «Поделиться» не разбиваем: несколько файлов там — один предмет.
  {
    const shared: CaptureRequest = {
      channel: 'share',
      url: 'https://example.com',
      files: [file('a.jpg', 'image/jpeg'), file('b.jpg', 'image/jpeg')],
    }
    equal('«Поделиться» остаётся одной идеей', ideaRequestsFor(shared).length, 1)
    equal(
      'ветка «и ещё N» жива для «Поделиться»',
      suggestTitle({ channel: 'share', files: shared.files }),
      'Файлы: a.jpg и ещё 1',
    )
    equal('заголовок одного файла — его имя', suggestTitle({ channel: 'file', files: [file('ролик.mp4')] }), 'ролик.mp4')
  }

  // Три выбранных файла — три идеи, в каждой ровно один материал.
  {
    const batch = await captureMany({
      channel: 'file',
      files: [file('первый.mp4'), file('второй.mp4'), file('третий.mp4')],
    })
    equal('три файла — три идеи', batch.outcomes.length, 3)
    equal('ничего не потеряно', batch.failed, 0)
    equal('предупреждать не о чем', batch.warning, null)
    equal('без текста чистить нечего', batch.textConsumed, false)
    equal(
      'заголовки — из имён файлов',
      batch.outcomes.map((outcome) => outcome.idea.title),
      ['первый.mp4', 'второй.mp4', 'третий.mp4'],
    )
    equal('в каждой идее один материал', batch.outcomes.map((outcome) => outcome.materials.length), [1, 1, 1])
    equal(
      'материал — тот самый файл',
      batch.outcomes.map((outcome) => outcome.materials[0].file),
      ['первый.mp4', 'второй.mp4', 'третий.mp4'],
    )
    equal('идеи легли в базу', await repo.count(), 3)
    equal('материалы легли в базу', await materialRepository.count(), 3)
    equal('канал записан как files_save', batch.outcomes[0].idea.captured_via, 'files_save')
  }

  // Тот самый случай с телефона: пятнадцать видео — пятнадцать идей.
  {
    await deleteDb()
    const fifteen = Array.from({ length: 15 }, (_, i) => file(`ролик-${i + 1}.mp4`))
    const batch = await captureMany({ channel: 'file', files: fifteen })
    equal('15 файлов — 15 идей', batch.outcomes.length, 15)
    equal('в каждой идее ровно один материал', batch.outcomes.every((o) => o.materials.length === 1), true)
    equal('первая идея — первый файл', batch.outcomes[0].materials[0].file, 'ролик-1.mp4')
    equal('последняя идея — последний файл', batch.outcomes[14].materials[0].file, 'ролик-15.mp4')
    equal(
      'заголовков «Файлы: … и ещё N» больше нет',
      batch.outcomes.some((outcome) => outcome.idea.title.startsWith('Файлы:')),
      false,
    )
    equal('все пятнадцать в базе', await new IdeaRepository().count(), 15)
  }

  // Набранный текст достаётся первой идее, остальные остаются с именами файлов.
  {
    const batch = await captureMany({
      channel: 'file',
      text: 'что посмотреть в выходные',
      files: [file('раз.mp4'), file('два.mp4'), file('три.mp4')],
    })
    equal('текст стал заголовком первой идеи', batch.outcomes[0].idea.title, 'что посмотреть в выходные')
    equal('текст лёг в тело первой идеи', batch.outcomes[0].idea.body, 'что посмотреть в выходные')
    equal(
      'остальные идеи названы по файлам',
      batch.outcomes.slice(1).map((outcome) => outcome.idea.title),
      ['два.mp4', 'три.mp4'],
    )
    equal(
      'текст не размножился по остальным',
      batch.outcomes.slice(1).map((outcome) => outcome.idea.body),
      ['', ''],
    )
    equal('текст уехал в идею — поле можно чистить', batch.textConsumed, true)
  }

  // Сбой на одном файле не отменяет остальные.
  {
    await deleteDb()
    const realCreate = ideaRepository.create.bind(ideaRepository)
    let call = 0
    ideaRepository.create = async (input) => {
      call += 1
      if (call === 2) throw new Error('Место на устройстве закончилось')
      return realCreate(input)
    }
    try {
      const batch = await captureMany({
        channel: 'file',
        files: [file('первый.mp4'), file('сломанный.mp4'), file('третий.mp4')],
      })
      equal('сохранились два файла из трёх', batch.outcomes.length, 2)
      equal('сбой посчитан', batch.failed, 1)
      equal(
        'порядок выживших сохранён',
        batch.outcomes.map((outcome) => outcome.idea.title),
        ['первый.mp4', 'третий.mp4'],
      )
      equal('человек узнаёт, что один не прошёл', batch.warning, 'Сохранено 2 из 3: один файл не удалось сохранить.')
      equal('сломанного файла в базе нет', await new IdeaRepository().count(), 2)
      equal('материалов тоже два', await materialRepository.count(), 2)
    } finally {
      ideaRepository.create = realCreate
    }
  }

  // Текст не теряется, даже если не сохранился именно первый файл.
  {
    await deleteDb()
    const realCreate = ideaRepository.create.bind(ideaRepository)
    let call = 0
    ideaRepository.create = async (input) => {
      call += 1
      if (call === 1) throw new Error('Первый файл не сохранился')
      return realCreate(input)
    }
    try {
      const batch = await captureMany({
        channel: 'file',
        text: 'заметка про всю пачку',
        files: [file('сломанный.mp4'), file('второй.mp4')],
      })
      equal('текст подхватила первая удачная идея', batch.outcomes[0].idea.title, 'заметка про всю пачку')
      equal('и она про второй файл', batch.outcomes[0].materials[0].file, 'второй.mp4')
      equal('текст не потерян — поле можно чистить', batch.textConsumed, true)
    } finally {
      ideaRepository.create = realCreate
    }
  }

  // Два сбоя из трёх — число склоняется по-русски.
  {
    await deleteDb()
    const realCreate = ideaRepository.create.bind(ideaRepository)
    let call = 0
    ideaRepository.create = async (input) => {
      call += 1
      if (call === 1 || call === 3) throw new Error('Не сохранилось')
      return realCreate(input)
    }
    try {
      const batch = await captureMany({
        channel: 'file',
        files: [file('раз.mp4'), file('два.mp4'), file('три.mp4')],
      })
      equal('выжил один файл', batch.outcomes.length, 1)
      equal('сбоев два', batch.failed, 2)
      equal('сообщение склоняет «файла»', batch.warning, 'Сохранено 1 из 3: 2 файла не удалось сохранить.')
    } finally {
      ideaRepository.create = realCreate
    }
  }

  // Материалы не приложились к части идей — идеи на месте, но молчать нельзя.
  {
    await deleteDb()
    const realCreateMany = materialRepository.createMany.bind(materialRepository)
    let call = 0
    materialRepository.createMany = async (inputs) => {
      call += 1
      if (call === 2 || call === 3) throw new Error('Место на устройстве закончилось')
      return realCreateMany(inputs)
    }
    try {
      const batch = await captureMany({
        channel: 'file',
        files: [file('раз.mp4'), file('два.mp4'), file('три.mp4')],
      })
      equal('идеи сохранились все', batch.outcomes.length, 3)
      equal('сбоев файлов нет', batch.failed, 0)
      equal('идеи без материалов видны', batch.outcomes.filter((o) => o.materials.length === 0).length, 2)
      equal(
        'человек узнаёт, что материалов не хватает',
        batch.warning,
        'Материалы приложились не ко всем идеям: у 2 из 3 не получилось.',
      )
    } finally {
      materialRepository.createMany = realCreateMany
    }
  }

  // Ничего не сохранилось — честная ошибка, а не «частичный успех».
  {
    await deleteDb()
    const realCreate = ideaRepository.create.bind(ideaRepository)
    let threw = false
    let message = ''
    ideaRepository.create = async () => {
      throw new Error('Хранилище недоступно')
    }
    try {
      await captureMany({ channel: 'file', text: 'важное', files: [file('раз.mp4'), file('два.mp4')] })
    } catch (e) {
      threw = true
      message = e instanceof Error ? e.message : String(e)
    } finally {
      ideaRepository.create = realCreate
    }
    check('полный сбой бросает ошибку', threw, message)
    equal('причина видна человеку', message, 'Хранилище недоступно')
    equal('ни одной идеи не создано', await new IdeaRepository().count(), 0)
  }

  // Один файл — как раньше: одна идея, один материал.
  {
    await deleteDb()
    const batch = await captureMany({ channel: 'file', text: 'одна мысль', files: [file('единственный.mp4')] })
    equal('один файл — одна идея', batch.outcomes.length, 1)
    equal('сбоев нет', batch.failed, 0)
    equal('материал один', batch.outcomes[0].materials.length, 1)
    equal('заголовок — текст человека', batch.outcomes[0].idea.title, 'одна мысль')
    equal('текст уехал в идею', batch.textConsumed, true)
  }

  // «Поделиться» с двумя картинками — по-прежнему одна идея с двумя материалами.
  {
    await deleteDb()
    const batch = await captureMany({
      channel: 'share',
      files: [file('кадр1.jpg', 'image/jpeg'), file('кадр2.jpg', 'image/jpeg')],
    })
    equal('«Поделиться» — одна идея', batch.outcomes.length, 1)
    equal('в ней оба материала', batch.outcomes[0].materials.length, 2)
    equal('канал share_multiple сохранён', batch.outcomes[0].idea.captured_via, 'share_multiple')
  }

  // Пустой запрос и запрос без файлов.
  {
    await deleteDb()
    const textOnly = await captureMany({ channel: 'text', text: 'просто мысль' })
    equal('без файлов — одна идея', textOnly.outcomes.length, 1)
    equal('материалов нет', textOnly.outcomes[0].materials.length, 0)
    equal('сбоев нет', textOnly.failed, 0)

    let threw = false
    try {
      await captureMany({ channel: 'file' })
    } catch {
      threw = true
    }
    check('пустой захват отвергнут', threw)
  }

  // Склонение числа — на нём держатся сообщения.
  equal('1 файл', pluralRu(1, 'файл', 'файла', 'файлов'), 'файл')
  equal('2 файла', pluralRu(2, 'файл', 'файла', 'файлов'), 'файла')
  equal('5 файлов', pluralRu(5, 'файл', 'файла', 'файлов'), 'файлов')
  equal('11 файлов', pluralRu(11, 'файл', 'файла', 'файлов'), 'файлов')
  equal('21 файл', pluralRu(21, 'файл', 'файла', 'файлов'), 'файл')
}

// --- Журналы: слияние = union по id ----------------------------------------

section('Слияние журналов')
{
  const journalA: HistoryEntry[] = [
    { id: 'A1', idea_id: 'i', type: 'origin', at: '2026-01-01T00:00:00.000Z', actor: 'user', summary: 'a1', ai_reason: null, ref: null, meta: {} },
    { id: 'A2', idea_id: 'i', type: 'development', at: '2026-01-02T00:00:00.000Z', actor: 'ai', summary: 'a2', ai_reason: null, ref: null, meta: {} },
  ]
  const journalB: HistoryEntry[] = [
    { id: 'A2', idea_id: 'i', type: 'development', at: '2026-01-02T00:00:00.000Z', actor: 'ai', summary: 'a2', ai_reason: null, ref: null, meta: {} },
    { id: 'B1', idea_id: 'i', type: 'doubt', at: '2026-01-03T00:00:00.000Z', actor: 'user', summary: 'b1', ai_reason: null, ref: null, meta: {} },
  ]

  const merged = mergeHistory(journalA, journalB)
  equal('union по id', merged.items.map((e) => e.id), ['A1', 'A2', 'B1'])
  equal('добавилась одна', merged.added, 1)
  equal('совпавшая — без изменений', merged.unchanged, 1)

  const reverse = mergeHistory(merged.items, journalA)
  equal('повторное слияние ничего не меняет', reverse.items, merged.items)
  equal('повторное слияние: дубликатов нет', reverse.items.length, 3)

  const three = unionHistory(journalA, journalB, merged.items)
  equal('объединение трёх журналов', three.length, 3)

  const conflict = mergeHistory(journalA, [
    { ...journalA[0], summary: 'подменённая запись' },
  ])
  equal('при конфликте id остаётся существующая запись', conflict.items[0].summary, 'a1')
  equal('конфликт посчитан как kept', conflict.kept, 1)

  const empty = mergeHistory([], journalB)
  equal('слияние с пустым журналом', empty.items.length, 2)
}

// --- Экспорт / импорт ------------------------------------------------------

section('Экспорт и импорт')
{
  await deleteDb()
  const repo = new IdeaRepository()
  const history = new HistoryStore()
  const directions = new DirectionStore()

  const dacha = await directions.create({ name: 'Дача' })
  const idea = await repo.create(makeIdea('Теплица', { direction_id: dacha.id, moment_at: '2026-04-01T00:00:00.000Z', moment_rule: 'season' }))
  await history.append({ idea_id: idea.id, type: 'origin', summary: 'Появилась мысль' })
  await history.append({ idea_id: idea.id, type: 'development', summary: 'Развилка' })

  const file = await buildBackupFile(new Date('2026-10-21T00:00:00.000Z'))
  equal('формат файла', file.format, 'muza-backup')
  equal('версия схемы в файле', file.schema_version, 1)
  equal('в файле есть идеи', file.counts.ideas, 1)
  equal('в файле есть направления', file.counts.directions, 1)
  equal('в файле есть история', file.counts.history, 2)

  const text = serializeBackup(file)
  check('файл читаемый: с отступами', text.includes('\n  "format"'), text.slice(0, 40))
  check('файл заканчивается переводом строки', text.endsWith('\n'))

  const parsed = parseBackup(text)
  equal('разбор файла: идеи', parsed.ideas.length, 1)
  equal('разбор файла: направления', parsed.directions.length, 1)
  equal('разбор файла: история', parsed.history.length, 2)
  equal('круг «сборка → текст → разбор» не теряет данные', parsed.ideas[0], file.ideas[0])

  // Импорт того же файла на «новое устройство».
  await deleteDb()
  const report = await importBackupText(text)
  equal('импорт: добавлено идей', report.ideas.added, 1)
  equal('импорт: добавлено истории', report.history.added, 2)
  equal('импорт: добавлено направлений', report.directions.added, 1)
  equal('импорт: идей в базе', await new IdeaRepository().countAllRecords(), 1)
  equal('импорт: история в базе', await new HistoryStore().count(), 2)

  // Повторный импорт того же файла.
  const again = await importBackupText(text)
  equal('повторный импорт: ничего не добавилось', again.ideas.added, 0)
  equal('повторный импорт: история без дублей', again.history.added, 0)
  equal('повторный импорт: всё без изменений', again.ideas.unchanged, 1)
  equal('повторный импорт: идей по-прежнему одна', await new IdeaRepository().countAllRecords(), 1)
  equal('повторный импорт: история та же', await new HistoryStore().count(), 2)
  equal('повторный импорт: направление одно', await new DirectionStore().count(), 1)

  // Импорт в базу, где идея уже менялась локально.
  const localRepo = new IdeaRepository()
  await localRepo.update(idea.id, { title: 'Теплица (правка на месте)' })
  const third = await importBackupText(text)
  equal('местная правка не затёрта старым файлом', (await localRepo.get(idea.id))?.title, 'Теплица (правка на месте)')
  equal('старый файл посчитан как kept', third.ideas.kept, 1)

  // Импорт файла с новыми записями.
  const extra = buildBackup(
    {
      ideas: [...file.ideas, normalizeIdea(makeIdea('Пятая'))],
      directions: file.directions,
      history: [
        ...file.history,
        { id: 'NEW1', idea_id: idea.id, type: 'return', at: '2026-11-01T00:00:00.000Z', actor: 'user', summary: 'Вернулась', ai_reason: null, ref: null, meta: {} },
      ],
    },
    '2026-11-02T00:00:00.000Z',
  )
  const fourth = await importBackupText(serializeBackup(extra))
  equal('импорт дополняет базу', fourth.ideas.added, 1)
  equal('импорт дописывает журнал', fourth.history.added, 1)
  equal('старые записи журнала не тронуты', await new HistoryStore().count(), 3)

  // Ошибки разбора.
  const badCases: [string, string][] = [
    ['не JSON', 'это не json'],
    ['чужой файл', JSON.stringify({ hello: 'world' })],
    ['слишком новая схема', JSON.stringify({ format: 'muza-backup', schema_version: 999 })],
    ['пустой массив вместо объекта', '[]'],
  ]
  for (const [name, payload] of badCases) {
    let message = ''
    try {
      parseBackup(payload)
    } catch (e) {
      message = e instanceof Error ? e.message : String(e)
    }
    check(`разбор отвергает: ${name}`, message.length > 10, message)
  }

  // Файл без части коллекций тоже принимается.
  const partial = parseBackup(JSON.stringify({ format: 'muza-backup', schema_version: 1, ideas: [makeIdea('Одинокая')] }))
  equal('частичный файл: идеи есть', partial.ideas.length, 1)
  equal('частичный файл: история пустая', partial.history.length, 0)
  equal('частичный файл: meta пустая', partial.meta.length, 0)
}

// --- Скорость --------------------------------------------------------------

section('Скорость (на подделке, не в браузере)')
{
  await deleteDb()
  const repo = new IdeaRepository()
  const thousand = Array.from({ length: 1000 }, (_, i) => makeIdea(`Идея ${i}`, { direction_id: `dir-${i % 5}` }))

  const writeStart = performance.now()
  await repo.createMany(thousand)
  const writeMs = performance.now() - writeStart

  const readStart = performance.now()
  const list = await repo.list({ limit: 50 })
  const all = await repo.listAll()
  const readMs = performance.now() - readStart

  console.log(`  1000 идей: запись ${writeMs.toFixed(1)} мс, чтение+фильтр ${readMs.toFixed(1)} мс`)
  equal('сохранилось 1000 идей', await repo.count(), 1000)
  equal('listAll вернул 1000', all.length, 1000)
  equal('list с limit работает', list.length, 50)
  check('запись быстрее 2 секунд', writeMs < 2000, `${writeMs.toFixed(1)} мс`)
  check('чтение быстрее 2 секунд', readMs < 2000, `${readMs.toFixed(1)} мс`)

  const byIndexStart = performance.now()
  equal('чтение по индексу направления', (await repo.list({ direction_id: 'dir-3' })).length, 200)
  console.log(`  чтение по индексу: ${(performance.now() - byIndexStart).toFixed(1)} мс`)
}

// --- Выход идеи: выгрузка файлом и архив с причиной --------------------------

{
  console.log('\n— Выход идеи —')

  // Имя файла: кириллица сохраняется, запрещённые символы заменяются.
  equal('кириллица в имени не бьётся', safeFileName('Аэрогриль на 5 л', 'запас'), 'Аэрогриль на 5 л')
  equal('запрещённые символы заменены', safeFileName('фото/дача: лето?', 'запас'), 'фото-дача- лето')
  equal('пустое имя даёт запасное', safeFileName('   ', 'идея-2026'), 'идея-2026')
  equal('расширение по типу', extensionFor('video/mp4', 'video'), 'mp4')
  equal('расширение по роду, если тип неизвестен', extensionFor(null, 'image'), 'jpg')

  // Идея с текстом и материалом, у которого есть распознанный текст.
  const idea = await ideaRepository.create({
    title: 'Аэрогриль на 5 литров',
    body: 'Сравнить три варианта по цене',
  })
  // Файл кладём настоящий: без него в архиве нечего сохранять, и проверять
  // «материал лежит в выгрузке» было бы не на чем.
  const material = await materialRepository.create({
    idea_id: idea.id,
    kind: 'video',
    title: 'reel-про-аэрогриль',
    mime: 'video/mp4',
    blob: new Blob([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])], { type: 'video/mp4' }),
    extracted_text: 'Аэрогриль на пять литров, надо сравнить три варианта',
  })

  const file = await buildIdeaExport(idea.id)
  check('выгрузка собралась', file !== null)
  if (file) {
    check('имя файла из заголовка', file.fileName.startsWith('Аэрогриль на 5 литров'), file.fileName)

    const entries = unzipSync(file.bytes)
    const names = Object.keys(entries)
    const mdName = names.find((n) => n.endsWith('.md'))
    check('внутри есть .md', mdName !== undefined, names.join(', '))

    const md = mdName ? strFromU8(entries[mdName]!) : ''
    check('в .md есть заголовок', md.includes('# Аэрогриль на 5 литров'))
    check('в .md есть текст идеи', md.includes('Сравнить три варианта по цене'))
    // ГЛАВНОЕ: распознанный текст обязан быть в выгрузке.
    check(
      'в .md есть РАСПОЗНАННЫЙ текст материала',
      md.includes('надо сравнить три варианта'),
      'иначе человек получит файлы без того, что мы распознали',
    )
    check('в .md есть род материала', md.includes('видео'))
    check('материал лежит в архиве', names.some((n) => n.startsWith('материалы/')), names.filter((n) => n.startsWith('материалы/')).join(', '))
    check('русские имена внутри читаются', names.some((n) => n.includes('аэрогриль')))
  }

  // Идея без заголовка: имя должно быть понятным, а не «undefined».
  const noTitle = await ideaRepository.create({ body: 'просто мысль' })
  const noTitleFile = await buildIdeaExport(noTitle.id)
  check('идея без заголовка выгружается', noTitleFile !== null)
  check(
    'имя без «undefined»',
    Boolean(noTitleFile) && !/undefined/i.test(noTitleFile!.fileName),
    noTitleFile?.fileName ?? '',
  )

  // Идея без материалов — тоже валидный архив.
  const emptyIdea = await ideaRepository.create({ title: 'Только текст' })
  const emptyFile = await buildIdeaExport(emptyIdea.id)
  check('идея без материалов выгружается', emptyFile !== null)
  if (emptyFile) {
    const entries = unzipSync(emptyFile.bytes)
    check('архив без материалов валиден', Object.keys(entries).length >= 1)
  }

  // Архив: без причины нельзя.
  let refused = false
  try {
    await archiveIdea(idea.id, '   ')
  } catch {
    refused = true
  }
  check('архив без причины отвергается', refused)
  equal('причины на месте', ARCHIVE_REASONS.length, 3)

  const archived = await archiveIdea(idea.id, 'передумал')
  equal('статус стал archived', archived.status, 'archived')
  equal('причина записана', archived.archived_reason, 'передумал')

  const back = await restoreIdea(idea.id)
  equal('вернулась в inbox', back.status, 'inbox')
  equal('причина очищена', back.archived_reason, null)

  // История: её пишет exportIdea (buildIdeaExport — чистая сборка, без записи).
  const exported = await exportIdea(idea.id)
  check('exportIdea вернул файл', exported !== null)
  const history = await new HistoryStore().listByIdea(idea.id)
  const types = history.map((entry) => entry.type)
  check('в истории есть export', types.includes('export'))
  check('в истории есть archive', types.includes('archive'))
  check('в истории есть return', types.includes('return'))

  // Чистая сборка .md проверяется отдельно: она не должна зависеть от базы.
  const mdOnly = buildIdeaMarkdown({ ...idea, title: '', body: '' }, [], null)
  check('.md не падает на пустой идее', mdOnly.includes('Идея без названия'), mdOnly.split('\n')[0])
  check('без направления сказано прямо', mdOnly.includes('не разобрано'))
}

// --- Итог ------------------------------------------------------------------

console.log(`\n${'-'.repeat(60)}`)
if (failures.length > 0) {
  console.log(`ПРОВАЛЕНО: ${failures.length}, пройдено: ${passed}`)
  for (const failure of failures) console.log(`  • ${failure}`)
  process.exit(1)
} else {
  console.log(`Все проверки пройдены: ${passed}`)
}