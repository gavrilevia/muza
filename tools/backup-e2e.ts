/**
 * Сквозная проверка круга: база → выгрузка идеи → архив → восстановление.
 *
 * Запуск:
 *   node_modules/.bin/rolldown tools/backup-e2e.ts --dir node_modules/.tmp/e2e --format esm
 *   node node_modules/.tmp/e2e/backup-e2e.js
 *
 * Зачем отдельно от соседних проверок. `data-selftest.ts` проверяет слой
 * данных, `backup-roundtrip.ts` — формат архива на данных, собранных вручную.
 * Ни та, ни другая не проверяют, что материал, реально лежащий в базе, доедет
 * до архива и вернётся обратно. Здесь проверяется именно это, и проверка
 * построена так, чтобы падать, если материалы перестанут попадать в выгрузку:
 *
 *   1) идея и материал с настоящим файлом кладутся в базу репозиториями;
 *   2) настоящая `buildIdeaExport(idea.id)` читает их из базы — в её zip
 *      обязан лежать файл материала с теми же байтами;
 *   3) `collectBackupData()` + `buildBackup()` + `buildBackupZip()` собирают
 *      архив из этой же базы;
 *   4) `importBackupBytes()` восстанавливает архив в чистую базу;
 *   5) у вернувшегося материала совпадают id, kind, mime, размер и БАЙТЫ,
 *      а восстановленная идея снова выгружается с тем же файлом.
 *
 * IndexedDB в Node нет, поэтому ниже лежит та же ручная подделка, что и в
 * `tools/data-selftest.ts`: проверяется поведение репозиториев и архива,
 * а не особенности браузера.
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
// Сквозной круг: база → выгрузка идеи → архив → восстановление.
//
// Импорты стоят ниже подделки не случайно: они поднимаются наверх при
// загрузке модуля, но слой данных не трогает indexedDB до первого openDb(),
// поэтому подделка успевает встать в глобальные имена.
// ---------------------------------------------------------------------------

import {
  BACKUP_FORMAT,
  SCHEMA_VERSION,
  buildBackup,
  buildBackupZip,
  collectBackupData,
  deepEqual,
  deleteDb,
  ideaRepository,
  importBackupBytes,
  isUlid,
  looksLikeZip,
  materialRepository,
} from '../src/data'
import { buildIdeaExport } from '../src/data/exit'
import { unzipSync } from 'fflate'

let passed = 0
const failures: string[] = []

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed++
  } else {
    const line = `${name}${detail ? ` — ${detail}` : ''}`
    failures.push(line)
    console.log(`  ✗ ${line}`)
  }
}

function equal(name: string, actual: unknown, expected: unknown): void {
  check(
    name,
    deepEqual(actual, expected),
    `получено ${JSON.stringify(actual)}, ждали ${JSON.stringify(expected)}`,
  )
}

function section(title: string): void {
  console.log(`\n== ${title}`)
}

/** Сравнение байтов с указанием первого расхождения — иначе провал нечитаем. */
function compareBytes(actual: Uint8Array, expected: Uint8Array): { same: boolean; detail: string } {
  if (actual.length !== expected.length) {
    return { same: false, detail: `длина ${actual.length} вместо ${expected.length}` }
  }
  for (let index = 0; index < expected.length; index++) {
    if (actual[index] !== expected[index]) {
      return {
        same: false,
        detail: `расхождение в байте ${index}: ${actual[index]} вместо ${expected[index]}`,
      }
    }
  }
  return { same: true, detail: `${expected.length} байт совпали` }
}

/** Файл материала внутри zip выгрузки идеи: `материалы/NN-...`. */
function materialEntry(
  entries: Record<string, Uint8Array>,
): { name: string; bytes: Uint8Array } | null {
  for (const [name, bytes] of Object.entries(entries)) {
    if (name.startsWith('материалы/')) return { name, bytes }
  }
  return null
}

/** Сколько файлов материалов лежит в zip выгрузки идеи. */
function materialEntryNames(entries: Record<string, Uint8Array>): string[] {
  return Object.keys(entries).filter((name) => name.startsWith('материалы/'))
}

async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer())
}

/** Момент сборки архива — фиксированный, чтобы проверки были воспроизводимы. */
const EXPORTED_AT = '2026-11-05T12:00:00.000Z'

/**
 * Настоящие байты файла: 512 ненулевых, разных значений с сигнатурой PNG
 * в начале. Так «файл вернулся» проверяется на уровне содержимого, а не
 * только факта наличия записи.
 */
