/**
 * Триаж: разбор входящих.
 *
 * В v1 триаж **понижен до гигиены** (`КОНЦЕПЦИЯ-v1.md`): «Разбор — уборка,
 * а не ценность». Поэтому здесь нет ни обязательных комментариев, ни
 * церемоний: три быстрых решения и всё.
 *
 * Из полного замысла (§9) взято главное:
 *
 * - **Оставить** — идея уходит в работу;
 * - **Покой** — идея «засыпает». Это **не смерть**: ветвь можно приживить
 *   обратно. Сон — нормальное состояние, а не признак заброшенности;
 * - **Архив** — идея уходит с причиной и остаётся в поиске.
 *
 * И **правило 90 дней**: идея, которая лежит без движения, сама попадает
 * в разбор. Без этого инкубатор незаметно превращается в свалку — а это
 * ровно то, от чего продукт обещает спасти.
 *
 * **Вопрос про дубли живёт здесь и только здесь** (`КОНЦЕПЦИЯ-v1.md`, §261):
 * при захвате спрашивать нельзя — это трение в момент, когда человек просто
 * хочет сохранить мысль.
 *
 * Всё локально и бесплатно: близость ищется пересечением слов, без ИИ.
 */

import type { Idea, IdeaStatus } from '../data'

/** Сколько дней без движения считаются залежавшимися. */
export const STAGNANT_DAYS = 90

/** Решения разбора: то, что человек может сделать с идеей за один тап. */
export type TriageDecision = 'keep' | 'rest' | 'archive'

/** Статус, в который переводит решение. Архив ставится отдельно — с причиной. */
export function statusFor(decision: Exclude<TriageDecision, 'archive'>): IdeaStatus {
  return decision === 'keep' ? 'incubating' : 'dormant'
}

/** Сколько дней идея лежит без движения. */
export function daysIdle(idea: Idea, now: Date = new Date()): number {
  const last = new Date(idea.last_activity_at || idea.captured_at || idea.created_at)
  if (Number.isNaN(last.getTime())) return 0
  return Math.floor((now.getTime() - last.getTime()) / 86_400_000)
}

/**
 * Нужен ли идее разбор.
 *
 * Два случая, и оба про честность перед человеком:
 * - **ещё не решено** — идея лежит в инбоксе и ждёт первого решения;
 * - **залежалась** — лежит без движения дольше 90 дней.
 *
 * Архив, удалённые и уже «спящие» сюда не попадают: сон — это решение,
 * а не долг. Будить спящую идею насильно нельзя, иначе «Покой» станет
 * бесполезной кнопкой.
 */
export function needsTriage(idea: Idea, now: Date = new Date()): boolean {
  if (idea.status === 'archived' || idea.status === 'deleted') return false
  if (idea.status === 'dormant' || idea.status === 'exported') return false
  if (idea.status === 'inbox') return true
  return daysIdle(idea, now) >= STAGNANT_DAYS
}

/** Почему идея попала в разбор: человеку нужно объяснение, а не просто список. */
export function triageReason(idea: Idea, now: Date = new Date()): string {
  if (idea.status === 'inbox') return 'ещё не разобрана'
  const days = daysIdle(idea, now)
  return `лежит без движения ${days} ${plural(days, 'день', 'дня', 'дней')}`
}

/**
 * Очередь разбора.
 *
 * Сначала неразобранные (самые старые вперёд), потом залежавшиеся. Так
 * разбор не превращается в бесконечную ленту свежего: то, что давно ждёт
 * решения, оказывается сверху.
 */
export function triageQueue(ideas: readonly Idea[], now: Date = new Date()): Idea[] {
  const pending = ideas.filter((idea) => needsTriage(idea, now))
  const weight = (idea: Idea): number => {
    if (idea.status === 'inbox') return 0
    return 1
  }
  return pending.sort((a, b) => {
    const byKind = weight(a) - weight(b)
    if (byKind !== 0) return byKind
    return a.captured_at < b.captured_at ? -1 : a.captured_at > b.captured_at ? 1 : 0
  })
}

// --- Похожие идеи: вопрос про дубли ------------------------------------------

/** Слова, которые ничего не говорят о смысле: предлоги, союзы, местоимения. */
const STOP_WORDS = new Set([
  'и', 'а', 'но', 'или', 'что', 'это', 'как', 'так', 'не', 'на', 'в', 'во', 'с', 'со', 'к',
  'по', 'за', 'из', 'от', 'до', 'для', 'при', 'о', 'об', 'же', 'бы', 'ли', 'у', 'над', 'под',
  'про', 'без', 'через', 'надо', 'нужно', 'хочу', 'можно', 'было', 'есть', 'быть', 'всё',
  'все', 'мы', 'я', 'он', 'она', 'они', 'мой', 'моя', 'его', 'её', 'их', 'то', 'чем', 'то',
])

/** Значимые слова текста: длиннее двух букв, без служебных. */
export function keywords(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word))
  // Короткое «обрезáние» до 5 букв ловит однокоренные слова: «аэрогриль»
  // и «аэрогриля» — одно и то же слово для человека, хотя пишутся разно.
  return new Set(words.map((word) => (word.length > 5 ? word.slice(0, 5) : word)))
}

/** Насколько две идеи близки: доля общих значимых слов, 0…1. */
export function similarity(a: Idea, b: Idea): number {
  const left = keywords(`${a.title} ${a.body}`)
  const right = keywords(`${b.title} ${b.body}`)
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const word of left) if (right.has(word)) shared += 1
  // Делим на меньшее множество: короткая идея «про аэрогриль» должна
  // находить длинную про аэрогриль, а не теряться из-за её объёма.
  return shared / Math.min(left.size, right.size)
}

/** Порог, при котором идеи стоит показать как похожие. */
export const SIMILAR_THRESHOLD = 0.6

/**
 * Похожие идеи для разбора — то самое место, где решается вопрос про дубли.
 *
 * Порог намеренно высокий: показать «похожее» зря хуже, чем не показать
 * ничего. Ложное сходство заставляет человека сравнивать две разные мысли.
 */
export function similarTo(
  idea: Idea,
  others: readonly Idea[],
  limit = 3,
): { idea: Idea; score: number }[] {
  return others
    .filter(
      (other) =>
        other.id !== idea.id &&
        other.status !== 'deleted' &&
        // Архивные показываем тоже: «у вас была похожая, архивирована по
        // причине X» — прямое требование замысла (§9).
        similarity(idea, other) >= SIMILAR_THRESHOLD,
    )
    .map((other) => ({ idea: other, score: similarity(idea, other) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

function plural(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10
  const mod100 = count % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few
  return many
}