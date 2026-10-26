/**
 * Сборка промптов из ПРОМПТЫ.md.
 *
 * Главное требование экономии (ПРОМПТЫ.md, разделы 0 и 9; АРХИТЕКТУРА.md, 9a):
 * НЕИЗМЕННАЯ часть (инструкции + few-shot + список направлений) идёт В НАЧАЛО
 * и предназначена для кэша префикса, а МЕНЯЮЩИЙСЯ текст идеи — В КОНЕЦ.
 *
 * Поэтому:
 * - всё постоянное лежит в сообщении `system`, и последним в нём идёт список
 *   направлений: он меняется редко, и при его изменении кэш инструкций
 *   и примеров (самый длинный кусок) остаётся валидным — кэш работает
 *   по префиксу, а не по всему запросу;
 * - сообщение `user` содержит ТОЛЬКО текст идеи и ничего после него.
 */

import type { LlmMessage } from './types'
import { llmMessageText } from './types'

/**
 * Версия стабильной части промпта. Меняйте при правке текста ниже:
 * по ней видно, что кэш старого префикса больше не подходит.
 */
export const PROMPT_PREFIX_VERSION = 1

/** Общие правила из ПРОМПТЫ.md, раздел 0. */
export const COMMON_RULES = `ПРАВИЛА:
1. Не выдумывай. Если данных недостаточно — верни null и укажи причину.
2. Не переводи и не исправляй текст идеи. Ты только классифицируешь.
3. Отвечай ТОЛЬКО валидным JSON по схеме. Без markdown, без пояснений.
4. Имя направления пиши так, как сказал бы сам пользователь — простыми словами.
5. Если идея непонятна — так и скажи в поле reasoning, но не придумывай.`

/** System-промпт классификатора из ПРОМПТЫ.md, раздел 9. */
export const CLASSIFIER_INSTRUCTIONS = `Ты — помощник в приложении «Муза». Люди кидают туда бытовые идеи
«надо будет»: покупки, подарки, рецепты, места, дела, книги.

Определи по одной идее:
1. Тип: recipe | purchase | gift | place | read | do | note
2. Направление: одно, простыми словами («Подарки», «Дача», «Одежда»)
3. Свойства: короткие теги («быстро», «дорого», «всё есть», «сезон:лето»)
4. Момент: когда идея станет нужной (или none)

ПРАВИЛА:
- Не выдумывай. Не понял — null и объясни в reasoning.
- Направление — ОДНО, не список.
- Направление простыми словами, как говорит человек.
  Хорошо: «Дача», «Кухня». Плохо: «Сельское хозяйство», «Досуг».
- Момент выводи только из текста. Не придумывай даты.
- Отвечай ТОЛЬКО JSON, без markdown.

ВЕРНИ JSON РОВНО ТАКОЙ ФОРМЫ:
{
  "kind": "recipe|purchase|gift|place|read|do|note",
  "direction_name": "строка или null",
  "is_new_direction": true|false,
  "confidence": 0.0-1.0,
  "props": ["быстро", "дорого", "сезон:лето"],
  "moment": {"type": "date|season|event|manual|none", "value": "что известно или null", "reasoning": "почему так"},
  "reasoning": "одна фраза: что ты понял про эту идею"
}`

/**
 * Few-shot примеры из ПРОМПТЫ.md. Четвёртый — самый важный:
 * он учит модель честно говорить «не понял», а не угадывать направление.
 */
export const CLASSIFIER_EXAMPLES = `ПРИМЕРЫ:

Идея: «Аэрогриль, модель на 5 литров, три варианта по цене»
Ответ: {"kind":"purchase","direction_name":"Дом и техника","is_new_direction":true,"confidence":0.9,"props":["дорого","сравниваю"],"moment":{"type":"none","value":null,"reasoning":"срок не указан"},"reasoning":"Покупка техники, сравнивает варианты"}

Идея: «Подарок Ане — набор для выпечки, она говорила что хочет попробовать»
Ответ: {"kind":"gift","direction_name":"Подарки","is_new_direction":false,"confidence":0.95,"props":["для Ани","недорого"],"moment":{"type":"date","value":"день рождения Ани","reasoning":"явно подарок конкретному человеку"},"reasoning":"Подарок Ане, привязан к дню рождения"}

Идея: «надо будет разобрать балкон»
Ответ: {"kind":"do","direction_name":"Дом и техника","is_new_direction":false,"confidence":0.7,"props":[],"moment":{"type":"none","value":null,"reasoning":"срок не указан"},"reasoning":"Бытовое дело по дому"}

Идея: «это про то, что мы обсуждали»
Ответ: {"kind":"note","direction_name":null,"is_new_direction":false,"confidence":0.2,"props":[],"moment":{"type":"none","value":null,"reasoning":"непонятно, о чём речь"},"reasoning":"Слишком мало контекста, нужен человек"}`

