/**
 * Чистые решения сервиса направлений.
 *
 * Здесь нет ни базы, ни сети — только функции, которые можно проверить
 * обычным тестом на Node: сопоставление названий, выбор направления
 * под лимитом и формат рублей.
 */

import type { Direction, Idea, Material } from '../data'

/** Максимум направлений по контракту (АГЕНТЫ-РАЗРАБОТКИ.md, задача 5). */
export const MAX_DIRECTIONS = 9

/**
 * Сколько знаков идеи уходит модели.
 *
 * Зачем предел: расшифровка десятиминутного видео — это 8–10 тысяч знаков,
 * а классификатору нужно понять тему, а не прочитать всё подряд. 6000 знаков —
 * это примерно 2–3 тысячи токенов русского текста: один разбор по-прежнему
 * стоит доли копейки, но и длинная запись не раздувает запрос. Короткая
 * голосовая заметка или Reels (30 секунд — это 400–600 знаков) попадают
 * целиком; у длинного видео отрезается только хвост, а тема уже видна
 * по началу. Заголовок и тело идеи идут первыми, поэтому при обрезке
 * они сохраняются всегда.
 */
export const MAX_IDEA_TEXT_CHARS = 6000

/**
 * Обрезает текст до предела, не разрывая слово, и помечает обрезку многоточием.
 * Отдельная функция — чтобы предел проверялся тестом, а не жил в голове.
 */
export function limitText(text: string, limit = MAX_IDEA_TEXT_CHARS): string {
  const value = (text ?? '').trim()
  if (limit <= 0) return ''
  if (value.length <= limit) return value
  const head = value.slice(0, limit)
  const space = head.lastIndexOf(' ')
  // Режем по последнему пробелу, но не отдаём обрезке больше пятой части:
  // если пробелов почти нет (одно длинное слово), режем как есть.
  const cut = space >= limit * 0.8 ? head.slice(0, space) : head
  return `${cut.trimEnd()}…`
}

/**
 * Текст материалов идеи: расшифровки речи, OCR, текст ссылок — в порядке
 * появления материалов. Пустые пропускаем: необработанный материал ничего
 * не добавляет к разбору.
 */
export function materialsText(materials: readonly Material[]): string {
  return materials
    .map((material) => (material.extracted_text ?? '').trim())
    .filter((text) => text !== '')
    .join('\n\n')
}

/**
 * Текст идеи, который уходит модели: заголовок, тело и текст материалов.
 *
 * Материалы передаются снаружи: функция чистая и в базу сама не ходит.
 * Пустой список или материалы без текста ничего не меняют — получается
 * прежний «заголовок + тело».
 */
export function ideaText(idea: Idea, materials: readonly Material[] = []): string {
  const parts = [idea.title, idea.body]
    .map((part) => (part ?? '').trim())
    .filter(Boolean)
  const fromMaterials = materialsText(materials)
  if (fromMaterials !== '') parts.push(fromMaterials)
  return limitText(parts.join('\n'))
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
