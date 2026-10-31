/**
 * Другие поводы вспомнить: по СВЯЗИ и по ДЕЙСТВИЮ.
 *
 * Первый повод — срок — уже работает (`logic.ts`). Но идея приходит вовремя
 * не только по дате. Замысел (`АРХИТЕКТУРА.md`, §7) называет ещё несколько,
 * и здесь два из них:
 *
 * - **По связи**: рядом с этой идеей есть другие, про то же. Человек видит
 *   не одну мысль, а то, что вокруг неё уже собралось. Это отвечает на
 *   «а что я ещё про это думал?» — и работает **локально, без сети**.
 * - **По действию**: человек не заходил давно — и стоит напомнить о том,
 *   что лежит без движения. Не упрёком, а спокойно: «вот что ждёт».
 *
 * Третий повод — **по месту** — требует разрешения на геолокацию и решается
 * отдельно: у нас почти нет координат (они есть только у части фотографий),
 * и без данных он показывал бы пустоту.
 *
 * Всё считается на устройстве: ни сети, ни денег.
 */

import type { Idea, Material } from '../data'
import { keywords, similarity } from '../triage/logic'
import { looksLikeFileName } from '../media/naming'

/** Сколько дней без движения считаем «давно не виделись». */
export const AWAY_DAYS = 14

/** Сколько дней отсутствия делают напоминание уместным. */
export const RETURN_AFTER_DAYS = 3

/** Идеи, близкие по смыслу: заголовок, тело и РАСПОЗНАННЫЙ текст материалов. */
export function relatedIdeas(
  idea: Idea,
  ideas: readonly Idea[],
  materials: Record<string, Material[]>,
  limit = 3,
): { idea: Idea; score: number }[] {
  /**
   * Идея без имени файла: имя — не смысл.
   *
   * ⚠️ Это не косметика, а исправление настоящей ошибки: два РАЗНЫХ хеша
   * (`d2c22f18….mp4` и `8ef08327….mp4`) связывались между собой, потому что
   * расширение «mp4» считалось значимым словом. То есть все видео на свете
   * оказывались «про одно». Имя файла из сравнения убираем, а распознанный
   * текст материалов, наоборот, добавляем: смысл живёт в нём.
   */
  const withText = (item: Idea): Idea => {
    const text = (materials[item.id] ?? [])
      .map((material) => `${material.extracted_text ?? ''} ${material.comment ?? ''}`)
      .join(' ')
      .trim()
    const title = looksLikeFileName(item.title) ? '' : item.title
    const body = [item.body, text].filter((part) => part.trim() !== '').join(' ').trim()
    return { ...item, title, body }
  }

  const source = withText(idea)
  return ideas
    .filter((other) => other.id !== idea.id && other.status !== 'deleted')
    .map((other) => ({ idea: other, score: similarity(source, withText(other)) }))
    // Порог ниже, чем в разборе дублей, и это осознанно. Там мы предлагали
    // СЛИЯНИЕ, и ошибка была бы разрушительной. Здесь — только подсказка
    // «посмотри, рядом есть ещё». У коротких названий («гитара», «аккорды»,
    // «тюнер») одно общее значимое слово из четырёх — уже настоящая связь,
    // и порог 0.5 её терял.
    // 0,25 — это одно общее значимое слово из четырёх. Для короткого
    // названия это уже связь: «Разбор аккордов на гитаре» и «Тюнер для
    // гитары» не находят друг друга при пороге выше, хотя говорят об одном.
    // Это подсказка, а не утверждение, поэтому ложная связь не разрушительна
    // — в отличие от слияния дублей, где порог намеренно высокий.
    .filter((entry) => entry.score >= 0.25)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

/** Когда человек последний раз что-то делал. `null` — не знаем. */
export function lastSeenAt(entries: readonly { at: string }[]): string | null {
  if (entries.length === 0) return null
  return entries.reduce((latest, entry) => (entry.at > latest ? entry.at : latest), entries[0]!.at)
}

/** Сколько дней человек не заходил. */
export function daysAway(lastSeen: string | null, now: Date = new Date()): number | null {
  if (!lastSeen) return null
  const at = new Date(lastSeen)
  if (Number.isNaN(at.getTime())) return null
  return Math.floor((now.getTime() - at.getTime()) / 86_400_000)
}

/**
 * Что показать человеку, который давно не заходил.
 *
 * Показываем **не «заброшенное», а «ждущее»**: формулировка важна. Идея,
 * которая лежит, — не долг и не провал. Поэтому отбираем то, что само
 * просит внимания: близкий момент или давнее молчание.
 *
 * Возвращает пусто, если человек заходил недавно: без повода напоминать
 * нельзя, иначе это превращается в навязчивость.
 */
export function whileAway(
  ideas: readonly Idea[],
  lastSeen: string | null,
  now: Date = new Date(),
  limit = 3,
): Idea[] {
  const away = daysAway(lastSeen, now)
  if (away === null || away < RETURN_AFTER_DAYS) return []

  return ideas
    .filter(
      (idea) =>
        idea.status !== 'archived' &&
        idea.status !== 'deleted' &&
        // Спящие не всплывают: сон — это решение, а не долг.
        idea.status !== 'dormant',
    )
    .map((idea) => ({ idea, idle: idleDays(idea, now) }))
    .filter((entry) => entry.idle >= AWAY_DAYS)
    .sort((a, b) => b.idle - a.idle)
    .slice(0, limit)
    .map((entry) => entry.idea)
}

/** Сколько дней идея без движения. */
export function idleDays(idea: Idea, now: Date = new Date()): number {
  const last = new Date(idea.last_activity_at || idea.captured_at || idea.created_at)
  if (Number.isNaN(last.getTime())) return 0
  return Math.floor((now.getTime() - last.getTime()) / 86_400_000)
}

/** Похоже ли на имя файла: связи по хешу не бывает, и делать их не надо. */
export function looksLikeHashTitle(idea: Idea): boolean {
  return keywords(idea.title).size === 0
}
