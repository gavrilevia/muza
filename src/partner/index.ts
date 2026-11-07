/**
 * Партнёрские предложения — только по явному запросу.
 *
 * Интерфейс будет знать только это; правила живут в `logic` и проверяются
 * в Node, без сети и без модели.
 */

export {
  BUDGET_BUCKETS,
  BUDGET_LABELS,
  CATEGORY_LABELS,
  MAX_CITY_LENGTH,
  MAX_QUERY_LENGTH,
  PARTNER_CATEGORIES,
  TREND_MIN_COUNT,
  buildPartnerUrl,
  canPublishTrend,
  normalizePartnerQuery,
  trendSlice,
} from './logic'
export type { BudgetBucket, PartnerCategory, PartnerQuery, PartnerQueryInput } from './logic'

export { default as PartnerSheet } from './PartnerSheet.svelte'
