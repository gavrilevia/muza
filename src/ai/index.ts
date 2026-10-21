/**
 * Точка входа модуля ИИ-клиента.
 *
 * Снаружи (из UI, очередей обработки, сервисов направлений) нужно только это:
 *
 * ```ts
 * const store = { get: async (key: string) => (await db.read('meta', key))?.value }
 * const client = await createLlmClient({ store })
 * const result = await classifyIdea(client, { text: idea.title }, { directions })
 * if (result.ok && result.data.direction_applied) {
 *   // записываем направление; стоимость — в result.usage.costRub
 * }
 * ```
 *
 * Если ключа нет — `result.ok` равно false, код ошибки `no_key`,
 * сеть не трогается вообще.
 */

import { loadLlmConfig, type LlmConfig, type MetaStore } from './config'
import { LlmClient, type LlmClientDeps } from './LlmClient'
import type { LlmResult } from './types'

export * from './types'
export * from './config'
export * from './prompts'
export * from './validate'
export * from './classify'
export { LlmClient, emptyUsage, failureResult } from './LlmClient'
export type { LlmClientDeps, LlmUsageEvent } from './LlmClient'

/** Что нужно, чтобы собрать клиент: хранилище настроек и необязательные правки. */
export interface CreateLlmClientOptions {
  /** Хранилище `meta` из IndexedDB (слой данных пишет другой агент). */
  store?: MetaStore
  /** Явные переопределения конфига — сильнее значений из хранилища. */
  config?: Partial<LlmConfig>
  /** Подмена сети и приёмник расхода (в основном для тестов). */
  deps?: LlmClientDeps
}

/**
 * Собирает клиента: читает ключ и настройки из хранилища.
 * Ключ в коде не хранится — только в `meta` или в явном параметре.
 */
export async function createLlmClient(options: CreateLlmClientOptions = {}): Promise<LlmClient> {
  const config = await loadLlmConfig(options.store, options.config ?? {})
  return new LlmClient(config, options.deps)
}

/** Быстрая проверка перед постановкой задачи в очередь: есть ли вообще ключ. */
export async function isLlmConfigured(store?: MetaStore): Promise<boolean> {
  const config = await loadLlmConfig(store)
  return config.apiKey.trim() !== ''
}

/** Проброс типа результата — чтобы потребителю хватало одного импорта. */
export type { LlmResult }