const ORIGINAL_BYTES = (() => {
  const bytes = new Uint8Array(512)
  bytes[0] = 0x89
  bytes[1] = 0x50
  bytes[2] = 0x4e
  bytes[3] = 0x47
  for (let index = 4; index < bytes.length; index++) {
    bytes[index] = (index * 37 + 11) % 256
  }
  return bytes
})()

// --- 1. База ----------------------------------------------------------------

section('База: идея и материал с настоящим файлом')

await deleteDb()

const idea = await ideaRepository.create({
  title: 'Теплица на даче',
  body: 'Собрать плёнку на дуги до морозов',
})
check('идея получила ULID', isUlid(idea.id), idea.id)

const material = await materialRepository.create({
  idea_id: idea.id,
  kind: 'image',
  title: 'фото-теплицы',
  mime: 'image/png',
  extracted_text: 'плёнка на дугах, три грядки',
  blob: new Blob([ORIGINAL_BYTES], { type: 'image/png' }),
})
check('материал получил ULID', isUlid(material.id), material.id)
equal('материал привязан к идее', material.idea_id, idea.id)
check('у материала настоящий файл', material.blob instanceof Blob)
equal('размер файла в базе', material.blob?.size, ORIGINAL_BYTES.length)
equal('в базе один материал', await materialRepository.count(), 1)

// --- 2. Первая половина: выгрузка одной идеи ---------------------------------

section('Первая половина: buildIdeaExport берёт материал из базы')

const exported = await buildIdeaExport(idea.id)
check('выгрузка идеи собралась', exported !== null)
const exportEntries: Record<string, Uint8Array> = exported ? unzipSync(exported.bytes) : {}
const exportMaterials = materialEntryNames(exportEntries)
const exportMaterial = materialEntry(exportEntries)

equal('в выгрузке идеи ровно один файл материала', exportMaterials.length, 1)
check(
  'файл материала назван по материалу',
  exportMaterial !== null && exportMaterial.name.includes('фото-теплицы'),
  exportMaterial?.name ?? exportMaterials.join(', '),
)
if (exportMaterial) {
  const comparison = compareBytes(exportMaterial.bytes, ORIGINAL_BYTES)
  check('БАЙТЫ В ВЫГРУЗКЕ ИДЕИ СОВПАЛИ', comparison.same, comparison.detail)
}

// --- 3. Вторая половина: архив из той же базы --------------------------------

section('Вторая половина: buildBackup и buildBackupZip')

const data = await collectBackupData()
const dataMaterials = data.materials ?? []
equal('в снимке базы один материал', dataMaterials.length, 1)

const snapshot = dataMaterials[0]
equal('id материала в снимке', snapshot?.id, material.id)
equal('kind материала в снимке', snapshot?.kind, 'image')
equal('mime материала в снимке', snapshot?.mime, 'image/png')
check('в снимке есть файл', snapshot?.blob instanceof Blob)
const snapshotBlob = snapshot?.blob
if (snapshotBlob) {
  equal('размер файла в снимке', snapshotBlob.size, ORIGINAL_BYTES.length)
  const comparison = compareBytes(await bytesOf(snapshotBlob), ORIGINAL_BYTES)
  check('БАЙТЫ В СНИМКЕ БАЗЫ СОВПАЛИ', comparison.same, comparison.detail)
}

const file = buildBackup(data, EXPORTED_AT)
equal('метка формата копии', file.format, BACKUP_FORMAT)
equal('версия схемы копии', file.schema_version, SCHEMA_VERSION)
equal('в копии одна идея', file.counts.ideas, 1)
equal('в копии один материал', file.counts.materials, 1)
equal('id материала в копии', file.materials[0]?.id, material.id)
equal('kind материала в копии', file.materials[0]?.kind, 'image')
equal('mime материала в копии', file.materials[0]?.mime, 'image/png')
check('в копии у материала есть файл', file.materials[0]?.blob instanceof Blob)
const fileBlob = file.materials[0]?.blob
if (fileBlob) {
  equal('размер файла в копии', fileBlob.size, ORIGINAL_BYTES.length)
  const comparison = compareBytes(await bytesOf(fileBlob), ORIGINAL_BYTES)
  check('БАЙТЫ В ФАЙЛЕ КОПИИ СОВПАЛИ', comparison.same, comparison.detail)
}

