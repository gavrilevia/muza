/**
 * Подбор: «что сейчас кстати из того, что есть».
 *
 * Это **главная функция** продукта (`АРХИТЕКТУРА.md`, раздел 8), и здесь
 * реализован её первый уровень — **локальный фильтр**: он работает всегда,
 * бесплатно и без сети. Уже на этом уровне подбор полезен, без всякого ИИ.
 *
 * Формула сортировки — ровно из спецификации, и она **объяснима**: человек
 * должен видеть, почему идея оказалась в выдаче, а не верить чёрному ящику.
 *
 * ```
 * score = 0.4 × совпадение_свойств
 *       + 0.3 × свежесть
 *       + 0.2 × близость_к_моменту
 *       + 0.1 × (не пробовал раньше)
 * ```
 *
 * Разбор запроса тоже локальный — по ключевым словам, без модели. Правило
 * замысла: **модель не нужна для 80% запросов.** Это и есть экономия.
 */

import type { Idea, IdeaKind, Material } from '../data'

/** Веса — из спецификации. Меняются только вместе с ней. */
export const WEIGHTS = {
  props: 0.4,
  freshness: 0.3,
  moment: 0.2,
  untried: 0.1,
} as const

/** Сколько показываем: «топ-5», чтобы человек выбирал, а не читал список. */
export const SELECT_LIMIT = 5

/** Сколько времени считается «быстро». */
export const QUICK_MINUTES = 30

/** Что поняли из запроса: показываем это человеку, чтобы он видел границы. */
export interface SelectFilters {
  /** Свободные слова, которые обязаны встретиться. */
  words: string[]
  /** Вид идеи, если он понятен из запроса. */
  kind: IdeaKind | null
  /** Предел времени в минутах, если человек его назвал. */
  maxMinutes: number | null
  /** Запрос про «из того, что есть». */
  fromWhatWeHave: boolean
}

/** Слова, которые несут вид идеи. */
const KIND_WORDS: { kind: IdeaKind; words: string[] }[] = [
  { kind: 'recipe', words: ['рецепт', 'приготовить', 'готовить', 'еда', 'ужин', 'обед', 'завтрак', 'блюдо'] },
  { kind: 'gift', words: ['подарок', 'подарить', 'день рождения'] },
  { kind: 'read', words: ['книга', 'почитать', 'читать', 'статья'] },
  { kind: 'place', words: ['место', 'сходить', 'поехать', 'кафе', 'ресторан', 'гулять'] },
  { kind: 'purchase', words: ['купить', 'покупка', 'заказать'] },
]

/** Слова про «быстро». */
const QUICK_WORDS = ['быстро', 'быстрый', 'недолго', 'скорый', 'минут', 'полчаса']

/** Слова про «из того, что есть». */
const HAVE_WORDS = ['есть', 'имеется', 'осталось', 'запас', 'холодильник']

const STOP = new Set([
  'и', 'а', 'но', 'или', 'что', 'это', 'как', 'так', 'не', 'на', 'в', 'во', 'с', 'со', 'к',
  'по', 'за', 'из', 'от', 'до', 'для', 'при', 'о', 'об', 'же', 'бы', 'ли', 'у', 'над', 'под',
  'про', 'без', 'через', 'чтобы', 'чем', 'то', 'мне', 'мы', 'я', 'хочу', 'надо', 'нужно',
  'можно', 'было', 'есть', 'быть', 'что-нибудь', 'что-то', 'нибудь', 'всё', 'все',
  'того', 'этого', 'них', 'нас', 'вас', 'себе', 'себя', 'тут', 'там', 'где', 'когда',
  'если', 'потом', 'сейчас', 'опять', 'ещё', 'еще', 'уже', 'только', 'очень', 'самый',
])

/**
 * Разбирает запрос человека в понятные фильтры.
 *
 * Нарочно простой разбор: он бесплатный, мгновенный и **объяснимый**.
 * Человек видит, что мы поняли, — и может поправить словами, а не настройками.
 */
