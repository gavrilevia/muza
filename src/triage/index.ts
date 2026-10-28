/**
 * Триаж: разбор входящих.
 *
 * Уборка, а не ценность (`КОНЦЕПЦИЯ-v1.md`): три решения одним тапом,
 * правило 90 дней и решение вопроса про дубли. Всё локально и бесплатно.
 */
export { default as TriagePanel } from './TriagePanel.svelte'
export { canMerge, mergeIdeas } from './merge'
export type { MergeOutcome } from './merge'
export {
  SIMILAR_THRESHOLD,
  STAGNANT_DAYS,
  daysIdle,
  keywords,
  needsTriage,
  similarTo,
  similarity,
  statusFor,
  triageQueue,
  triageReason,
} from './logic'
export type { TriageDecision } from './logic'
