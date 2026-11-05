/**
 * Настройки ИИ в хранилище `meta`.
 *
 * Ключ polza.ai больше не вводится и не хранится: модель работает через
 * прокси. Здесь — чтение, запись и удаление настроек, а также стирание
 * ключа, оставшегося от прошлых версий.
 */

import { META_KEYS, type MetaStore } from '../ai'
import { req, withTx } from '../data'
import type { MetaRecord } from '../data'

export { META_KEYS }

/** Значение настройки или undefined, если её нет. */
export async function readMetaValue(key: string): Promise<unknown> {
  const record = await withTx('meta', 'readonly', (tx) =>
    req<MetaRecord | undefined>(tx.objectStore('meta').get(key)),
  )
  return record?.value
}

/** Записывает значение, заменяя прежнее. */
export async function writeMetaValue(key: string, value: unknown): Promise<void> {
  const record: MetaRecord = { key, value, updated_at: new Date().toISOString() }
  await withTx('meta', 'readwrite', (tx) => {
    tx.objectStore('meta').put(record)
  })
}

/** Удаляет настройку: после этого ключа в базе нет. */
export async function deleteMetaValue(key: string): Promise<void> {
  await withTx('meta', 'readwrite', (tx) => {
    tx.objectStore('meta').delete(key)
  })
}

/** Хранилище настроек для `createLlmClient({ store })`. */
export const metaStore: MetaStore = {
  get: (key: string) => readMetaValue(key),
}

/**
 * Стирает ключ, оставшийся от прошлых версий.
 *
 * Ключ больше не нужен: модель работает через прокси, а в браузере секрету
 * не место. Экран ввода убран, поэтому и удалить его человеку негде —
 * стираем сами при запуске. Нет ключа — ничего не происходит.
 *
 * Возвращает `true`, если ключ действительно был и стёрт.
 */
export async function forgetStoredApiKey(): Promise<boolean> {
  const value = await readMetaValue(META_KEYS.apiKey)
  if (typeof value !== 'string' || value.trim() === '') return false
  await deleteMetaValue(META_KEYS.apiKey)
  return true
}
