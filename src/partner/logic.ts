/**
 * Партнёрские предложения: только явный запрос человека.
 *
 * ЧТО ЗДЕСЬ ЕСТЬ. Чистые правила без сети и без модели: какие категории
 * допустимы, что именно уходит партнёру, как собирается ссылка и когда
 * обезличенный срез можно публиковать.
 *
 * ЧЕГО ЗДЕСЬ НЕТ И НЕ БУДЕТ. Чтения идей. `PartnerQuery` собирается из
 * полей, которые человек видит в форме и может поправить. Текст идеи,
 * расшифровки и имена в запрос не попадают — это проверяется тестом
 * на уровне формы, а не обещанием.
 *
 * ПОЧЕМУ ВИЛКА БЮДЖЕТА, А НЕ СУММА. Вилка не позволяет узнать точную
 * покупку, но партнёру достаточно, чтобы показать подходящее. Для трендов
 * она же даёт устойчивый срез: «до 15 000» вместо «12 340».
 */

/** Категории, с которыми работаем. Список закрытый — это защита, не меню. */
export const PARTNER_CATEGORIES = ['tech', 'repair', 'services'] as const
export type PartnerCategory = (typeof PARTNER_CATEGORIES)[number]

export const CATEGORY_LABELS: Record<PartnerCategory, string> = {
  tech: 'Техника',
  repair: 'Ремонт',
  services: 'Услуги',
}

/** Вилки бюджета. `any` — «не важно», а не «ноль». */
export const BUDGET_BUCKETS = ['upTo5', 'from5To15', 'from15To50', 'any'] as const
export type BudgetBucket = (typeof BUDGET_BUCKETS)[number]

export const BUDGET_LABELS: Record<BudgetBucket, string> = {
  upTo5: 'до 5 000 ₽',
  from5To15: '5 000–15 000 ₽',
  from15To50: '15 000–50 000 ₽',
  any: 'не важно',
}

/** Сколько знаков запроса максимум: партнёрские формы не любят простыни. */
export const MAX_QUERY_LENGTH = 200
/** Город — только если человек сам его указал. */
export const MAX_CITY_LENGTH = 60

/** Запрос, который уходит партнёру. Текста идеи здесь нет по устройству. */
export interface PartnerQuery {
  text: string
  category: PartnerCategory
  budget: BudgetBucket
  city: string | null
}

/** То, что приходит из формы: строки, которые человек мог не заполнить. */
export interface PartnerQueryInput {
  text?: string
  category?: string
  budget?: string
  city?: string
}

function isCategory(value: string | undefined): value is PartnerCategory {
  return PARTNER_CATEGORIES.includes(value as PartnerCategory)
}

function isBudget(value: string | undefined): value is BudgetBucket {
  return BUDGET_BUCKETS.includes(value as BudgetBucket)
}

/**
 * Приводит форму к запросу. `null` — показать нечего (пустой текст или
 * неизвестная категория). Лучше не показать, чем показать не то.
 */
export function normalizePartnerQuery(input: PartnerQueryInput): PartnerQuery | null {
  const text = (input.text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY_LENGTH)
  if (text === '') return null
  if (!isCategory(input.category)) return null
  const budget = isBudget(input.budget) ? input.budget : 'any'
  const city = (input.city ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_CITY_LENGTH)
  return { text, category: input.category, budget, city: city === '' ? null : city }
}

/**
 * Собирает партнёрскую ссылку из шаблона.
 *
 * Шаблон — только `https://`: `javascript:` или `data:` в настройках
 * превратились бы в дыру. Подстановки кодируются, поэтому кавычки и
 * кириллица не ломают адрес.
 *
 * `subid` — метка клика для сверки с сетью. Никаких имён и id человека.
 */
export function buildPartnerUrl(
  template: string,
  query: PartnerQuery,
  subid: string,
): string | null {
  if (!/^https:\/\//i.test(template.trim())) return null
  const filled = template
    .trim()
    .replace(/\{query\}/g, encodeURIComponent(query.text))
    .replace(/\{category\}/g, encodeURIComponent(query.category))
    .replace(/\{budget\}/g, encodeURIComponent(query.budget))
    .replace(/\{city\}/g, encodeURIComponent(query.city ?? ''))
    .replace(/\{subid\}/g, encodeURIComponent(subid))
  try {
    const url = new URL(filled)
    return url.protocol === 'https:' ? filled : null
  } catch {
    return null
  }
}

/** Порог, ниже которого обезличенный срез не публикуем. */
export const TREND_MIN_COUNT = 50

/**
 * Можно ли публиковать срез.
 *
 * k ≥ 50 — чтобы по цифре нельзя было вычислить одного человека. Это же
 * правило защищает от «в этом месяце искали один ремонт — значит, это вы».
 */
export function canPublishTrend(count: number, k: number = TREND_MIN_COUNT): boolean {
  return Number.isFinite(count) && count >= k
}

/**
 * Что попадает в тренды: категория и вилка. Без текста и без города —
 * по городу и запросу человека можно узнать.
 */
export function trendSlice(query: PartnerQuery): { category: PartnerCategory; budget: BudgetBucket } {
  return { category: query.category, budget: query.budget }
}
