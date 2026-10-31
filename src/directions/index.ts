export { default as ExpenseLog } from './ExpenseLog.svelte'
export { clearExpenses, onExpenseRecorded, readExpenses, recordExpense, summarize } from './expenses'
export type { ExpenseEntry, ExpenseSummary } from './expenses'
export { readLearnedExamples } from './learning'
export type { LearnedExample } from './learning'
export { default as DirectionGrid } from './DirectionGrid.svelte'
/**
 * Точка входа блока «Направления».
 *
 * Интерфейс (App.svelte) знает только это:
 *   import { DirectionsPanel } from './directions'
 *
 * Разделение внутри:
 *   - `DirectionService` — классификация, слияние, лимиты (проверяется тестом);
 *   - `logic` — чистые решения (сопоставление названий, рубли);
 *   - `meta` — ключ polza.ai в хранилище `meta`, маска для экрана;
 *   - `keyCheck` — один дешёвый запрос «работает ли ключ»;
 *   - `suggest` — разбор ответа назывателя направлений;
 *   - `ApiKeyField` / `DirectionsPanel` — поле ключа и сетка направлений.
 */

export { default as DirectionsPanel } from './DirectionsPanel.svelte'
export { default as ApiKeyField } from './ApiKeyField.svelte'

export { DirectionService, directionService } from './DirectionService'
export type { AssignManyOptions } from './DirectionService'

export { checkApiKey } from './keyCheck'
export type { KeyCheckResult } from './keyCheck'

export { parseDirectionSuggestion } from './suggest'
export type { DirectionSuggestion } from './suggest'

export {
  MAX_DIRECTIONS,
  bestMatch,
  busiest,
  findByName,
  formatRub,
  ideaText,
  nameSimilarity,
  normalizeName,
} from './logic'

export {
  API_KEY_HINT,
  META_KEYS,
  deleteMetaValue,
  maskKey,
  metaStore,
  readApiKey,
  readMetaValue,
  writeMetaValue,
} from './meta'

export type {
  AssignManyResult,
  AssignOptions,
  AssignOutcome,
  AssignStatus,
  AssignStopReason,
  AssignmentProgress,
  DirectionServiceOptions,
  EnforceLimitsResult,
  IdeaMaterialsSource,
  MergeResult,
  SuggestNewResult,
} from './types'