export function parseRequest(query: string): SelectFilters {
  const text = query.toLowerCase()
  // Сырые слова — ДО отбрасывания служебных. Нужны, чтобы понять «из того,
  // что есть»: «есть» одновременно и служебное слово, и признак запаса,
  // поэтому проверять его надо раньше фильтрации.
  const raw = text.replace(/[^\p{L}\p{N}\s]+/gu, ' ').split(/\s+/)
  const words = raw.filter((word) => word.length > 2 && !STOP.has(word))

  let kind: IdeaKind | null = null
  for (const candidate of KIND_WORDS) {
    if (candidate.words.some((word) => text.includes(word))) {
      kind = candidate.kind
      break
    }
  }

  // Время: «30 минут», «40 мин», «полчаса».
  let maxMinutes: number | null = null
  const explicit = /(\d{1,3})\s*(?:минут|мин\b)/.exec(text)
  if (explicit?.[1]) maxMinutes = Number(explicit[1])
  else if (/полчаса/.test(text)) maxMinutes = 30
  else if (QUICK_WORDS.some((word) => words.includes(word))) maxMinutes = QUICK_MINUTES

  const fromWhatWeHave = HAVE_WORDS.some((word) => raw.includes(word))

  // Служебные слова про время и запас в свободный поиск не отдаём: иначе
  // «быстро» начнёт искать идеи со словом «быстро» в тексте.
  const kindWords = kind ? (KIND_WORDS.find((entry) => entry.kind === kind)?.words ?? []) : []
  const cleaned = words.filter(
    (word) =>
      !QUICK_WORDS.includes(word) &&
      !HAVE_WORDS.includes(word) &&
      !kindWords.includes(word) &&
      !/^\d+$/.test(word),
  )

  return { words: cleaned, kind, maxMinutes, fromWhatWeHave }
}

/** Свежесть: 1 у только что тронутого, 0 у забытого. */
function freshness(idea: Idea, now: Date): number {
  const last = new Date(idea.last_activity_at || idea.captured_at || idea.created_at)
  if (Number.isNaN(last.getTime())) return 0
  const days = (now.getTime() - last.getTime()) / 86_400_000
  if (days <= 1) return 1
  if (days >= 180) return 0
  return 1 - days / 180
}

/**
 * Близость к моменту: 1 у сегодняшнего, 0 у далёкого или отсутствующего.
 *
 * Прошедший момент близостью **не считается**: мы не планировщик и не
 * напоминаем о том, что прошло.
 */
function momentCloseness(idea: Idea, now: Date): number {
  if (!idea.moment_at) return 0
  const at = new Date(idea.moment_at)
  if (Number.isNaN(at.getTime())) return 0
  const days = (at.getTime() - now.getTime()) / 86_400_000
  if (days < 0) return 0
  if (days <= 1) return 1
  if (days >= 60) return 0
  return 1 - days / 60
}

/** Весь текст идеи одним куском: заголовок, тело, свойства и материалы. */
function ideaText(idea: Idea, materials: readonly Material[]): string {
  return [
    idea.title,
    idea.body,
    JSON.stringify(idea.props ?? {}),
    ...materials.map(
      (material) =>
        `${material.title ?? ''} ${material.extracted_text ?? ''} ${material.comment ?? ''}`,
    ),
  ]
    .join(' ')
    .toLowerCase()
}

/** Значимые слова идеи — из того же текста. */
function ideaWords(idea: Idea, materials: readonly Material[]): Set<string> {
  return new Set(
    ideaText(idea, materials)
      .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 2 && !STOP.has(word)),
  )
}

/**
 * Основа слова: первые буквы. «сырники» и «сырников» — одно слово для
 * человека, хотя пишутся разно. Без этого запрос «сырники» не находил
 * «Рецепт сырников», и подбор выглядел сломанным.
 */
function stem(word: string): string {
  return word.length > 5 ? word.slice(0, 5) : word
}

/**
 * Совпадение свойств: доля значимых слов запроса, которые нашлись в идее.
 *
 * Сравниваем **основы слов**, а не точные строки: русские окончания иначе
 * ломают поиск на ровном месте.
 */
function propsMatch(haystackWords: Set<string>, filters: SelectFilters): number {
  if (filters.words.length === 0) return 0
  let found = 0
  for (const word of filters.words) {
    const target = stem(word)
    for (const candidate of haystackWords) {
      const other = stem(candidate)
      // Совпадение по началу в любую сторону: «сырни» и «сырник» — одно.
      if (candidate.startsWith(target) || other.startsWith(stem(word))) {
        found += 1
        break
      }
    }
  }
  return found / filters.words.length
}

/** Кандидат подбора: идея, её счёт и объяснение «почему она здесь». */
export interface SelectCandidate {
  idea: Idea
  /** Итоговый счёт 0…1. */
  score: number
  /** Составляющие — чтобы объяснение не было выдумкой. */
  parts: { props: number; freshness: number; moment: number; untried: number }
  /** Одна фраза человеку: почему эта идея подходит. */
  why: string
}

