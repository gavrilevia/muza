/**
 * Открытие IndexedDB, создание объектных хранилищ и индексов, миграции.
 *
 * Состав хранилищ и индексов — из АРХИТЕКТУРА-PWA.md, раздел 3.3.
 *
 * Правило миграций: `onupgradeneeded` — единственное место, где меняется схема.
 * Каждая версия добавляется отдельным блоком `if (oldVersion < N)`, блоки
 * идут по возрастанию и не переписывают прошлые. Так база пользователя,
 * прожившая год, доезжает до текущей схемы без потери данных.
 *
 * ВАЖНО про транзакции: внутри `withTx` можно ждать только запросы IndexedDB.
 * Любой `await` на постороннем промисe (сеть, чтение файла, таймер) закрывает
 * транзакцию, и следующие операции падают с InvalidStateError. Поэтому разбор
 * файла и подготовка данных делаются до открытия транзакции.
 */

/** Имя базы. */
export const DB_NAME = 'muza'

/**
 * Текущая версия схемы.
 * 1 — хранилища ideas / materials / directions / history / queue / vectors / events / meta.
 */
export const DB_VERSION = 1

/** Объектные хранилища. */
export const STORES = [
  'ideas',
  'materials',
  'directions',
  'history',
  'queue',
  'vectors',
  'events',
  'meta',
] as const

export type StoreName = (typeof STORES)[number]

/** Ключи хранилищ: где первичный ключ — своё поле, где — значение целиком. */
export interface StoreSpec {
  keyPath: string
  indexes: { name: string; keyPath: string; unique?: boolean }[]
}

/** Полное описание схемы версии 1. */
export const SCHEMA_V1: Record<StoreName, StoreSpec> = {
  ideas: {
    keyPath: 'id',
    indexes: [
      { name: 'by_direction', keyPath: 'direction_id' },
      { name: 'by_moment', keyPath: 'moment_at' },
      { name: 'by_status', keyPath: 'status' },
      { name: 'by_activity', keyPath: 'last_activity_at' },
    ],
  },
  materials: {
    keyPath: 'id',
    indexes: [
      { name: 'by_idea', keyPath: 'idea_id' },
      { name: 'by_extraction', keyPath: 'extraction' },
      { name: 'by_added', keyPath: 'added_at' },
    ],
  },
  directions: {
    keyPath: 'id',
    indexes: [{ name: 'by_order', keyPath: 'order' }],
  },
  history: {
    keyPath: 'id',
    indexes: [
      { name: 'by_idea', keyPath: 'idea_id' },
      { name: 'by_at', keyPath: 'at' },
    ],
  },
  queue: {
    keyPath: 'id',
    indexes: [
      { name: 'by_next_try', keyPath: 'next_try_at' },
      { name: 'by_status', keyPath: 'status' },
      { name: 'by_idea', keyPath: 'idea_id' },
    ],
  },
  // Векторы: ключ — сама идея, значение — запись с Float32Array.
  vectors: {
    keyPath: 'idea_id',
    indexes: [],
  },
  events: {
    keyPath: 'id',
    indexes: [
      { name: 'by_ts', keyPath: 'ts' },
      { name: 'by_type', keyPath: 'type' },
    ],
  },
  meta: {
    keyPath: 'key',
    indexes: [],
  },
}

/** Ошибка слоя хранения с понятным русским текстом. */
export class StorageError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = 'StorageError'
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause
  }
}

/** Открытая база кэшируется: соединение нужно одно на вкладку. */
let dbPromise: Promise<IDBDatabase> | null = null

/** Создаёт хранилище, если его ещё нет, и все его индексы. */
function applyStoreSpec(db: IDBDatabase, tx: IDBTransaction, name: StoreName): void {
  const spec = SCHEMA_V1[name]
  const store = db.objectStoreNames.contains(name)
    ? tx.objectStore(name)
    : db.createObjectStore(name, { keyPath: spec.keyPath })

  for (const index of spec.indexes) {
    if (!store.indexNames.contains(index.name)) {
      store.createIndex(index.name, index.keyPath, { unique: index.unique ?? false })
    }
  }
}

/**
 * Миграции. Порядок обязателен: от старых версий к новым.
 * Новую версию добавляем блоком ниже, не меняя прошлые.
 */
