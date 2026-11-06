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
 *   - `meta` — настройки в хранилище `meta` (ключ больше не нужен);
 *   - `suggest` — разбор ответа назывателя направлений;
 *   - `DirectionsPanel` — сетка направлений.
 */

export { default as DirectionsPanel } from './DirectionsPanel.svelte'

export { DirectionService, directionService } from './DirectionService'
export {
  AUTO_DAILY_BUDGET_RUB,
  AUTO_MAX_PER_RUN,
  autoEligible,
  autoFingerprint,
  isAutoClassifyEnabled,
  readAutoState,
  runAutoClassify,
  setAutoClassifyEnabled,
} from './autoClassify'
export type { AutoClassifyReport, AutoClassifyState, AutoRecord } from './autoClassify'
export type { AssignManyOptions } from './DirectionService'

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
  META_KEYS,
  deleteMetaValue,
  forgetStoredApiKey,
  metaStore,
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
