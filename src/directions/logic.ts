/**
 * Чистые решения сервиса направлений.
 *
 * Здесь нет ни базы, ни сети — только функции, которые можно проверить
 * обычным тестом на Node: сопоставление названий, выбор направления
 * под лимитом и формат рублей.
 */

import type { Direction, Idea } from '../data'

/** Максимум направлений по контракту (АГЕНТЫ-РАЗРАБОТКИ.md, задача 5). */
export const MAX_DIRECTIONS = 9

/** Текст идеи, который уходит модели: заголовок и тело. */
export function ideaText(idea: Idea): string {
  return [idea.title, idea.body]
    .map((part) => (part ?? '').trim())
    .filter(Boolean)
    .join('\n')
}

/**
 * Приведение названия к сравнимому виду: регистр, «ё», лишние знаки.
 * Нужно, чтобы «Подарки» и «подарки!» считались одним направлением,
 * а не заводили второе такое же.
 */
export function normalizeName(name: string): string {
  return (name ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/gi, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

/** Пары соседних символов — основа сравнения названий. */
function bigrams(value: string): Set<string> {
  const compact = value.replace(/\s+/g, '')
  const result = new Set<string>()
  if (compact.length <= 2) {
    if (compact) result.add(compact)
    return result
  }
  for (let i = 0; i < compact.length - 1; i += 1) result.add(compact.slice(i, i + 2))
  return result
}

/**
 * Похожесть двух названий от 0 до 1 (коэффициент Дайса по парам букв).
 * Простая и предсказуемая мера: без неё при лимите 9 не понять, к какому
 * из направлений отнести идею, для которой модели предложила новое имя.
 */
export function nameSimilarity(left: string, right: string): number {
  const a = normalizeName(left).replace(/ /g, '')
  const b = normalizeName(right).replace(/ /g, '')
  if (!a || !b) return 0
  if (a === b) return 1

  const ga = bigrams(a)
  const gb = bigrams(b)
  let common = 0
  for (const gram of ga) if (gb.has(gram)) common += 1
  return (2 * common) / (ga.size + gb.size)
}

/** Направление с таким же (нормализованным) названием; null — такого нет. */
export function findByName(directions: readonly Direction[], name: string): Direction | null {
  const target = normalizeName(name)
  if (!target) return null
  return directions.find((direction) => normalizeName(direction.name) === target) ?? null
}

/**
 * Самое похожее по названию направление.
 * `minSimilarity` отсекает случайные совпадения: при нуле похожести
 * лучше оставить идею без направления, чем положить её не туда.
 */
export function bestMatch(
  directions: readonly Direction[],
  name: string,
  minSimilarity = 0.34,
): Direction | null {
  let best: Direction | null = null
  let bestScore = 0
  for (const direction of directions) {
    const score = nameSimilarity(direction.name, name)
    if (score > bestScore) {
      bestScore = score
      best = direction
    }
  }
  return bestScore >= minSimilarity ? best : null
}

/** Направление с наибольшим числом идей; при равенстве — раньше по порядку. */
export function busiest(
  counts: ReadonlyMap<string, number>,
  directions: readonly Direction[],
): Direction | null {
  let best: Direction | null = null
  let bestCount = -1
  for (const direction of directions) {
    const count = counts.get(direction.id) ?? 0
    if (count > bestCount) {
      bestCount = count
      best = direction
    }
  }
  return best
}

/**
 * Рубли для экрана. Дешёвая обработка одной идеи стоит меньше копейки,
 * поэтому при малых суммах показываем больше знаков, а не «0.00 ₽».
 */
export function formatRub(cost: number): string {
  if (!Number.isFinite(cost) || cost <= 0) return '0 ₽'
  if (cost < 0.01) return `${cost.toFixed(4)} ₽`
  return `${cost.toFixed(2)} ₽`
}