function migrate(db: IDBDatabase, tx: IDBTransaction, oldVersion: number): void {
  if (oldVersion < 1) {
    for (const name of STORES) applyStoreSpec(db, tx, name)
  }
  // Пример будущей миграции:
  // if (oldVersion < 2) { ... }
}

/** Открывает базу, при необходимости выполняя миграции. */
export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined' || !indexedDB) {
      reject(
        new StorageError(
          'IndexedDB недоступна в этом окружении. Идеи некуда сохранять — ' +
            'проверьте, что приложение открыто в обычном (не приватном) окне браузера.',
        ),
      )
      return
    }

    let request: IDBOpenDBRequest
    try {
      // Префикс имени базы — чтобы на одном домене не столкнуться с чужими базами.
      request = indexedDB.open(DB_NAME, DB_VERSION)
    } catch (e) {
      reject(new StorageError('Не удалось открыть базу IndexedDB.', e))
      return
    }

    request.onupgradeneeded = (event) => {
      const db = request.result
      const tx = request.transaction
      if (!tx) {
        reject(new StorageError('IndexedDB не дала транзакцию миграции.'))
        return
      }
      try {
        migrate(db, tx, event.oldVersion)
      } catch (e) {
        // Отменяем транзакцию: база останется в прежней версии, данные целы.
        tx.abort()
        reject(new StorageError('Миграция схемы IndexedDB не удалась.', e))
      }
    }

    request.onblocked = () => {
      // Другая вкладка держит старую версию базы и не закрывает её.
      reject(
        new StorageError(
          'База заблокирована другой вкладкой приложения. Закройте лишние вкладки и обновите страницу.',
        ),
      )
    }

    request.onerror = () => {
      reject(new StorageError('Не удалось открыть базу IndexedDB.', request.error))
    }

    request.onsuccess = () => {
      const db = request.result

      // Другая вкладка подняла версию схемы: отпускаем соединение,
      // иначе её миграция будет ждать вечно.
      db.onversionchange = () => {
        db.close()
        dbPromise = null
      }

      resolve(db)
    }
  })

  // Неудачное открытие не кэшируем: следующий вызов попробует снова.
  dbPromise.catch(() => {
    dbPromise = null
  })

  return dbPromise
}

/** Закрывает соединение. Нужно тестам и смене версии схемы. */
export async function closeDb(): Promise<void> {
  if (!dbPromise) return
  const pending = dbPromise
  dbPromise = null
  try {
    const db = await pending
    db.close()
  } catch {
    /* база и не открылась — закрывать нечего */
  }
}

/**
 * Удаляет базу целиком. Опасная операция: только для отладки и тестов,
 * в интерфейсе её быть не должно.
 */
export async function deleteDb(): Promise<void> {
  // Своё соединение закрываем сами: иначе удаление навсегда останется
  // «заблокированным» и база не исчезнет.
  await closeDb()
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined' || !indexedDB) {
      resolve()
      return
    }
    const request = indexedDB.deleteDatabase(DB_NAME)
    request.onsuccess = () => {
      dbPromise = null
      resolve()
    }
    request.onerror = () => reject(new StorageError('Не удалось удалить базу.', request.error))
    request.onblocked = () => resolve() // кто-то держит соединение — удалится позже
  })
}

/** Превращает IDBRequest в промис. */
export function req<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new StorageError('Запрос IndexedDB не удался.'))
  })
}

/** Ждёт завершения транзакции (complete) или отклоняет её ошибку. */
export function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new StorageError('Транзакция IndexedDB не удалась.'))
    tx.onabort = () =>
      reject(tx.error ?? new StorageError('Транзакция IndexedDB отменена.'))
  })
}

/**
 * Выполняет работу в транзакции.
 *
 * `work` должен пользоваться только запросами IndexedDB (см. замечание
 * о транзакциях в начале файла). Если `work` бросает исключение, транзакция
 * отменяется — база не остаётся в половинчатом состоянии.
 */
export async function withTx<T>(
  stores: StoreName | StoreName[],
  mode: IDBTransactionMode,
  work: (tx: IDBTransaction) => Promise<T> | T,
): Promise<T> {
  const db = await openDb()
  const names = Array.isArray(stores) ? stores : [stores]
  const tx = db.transaction(names, mode)
  const done = txDone(tx)
  let result: T
  try {
    result = await work(tx)
  } catch (e) {
    try {
      tx.abort()
    } catch {
      /* транзакция уже завершилась */
    }
    // Отменённую транзакцию ждём молча: наверх уходит исходная ошибка,
    // а не служебное «транзакция отменена».
    await done.catch(() => undefined)
    throw e
  }
  await done
  return result
}