/**
 * Отбирает идеи под запрос — локально, бесплатно, без сети.
 *
 * Возвращает не больше `limit` штук с объяснением по каждой. Пустой запрос
 * не отбирает ничего: показывать «топ вообще всего» бессмысленно.
 */
export function selectIdeas(
  ideas: readonly Idea[],
  materialsByIdea: Record<string, Material[]>,
  query: string,
  now: Date = new Date(),
  limit: number = SELECT_LIMIT,
): { filters: SelectFilters; candidates: SelectCandidate[] } {
  const filters = parseRequest(query)

  // Идеи, которые не должны попадать в подбор: архив, удалённые, сон.
  const pool = ideas.filter(
    (idea) => idea.status !== 'archived' && idea.status !== 'deleted' && idea.status !== 'dormant',
  )

  const candidates: SelectCandidate[] = []
  for (const idea of pool) {
    const materials = materialsByIdea[idea.id] ?? []
    const words = ideaWords(idea, materials)

    // Вид — фильтр, но с оговоркой. Вид ставит ИИ, и у неразобранной идеи
    // его просто нет. Выбрасывать её за это нельзя: человек увидит пустую
    // выдачу и решит, что подбор сломан. Поэтому:
    //   вид известен и другой  -> не подходит;
    //   вид известен и тот же  -> подходит;
    //   вид неизвестен         -> ищем слова вида в тексте идеи.
    if (filters.kind) {
      if (idea.kind) {
        if (idea.kind !== filters.kind) continue
      } else {
        const kindWords = KIND_WORDS.find((entry) => entry.kind === filters.kind)?.words ?? []
        const raw = ideaText(idea, materials)
        if (!kindWords.some((word) => raw.includes(word))) continue
      }
    }

    const props = propsMatch(words, filters)
    // Если значимых слов не осталось (например, «быстро приготовить из того,
    // что есть» — всё служебное), требовать совпадения НЕЛЬЗЯ: работу делают
    // фильтры вида и времени. Иначе мусорное слово вроде «того» становилось
    // жёстким требованием и прятало подходящие идеи.
    if (filters.words.length > 0 && props === 0) continue

    const f = freshness(idea, now)
    const m = momentCloseness(idea, now)
    const untried = idea.worked_on ? 0 : 1
    const score =
      WEIGHTS.props * props + WEIGHTS.freshness * f + WEIGHTS.moment * m + WEIGHTS.untried * untried

    candidates.push({
      idea,
      score,
      parts: { props, freshness: f, moment: m, untried },
      why: explain(props, f, m, untried, filters),
    })
  }

  return {
    filters,
    candidates: candidates.sort((a, b) => b.score - a.score).slice(0, limit),
  }
}

/** Объяснение «почему здесь»: собираем из того, что реально повлияло. */
function explain(
  props: number,
  fresh: number,
  moment: number,
  untried: number,
  filters: SelectFilters,
): string {
  const reasons: string[] = []
  if (props >= 0.99) reasons.push('совпадает с запросом')
  else if (props > 0) reasons.push('частично совпадает с запросом')
  if (moment >= 0.9) reasons.push('момент как раз сейчас')
  else if (moment > 0.4) reasons.push('момент близко')
  if (fresh >= 0.8) reasons.push('недавно в работе')
  if (untried === 1) reasons.push('вы это ещё не пробовали')
  if (filters.maxMinutes) reasons.push(`укладывается в ${filters.maxMinutes} мин`)
  return reasons.length > 0 ? reasons.join(', ') : 'подходит по общим словам'
}

/** Как сказать человеку, что мы поняли из запроса. */
export function describeFilters(filters: SelectFilters): string {
  const parts: string[] = []
  if (filters.kind) parts.push(`вид: ${KIND_LABELS[filters.kind]}`)
  if (filters.maxMinutes) parts.push(`до ${filters.maxMinutes} мин`)
  if (filters.fromWhatWeHave) parts.push('из того, что есть')
  if (filters.words.length > 0) parts.push(`слова: ${filters.words.join(', ')}`)
  return parts.length > 0 ? parts.join(' · ') : 'запрос пустой'
}

const KIND_LABELS: Record<IdeaKind, string> = {
  recipe: 'рецепт',
  purchase: 'покупка',
  place: 'место',
  gift: 'подарок',
  read: 'почитать',
  do: 'сделать',
  note: 'заметка',
}
