/**
 * Моменты: когда идея всплывает сама.
 *
 * Это второе ядро замысла — «идея приходит вовремя». Реализация следует
 * `АРХИТЕКТУРА.md` (раздел 7) буквально, потому что там уже продумано,
 * чего момент делать **не должен**:
 *
 * - **не ставит дедлайн** — это планировщик, а мы нет;
 * - **не показывает «просрочено»** — после момента идея просто возвращается
 *   в список, без красного и без вины;
 * - **не требует действия** — можно проигнорировать, ничего не сломается;
 * - **не повторяет сам** — никаких всплывающих окон, только раздел.
 *
 * Окно показа: идея поднимается **за N дней до момента**. День рождения — 14
 * дней, сезон — 30, поездка — 21. Пока используем одно общее окно и даём
 * задать своё; у направления окно своё (по замыслу — в `directions.json`).
 */

import type { Idea } from '../data'

/** Сколько дней до момента идея уже поднимается. */
export const MOMENT_WINDOW_DAYS = 14

/** Готовые сроки для человека: подписи и через сколько дней. */
export const MOMENT_PRESETS = [
  { label: 'через неделю', days: 7 },
  { label: 'через месяц', days: 30 },
  { label: 'через 3 месяца', days: 90 },
] as const

/** Полночь местного времени — чтобы «завтра» считалось по календарю, а не по часам. */
function startOfDay(at: Date): number {
  return new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime()
}

/** Разница в целых днях по календарю: «сегодня», «завтра», «через 5 дней». */
export function daysUntil(momentAt: string | null, now: Date = new Date()): number | null {
  if (!momentAt) return null
  const target = new Date(momentAt)
  if (Number.isNaN(target.getTime())) return null
  const diff = startOfDay(target) - startOfDay(now)
  return Math.round(diff / 86_400_000)
}

/**
 * Наступил ли момент — то есть пора ли показать идею.
 *
 * Момент **уже прошедший** сюда не попадает: по замыслу идея после момента
 * просто возвращается в обычный список. Показывать её как «просроченную»
 * запрещено — мы не планировщик и не хотим вызывать чувство вины.
 */
export function isRising(
  idea: Idea,
  now: Date = new Date(),
  windowDays: number = MOMENT_WINDOW_DAYS,
): boolean {
  const days = daysUntil(idea.moment_at, now)
  if (days === null) return false
  // Уже в архиве — не всплывает: она ушла осознанно.
  if (idea.status === 'archived' || idea.status === 'deleted') return false
  return days >= 0 && days <= windowDays
}

/** Идеи, у которых момент близко, — от самого близкого к дальнему. */
export function risingIdeas(
  ideas: readonly Idea[],
  now: Date = new Date(),
  windowDays: number = MOMENT_WINDOW_DAYS,
): Idea[] {
  return ideas
    .filter((idea) => isRising(idea, now, windowDays))
    .sort((a, b) => (daysUntil(a.moment_at, now) ?? 0) - (daysUntil(b.moment_at, now) ?? 0))
}

/**
 * Как сказать человеку про срок.
 *
 * Никаких «осталось 3 дня» и «просрочено на 2 дня»: момент — повод вспомнить,
 * а не срок сдачи. Поэтому формулировки только спокойные.
 */
export function describeMoment(momentAt: string | null, now: Date = new Date()): string {
  const days = daysUntil(momentAt, now)
  if (days === null) return 'без срока'
  if (days === 0) return 'сегодня'
  if (days === 1) return 'завтра'
  if (days > 1) return `через ${days} ${plural(days, 'день', 'дня', 'дней')}`
  if (days === -1) return 'вчера'
  return `${Math.abs(days)} ${plural(Math.abs(days), 'день', 'дня', 'дней')} назад`
}

function plural(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10
  const mod100 = count % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few
  return many
}

/** Дата для подписи: «12 октября» — человеку, а не машине. */
export function momentDateLabel(momentAt: string | null): string {
  if (!momentAt) return ''
  const date = new Date(momentAt)
  if (Number.isNaN(date.getTime())) return ''
  try {
    return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' }).format(date)
  } catch {
    return date.toISOString().slice(0, 10)
  }
}

/** Дата и время, через которые наступит момент: для готовых сроков. */
export function momentFromDays(days: number, now: Date = new Date()): string {
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  at.setDate(at.getDate() + days)
  // Время ставим утреннее: к нему идея и должна быть «кстати».
  at.setHours(9, 0, 0, 0)
  return at.toISOString()
}

/** Значение для `<input type="date">`: местная дата, без сдвига часового пояса. */
export function dateInputValue(momentAt: string | null): string {
  if (!momentAt) return ''
  const date = new Date(momentAt)
  if (Number.isNaN(date.getTime())) return ''
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** Из значения `<input type="date">` — момент на утро этого дня. */
export function momentFromDateInput(value: string, now: Date = new Date()): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
  if (!match) return null
  const [, year, month, day] = match
  const at = new Date(Number(year), Number(month) - 1, Number(day), 9, 0, 0, 0)
  if (Number.isNaN(at.getTime())) return null
  void now
  return at.toISOString()
}
