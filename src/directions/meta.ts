/**
 * Настройки ИИ в хранилище `meta`.
 *
 * Ключ polza.ai не хардкодится и не коммитится: он живёт только в `meta`
 * (IndexedDB) и попадает в конфиг клиента через `MetaStore`. Здесь — чтение,
 * запись и удаление таких значений плюс маска для экрана.
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

/** Прочитанный ключ API или пустая строка. Никогда не логируется целиком. */
export async function readApiKey(): Promise<string> {
  const value = await readMetaValue(META_KEYS.apiKey)
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Маска для экрана: видно начало и самый конец, середина скрыта.
 * Так пользователь узнаёт свой ключ, но полный секрет не мозолит глаза
 * и не попадает на скриншот.
 */
export function maskKey(key: string): string {
  const value = (key ?? '').trim()
  if (value === '') return ''
  if (value.length < 12) return '••••••'
  return `${value.slice(0, 3)}…${value.slice(-4)}`
}

/**
 * Короткая подсказка для пустого поля: где взять ключ.
 * Ссылка на провайдера уходит в интерфейс, здесь только текст.
 */
export const API_KEY_HINT =
  'Ключ берётся в личном кабинете polza.ai. Он хранится только в этом браузере и никуда не отправляется, кроме самого сервиса модели.'
