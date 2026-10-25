/**
 * Кусок текста вокруг совпадения — то, по чему человек понимает,
 * почему идея попала в выдачу.
 *
 * Задача модуля узкая и чистая: взять текст (тело идеи или расшифровку),
 * найти в нём слово запроса и вернуть небольшой фрагмент с многоточиями,
 * разбитый на части «совпало / не совпало». Интерфейс показывает части
 * и подсвечивает совпадения, а тесты проверяют обрезку без браузера.
 *
 * Слова приходят из MiniSearch в уже приведённом виде (нижний регистр,
 * «ё» → «е»), поэтому сравнение идёт по той же нормализации. Если точной
 * формы в тексте нет (например, слово нашлось с опечаткой), берём начало
 * слова — фрагмент всё равно должен показать место, а не начало текста.
 */

/** Часть фрагмента: обычный текст или совпадение для подсветки. */
export interface SnippetPart {
  text: string
  match: boolean
}

/** Готовый фрагмент текста. */
export interface Snippet {
  /** Текст целиком, с многоточиями по краям, если он обрезан. */
  text: string
  /** Тот же текст, разбитый на части для подсветки. */
  parts: SnippetPart[]
  /** Нашлось ли в фрагменте хоть одно слово запроса. */
  matched: boolean
}

/** Сколько символов оставить до совпадения. */
const BEFORE = 60

/** Сколько символов оставить после совпадения. */
const AFTER = 120

/** Сколько символов показать, если совпадение найти не удалось. */
const FALLBACK_LENGTH = 180

/** Приведение к тому же виду, в каком слова лежат в индексе. */
export function normalizeForSearch(value: string): string {
  return value.toLowerCase().replace(/ё/g, 'е')
}

/**
 * Пробелы и переводы строк схлопываются: фрагмент должен читаться одной
 * строкой на телефоне, а не повторять разметку расшифровки.
 */
function cleanText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/** Слова запроса без пустых и повторов, длинные — первыми. */
function cleanTerms(terms: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const term of terms) {
    const normalized = normalizeForSearch(term.trim())
    if (normalized === '' || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
  }
  return result.sort((a, b) => b.length - a.length)
}

/** Начало слова — запасной якорь, если точной формы в тексте не оказалось. */
function headOf(term: string): string {
  return term.slice(0, Math.min(4, term.length))
}

/**
 * Самое раннее совпадение любого слова.
 * Длина возвращается по точной форме, а для запасного якоря — по началу
 * слова: подсветка не должна захватывать лишние буквы.
 */
function firstMatch(
  haystack: string,
  terms: readonly string[],
): { index: number; length: number } | null {
  let best: { index: number; length: number } | null = null
  for (const term of terms) {
    const index = haystack.indexOf(term)
    if (index < 0) continue
    if (!best || index < best.index) best = { index, length: term.length }
  }
  if (best) return best

  for (const term of terms) {
    const head = headOf(term)
    if (head.length < 2) continue
    const index = haystack.indexOf(head)
    if (index < 0) continue
    if (!best || index < best.index) best = { index, length: head.length }
  }
  return best
}

/**
 * Границы фрагмента. По краям стараемся не резать слова: сдвигаем границу
 * к ближайшему пробелу, но только если совпадение при этом остаётся внутри.
 */
function cut(text: string, index: number, length: number): { start: number; end: number } {
  let start = Math.max(0, index - BEFORE)
  let end = Math.min(text.length, index + length + AFTER)

  if (start > 0) {
    const space = text.indexOf(' ', start)
    if (space >= 0 && space < index) start = space + 1
  }
  if (end < text.length) {
    const space = text.lastIndexOf(' ', end)
    if (space > index + length) end = space
  }
  return { start, end }
}

/** Непересекающиеся отрезки совпадений внутри фрагмента. */
function matchRanges(fragment: string, terms: readonly string[]): [number, number][] {
  const haystack = normalizeForSearch(fragment)
  const ranges: [number, number][] = []

  for (const term of terms) {
    let from = 0
    let found = false
    while (from < haystack.length) {
      const index = haystack.indexOf(term, from)
      if (index < 0) break
      ranges.push([index, index + term.length])
      from = index + term.length
      found = true
    }
    if (!found) {
      // Опечатка: подсвечиваем хотя бы начало слова, по которому нашли место.
      const head = headOf(term)
      if (head.length < 2) continue
      const index = haystack.indexOf(head)
      if (index >= 0) ranges.push([index, index + head.length])
    }
  }

  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const merged: [number, number][] = []
  for (const range of ranges) {
    const last = merged[merged.length - 1]
    if (last && range[0] <= last[1]) {
      last[1] = Math.max(last[1], range[1])
    } else {
      merged.push([range[0], range[1]])
    }
  }
  return merged
}

/** Текст → части с отметками совпадений. */
function toParts(fragment: string, ranges: readonly [number, number][]): SnippetPart[] {
  if (ranges.length === 0) return [{ text: fragment, match: false }]

  const parts: SnippetPart[] = []
  let cursor = 0
  for (const [start, end] of ranges) {
    if (start > cursor) parts.push({ text: fragment.slice(cursor, start), match: false })
    parts.push({ text: fragment.slice(start, end), match: true })
    cursor = end
  }
  if (cursor < fragment.length) parts.push({ text: fragment.slice(cursor), match: false })
  return parts
}

/**
 * Возвращает кусок текста вокруг первого совпадения.
 * `null` — текста нет вовсе; интерфейс тогда покажет хотя бы заголовок.
 */
export function buildSnippet(text: string, terms: readonly string[]): Snippet | null {
  const clean = cleanText(text)
  if (clean === '') return null

  const words = cleanTerms(terms)
  // Ищем по приведённому тексту: регистр и «ё» не должны мешать.
  // Длина от этого не меняется, поэтому границы фрагмента можно резать
  // по исходному тексту — подсветка останется на тех же местах.
  const match = firstMatch(normalizeForSearch(clean), words)

  // Совпадения нет — показываем начало: пусть лучше будет видно, о чём идея,
  // чем пустое место под заголовком.
  if (!match) {
    const fragment = clean.slice(0, FALLBACK_LENGTH)
    const suffix = clean.length > fragment.length ? '…' : ''
    const textWithEllipsis = `${fragment}${suffix}`
    return {
      text: textWithEllipsis,
      parts: [{ text: textWithEllipsis, match: false }],
      matched: false,
    }
  }

  const { start, end } = cut(clean, match.index, match.length)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < clean.length ? '…' : ''
  const fragment = `${prefix}${clean.slice(start, end)}${suffix}`
  const ranges = matchRanges(fragment, words)

  return {
    text: fragment,
    parts: toParts(fragment, ranges),
    matched: ranges.length > 0,
  }
}
