/**
 * Повод ПО МЕСТУ — без геолокации и без разрешений.
 *
 * Так было задумано изначально: «пришёл в магазин техники — всплыло то,
 * что хотел там посмотреть». Но у браузера для этого нужны **координаты**,
 * а их нет почти ни у кого: они есть только у части фотографий. Функция
 * показывала бы пустоту — и человек решил бы, что она сломана.
 *
 * Поэтому место здесь — **слово человека, а не координата**. «Дача»,
 * «Леруа», «гараж» — так, как он сам это называет. Тогда:
 *
 * - работает **без разрешений** и без сети;
 * - не врёт: если мест нет, мы честно молчим, а не показываем пустой список;
 * - совпадает с тем, как человек думает: он говорит «на даче», а не
 *   «55.7558, 37.6173».
 *
 * Где храним: в свойствах идеи (`props.place`). Свойства для этого и есть —
 * короткие слова самого человека, по которым потом ищут.
 */

import type { Idea } from '../data'

/** Ключ в свойствах идеи. */
export const PLACE_KEY = 'place'

/** Место идеи, если человек его назвал. */
export function placeOf(idea: Idea): string | null {
  const raw = (idea.props ?? {})[PLACE_KEY]
  if (typeof raw !== 'string') return null
  const place = normalizePlace(raw)
  return place === '' ? null : place
}

/** Чистит название места: лишние пробелы и регистр не должны дробить список. */
export function normalizePlace(value: string): string {
  const clean = value.trim().replace(/\s+/g, ' ')
  if (clean === '') return ''
  // Первую букву — заглавной: «дача» и «Дача» это одно место, и в списке
  // они не должны стоять двумя строками.
  return clean.charAt(0).toUpperCase() + clean.slice(1)
}

/** Места со счётчиком: от частых к редким. Пустые не показываем. */
export function placesOf(ideas: readonly Idea[]): { place: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const idea of ideas) {
    if (idea.status === 'archived' || idea.status === 'deleted') continue
    const place = placeOf(idea)
    if (place === null) continue
    counts.set(place, (counts.get(place) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([place, count]) => ({ place, count }))
    .sort((a, b) => b.count - a.count || a.place.localeCompare(b.place))
}

/**
 * Идеи одного места.
 *
 * Архивные и удалённые отсеиваем ЗДЕСЬ, а не надеемся на вызывающего:
 * функция должна быть безопасной сама по себе. Иначе место показывало бы
 * и то, что человек осознанно убрал.
 */
export function ideasAt(ideas: readonly Idea[], place: string): Idea[] {
  const target = normalizePlace(place)
  return ideas.filter(
    (idea) =>
      placeOf(idea) === target && idea.status !== 'archived' && idea.status !== 'deleted',
  )
}
