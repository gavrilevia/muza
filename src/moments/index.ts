/**
 * Моменты: когда идея всплывает сама.
 *
 * Логика чистая и локальная — ни сети, ни денег: правила моментов считаются
 * на устройстве (`АРХИТЕКТУРА.md`, «Локально всё, что бесплатно»).
 */
export { default as MomentPanel } from './MomentPanel.svelte'
export {
  MOMENT_PRESETS,
  MOMENT_WINDOW_DAYS,
  dateInputValue,
  daysUntil,
  describeMoment,
  isRising,
  momentDateLabel,
  momentFromDateInput,
  momentFromDays,
  risingIdeas,
} from './logic'