/** System-промпт подборщика из ПРОМПТЫ.md, раздел 2. */
export const RANKER_INSTRUCTIONS = `Ты помогаешь выбрать из уже сохранённых идей.

Тебе дают: запрос пользователя и 20 его идей.
Твоя задача — выбрать до 5 самых подходящих и объяснить, почему.

ПРАВИЛА:
- Выбирай ТОЛЬКО из предоставленных идей. Не придумывай новые.
- Если подходящих меньше 5 — верни меньше. Не добивай ради количества.
- Если не подходит ни одна — верни пустой список и скажи почему.
- Объяснение — одна короткая фраза, конкретная: «20 минут, всё есть дома».
  НЕ: «подходит под ваш запрос».
- Не переписывай названия идей. Верни их как есть.
- Отвечай ТОЛЬКО JSON.

ВЕРНИ JSON РОВНО ТАКОЙ ФОРМЫ:
{
  "selected": [{"id": "01JQ...", "why": "почему именно эта — конкретно"}],
  "reasoning": "если ничего не подошло — почему"
}`

/** System-промпт распознавателя момента из ПРОМПТЫ.md, раздел 3. */
export const MOMENT_INSTRUCTIONS = `Ты определяешь, к какой дате может быть нужна идея.

Тебе дают идею и список известных дат/событий пользователя.
Определи, связана ли идея с каким-то из них.

ПРАВИЛА:
- Связывай только при ЯВНОЙ связи. Аэрогриль и день рождения Ани
  не связаны, даже если оба про дом.
- Если связи нет — linked_to: null. Это нормальный ответ.
- Не придумывай даты, которых нет в списке.
- Отвечай ТОЛЬКО JSON.

ВЕРНИ JSON РОВНО ТАКОЙ ФОРМЫ:
{
  "linked_to": "название события или null",
  "confidence": 0.0-1.0,
  "reasoning": "почему связал или почему нет"
}`

/** System-промпт назывателя направлений из ПРОМПТЫ.md, раздел 4. */
export const DIRECTION_NAMER_INSTRUCTIONS = `Ты предлагаешь название для группы идей.

Тебе дают 3-7 идей, которые похожи по смыслу.
Предложи ОДНО короткое название, как назвал бы сам человек.

ПРАВИЛА:
- Одно-два слова. Максимум три.
- Простыми словами: «Дача», «Подарки», «Одежда».
- НЕ: «Товары для дома», «Организация досуга».
- Если идеи не связаны — верни null, это нормально.
- Отвечай ТОЛЬКО JSON.

ВЕРНИ JSON РОВНО ТАКОЙ ФОРМЫ:
{
  "name": "строка или null",
  "confidence": 0.0-1.0,
  "reasoning": "одна фраза"
}`

/** Блок списка направлений — самая изменчивая часть стабильного префикса. */
function directionsBlock(directions: readonly string[]): string {
  const list = directions
    .map((name) => name.trim())
    .filter((name) => name !== '')
  return list.length > 0
    ? `СУЩЕСТВУЮЩИЕ НАПРАВЛЕНИЯ ПОЛЬЗОВАТЕЛЯ: ${JSON.stringify(list)}
Если идея подходит к одному из них — используй его название.
Если нет — предложи новое, короткое.`
    : 'СУЩЕСТВУЮЩИХ НАПРАВЛЕНИЙ ПОКА НЕТ. Предложи новое, короткое.'
}

