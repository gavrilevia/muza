/**
 * Подбор: «что сейчас кстати из того, что есть».
 *
 * Главная функция продукта. Уровень 1 — локальный фильтр: всегда, бесплатно,
 * офлайн (`АРХИТЕКТУРА.md`, §8). Уровень 2 — ранжирование моделью по кнопке
 * и только по 20 кандидатам, а не по всей базе.
 */
export { default as SelectPanel } from './SelectPanel.svelte'
export {
  QUICK_MINUTES,
  SELECT_LIMIT,
  WEIGHTS,
  describeFilters,
  parseRequest,
  selectIdeas,
} from './logic'
export type { SelectCandidate, SelectFilters } from './logic'