/** Все записи хранилища. */
export function getAll<T>(store: StoreName): Promise<T[]> {
  return withTx(store, 'readonly', (tx) => req<T[]>(tx.objectStore(store).getAll()))
}

/** Все записи по индексу, при необходимости — в диапазоне ключей. */
export function getAllByIndex<T>(
  store: StoreName,
  index: string,
  range?: IDBKeyRange | null,
): Promise<T[]> {
  return withTx(store, 'readonly', (tx) =>
    req<T[]>(tx.objectStore(store).index(index).getAll(range ?? null)),
  )
}

/**
 * Обход записей хранилища через курсор.
 *
 * Обязательно вызывать ВНУТРИ тела `withTx` и передавать ту же транзакцию:
 * курсор живёт, пока транзакция активна. Обработчик `visit` может звать
 * `cursor.update(...)`/`cursor.delete()` — это те же запросы IndexedDB.
 */
export function iterateStore<T>(
  tx: IDBTransaction,
  store: StoreName,
  visit: (value: T, cursor: IDBCursorWithValue) => void,
  options: { range?: IDBKeyRange | null; direction?: IDBCursorDirection } = {},
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const request = tx
      .objectStore(store)
      .openCursor(options.range ?? null, options.direction ?? 'next')
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) {
        resolve()
        return
      }
      try {
        visit(cursor.value as T, cursor)
      } catch (e) {
        reject(e)
        return
      }
      cursor.continue()
    }
    request.onerror = () =>
      reject(request.error ?? new StorageError('Обход записей IndexedDB не удался.'))
  })
}

/** Обход записей по индексу. Условия те же, что у `iterateStore`. */
export function iterateIndex<T>(
  tx: IDBTransaction,
  store: StoreName,
  index: string,
  range: IDBKeyRange | null,
  visit: (value: T, cursor: IDBCursorWithValue) => void,
  direction: IDBCursorDirection = 'next',
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const request = tx.objectStore(store).index(index).openCursor(range ?? null, direction)
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) {
        resolve()
        return
      }
      try {
        visit(cursor.value as T, cursor)
      } catch (e) {
        reject(e)
        return
      }
      cursor.continue()
    }
    request.onerror = () =>
      reject(request.error ?? new StorageError('Обход индекса IndexedDB не удался.'))
  })
}

/** Кладёт много записей в одно хранилище одной транзакцией. */
export function putMany<T>(store: StoreName, items: readonly T[]): Promise<void> {
  return withTx(store, 'readwrite', (tx) => {
    const target = tx.objectStore(store)
    for (const item of items) target.put(item)
  })
}

/** Число записей в хранилище. */
export function countAll(store: StoreName): Promise<number> {
  return withTx(store, 'readonly', (tx) => req<number>(tx.objectStore(store).count()))
}

/** Число записей в диапазоне ключей индекса. */
export function countByIndex(
  store: StoreName,
  index: string,
  range?: IDBKeyRange | null,
): Promise<number> {
  return withTx(store, 'readonly', (tx) =>
    range
      ? req<number>(tx.objectStore(store).index(index).count(range))
      : req<number>(tx.objectStore(store).index(index).count()),
  )
}

/**
 * Оценка состояния хранилища: сколько места занято и защищено ли оно.
 * Данные берутся у браузера; если он не умеет — возвращаются null-поля.
 */
export async function storageEstimate(): Promise<{
  usage: number | null
  quota: number | null
  persisted: boolean | null
}> {
  const out: { usage: number | null; quota: number | null; persisted: boolean | null } = {
    usage: null,
    quota: null,
    persisted: null,
  }
  try {
    if (navigator.storage?.estimate) {
      const estimate = await navigator.storage.estimate()
      out.usage = estimate.usage ?? null
      out.quota = estimate.quota ?? null
    }
    if (navigator.storage?.persisted) out.persisted = await navigator.storage.persisted()
  } catch {
    /* браузер отказал — не критично */
  }
  return out
}