/**
 * Стабильная (неизменная) часть промпта классификатора: инструкции,
 * примеры и список направлений — всё, что годится для кэша префикса.
 */
export function classifierStablePart(directions: readonly string[] = []): string {
  return [CLASSIFIER_INSTRUCTIONS, COMMON_RULES, CLASSIFIER_EXAMPLES, directionsBlock(directions)].join(
    '\n\n',
  )
}

/** Порядок сборки промпта классификатора: стабильное — в начало, идея — в конец. */
export function buildClassifierMessages(options: {
  ideaText: string
  directions?: readonly string[]
}): LlmMessage[] {
  const stable = classifierStablePart(options.directions ?? [])
  return [
    { role: 'system', content: stable },
    // Только текст идеи: после него в промпте нет ничего, поэтому
    // меняющаяся часть не ломает кэш стабильного префикса.
    { role: 'user', content: `Идея:\n"""\n${options.ideaText.trim()}\n"""` },
  ]
}

/** Кандидат для подборщика — только то, что нужно промпту. */
export interface RankerCandidate {
  id: string
  title: string
  sub?: string
  kind?: string
  props?: readonly string[]
  moment?: string | null
}

/** Промпт подборщика: инструкции — в system, запрос и кандидаты — в конец. */
export function buildRankerMessages(options: {
  query: string
  candidates: readonly RankerCandidate[]
  limit?: number
}): LlmMessage[] {
  const limit = options.limit ?? 5
  const payload = options.candidates.map((candidate) => ({
    id: candidate.id,
    title: candidate.title,
    ...(candidate.sub ? { sub: candidate.sub } : {}),
    ...(candidate.kind ? { kind: candidate.kind } : {}),
    ...(candidate.props ? { props: [...candidate.props] } : {}),
    ...(candidate.moment !== undefined ? { moment: candidate.moment } : {}),
  }))
  return [
    {
      role: 'system',
      content: `${RANKER_INSTRUCTIONS}\n\nВыбери до ${limit} идей.`,
    },
    {
      role: 'user',
      content: `Запрос: «${options.query.trim()}»\n\nИдеи (выбери до ${limit}):\n${JSON.stringify(payload)}`,
    },
  ]
}

/** Событие пользователя для распознавателя момента. */
export interface KnownEvent {
  name: string
  date?: string
  kind?: string
}

/** Промпт распознавателя момента: инструкции — в system, данные — в конец. */
export function buildMomentMessages(options: {
  ideaText: string
  direction?: string | null
  events: readonly KnownEvent[]
}): LlmMessage[] {
  const events = options.events.map((event) => ({
    name: event.name,
    ...(event.date ? { date: event.date } : {}),
    ...(event.kind ? { kind: event.kind } : {}),
  }))
  return [
    { role: 'system', content: MOMENT_INSTRUCTIONS },
    {
      role: 'user',
      content: `Идея: «${options.ideaText.trim()}»
Направление: ${options.direction?.trim() || 'не определено'}

Известные события пользователя:
${JSON.stringify(events)}`,
    },
  ]
}

/** Промпт назывателя направлений: инструкции — в system, идеи — в конец. */
export function buildDirectionNamerMessages(options: {
  ideas: readonly string[]
}): LlmMessage[] {
  const ideas = options.ideas.map((idea, index) => `${index + 1}. «${idea.trim()}»`).join('\n')
  return [
    { role: 'system', content: DIRECTION_NAMER_INSTRUCTIONS },
    { role: 'user', content: `Идеи:\n${ideas}` },
  ]
}

/** Стабильный префикс сообщений (всё, что стоит до меняющейся части). */
export function stablePrefix(messages: readonly LlmMessage[]): string {
  return messages
    .filter((message) => message.role === 'system')
    .map((message) => llmMessageText(message))
    .join('\n\n')
}

/**
 * Короткий ключ стабильного префикса — для журнала расходов и метрик:
 * видно, когда префикс совпадал, а когда менялся (FNV-1a, без зависимостей).
 */
export function promptPrefixKey(stablePart: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < stablePart.length; i += 1) {
    hash ^= stablePart.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${PROMPT_PREFIX_VERSION}-${hash.toString(16)}`
}