const archive = await buildBackupZip(data, EXPORTED_AT)
check('архив — это zip', looksLikeZip(archive), `первые байты: ${archive[0]},${archive[1]}`)
check(
  'архив не меньше самого файла',
  archive.length > ORIGINAL_BYTES.length,
  `${archive.length} байт`,
)

const archiveEntries: Record<string, Uint8Array> = unzipSync(archive)
const archiveMaterials = Object.keys(archiveEntries).filter((name) => name.startsWith('blobs/'))
equal('в архиве ровно один файл материала', archiveMaterials.length, 1)
equal('файл материала подписан его id', archiveMaterials[0], `blobs/${material.id}`)

const archiveBlob = archiveEntries[`blobs/${material.id}`]
check('файл материала лежит в архиве', archiveBlob !== undefined, archiveMaterials.join(', '))
if (archiveBlob) {
  const comparison = compareBytes(archiveBlob, ORIGINAL_BYTES)
  check('БАЙТЫ В АРХИВЕ СОВПАЛИ', comparison.same, comparison.detail)
}

// СТЫК двух путей: выгрузка одной идеи и общий архив обязаны нести один файл.
if (exportMaterial && archiveBlob) {
  const comparison = compareBytes(exportMaterial.bytes, archiveBlob)
  check(
    'СТЫК: в выгрузке идеи и в архиве одни и те же байты',
    comparison.same,
    comparison.detail,
  )
}

// --- 4. Восстановление в чистую базу -----------------------------------------

section('Восстановление на «новом устройстве»')

await deleteDb()
equal('перед восстановлением идей нет', await ideaRepository.count(), 0)
equal('перед восстановлением материалов нет', await materialRepository.count(), 0)

const report = await importBackupBytes(archive)
equal('версия схемы в отчёте', report.schema_version, SCHEMA_VERSION)
equal('идей добавлено', report.ideas.added, 1)
equal('материалов добавлено', report.materials.added, 1)
equal('материалов перезаписано', report.materials.updated, 0)

const restored = await materialRepository.get(material.id)
check('материал вернулся в базу', restored !== null)
if (restored) {
  equal('id совпал', restored.id, material.id)
  equal('kind совпал', restored.kind, 'image')
  equal('mime совпал', restored.mime, 'image/png')
  equal('файл привязан к той же идее', restored.idea_id, idea.id)
  check('файл восстановлен как Blob', restored.blob instanceof Blob)
  equal('размер файла совпал', restored.blob?.size, ORIGINAL_BYTES.length)
  const restoredBlob = restored.blob
  if (restoredBlob) {
    equal('тип у восстановленного Blob', restoredBlob.type, 'image/png')
    const comparison = compareBytes(await bytesOf(restoredBlob), ORIGINAL_BYTES)
    check('БАЙТЫ ПОСЛЕ ВОССТАНОВЛЕНИЯ СОВПАЛИ', comparison.same, comparison.detail)
  }
}

const byIdea = await materialRepository.listByIdea(idea.id)
equal('по идее читается один материал', byIdea.length, 1)
equal('listByIdea вернул тот же материал', byIdea[0]?.id, material.id)
check('идея вернулась в базу', (await ideaRepository.get(idea.id)) !== null)

// --- 5. Круг замкнулся -------------------------------------------------------

section('Круг замкнулся: восстановленная идея снова выгружается')

const reExported = await buildIdeaExport(idea.id)
check('выгрузка после восстановления собралась', reExported !== null)
const reEntries: Record<string, Uint8Array> = reExported ? unzipSync(reExported.bytes) : {}
const reMaterial = materialEntry(reEntries)

equal('в новой выгрузке ровно один файл материала', materialEntryNames(reEntries).length, 1)
check(
  'в новой выгрузке есть файл материала',
  reMaterial !== null,
  Object.keys(reEntries).join(', '),
)
if (reMaterial) {
  const comparison = compareBytes(reMaterial.bytes, ORIGINAL_BYTES)
  check('БАЙТЫ ДО И ПОСЛЕ КРУГА СОВПАЛИ', comparison.same, comparison.detail)
}

// --- Итог --------------------------------------------------------------------

console.log(`\n${'-'.repeat(60)}`)
if (failures.length > 0) {
  console.log(`ПРОВАЛЕНО: ${failures.length}, пройдено: ${passed}`)
  for (const failure of failures) console.log(`  • ${failure}`)
  process.exit(1)
} else {
  console.log(`Все проверки пройдены: ${passed}`)
}
