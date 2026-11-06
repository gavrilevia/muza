/**
 * Классификация одной идеи по промпту «КЛАССИФИКАТОР» (ПРОМПТЫ.md, раздел 1).
 *
 * Один вызов возвращает всё: тип, направление, свойства и момент — так
 * дешевле в 3–4 раза и точнее, чем отдельный вызов на каждое поле.
 *
 * Правило продукта: если `confidence < 0.5`, значение НЕ применяется —
 * идея остаётся без направления и ждёт человека (ПРОМПТЫ.md, раздел 0;
 * АРХИТЕКТУРА.md, 11). Но то, что предлагала модель, мы сохраняем
 * в служебных полях: интерфейс может показать догадку, не записывая её.
 */

import { failureResult, type LlmClient } from './LlmClient'
import { buildClassifierMessages } from './prompts'
import {
  LlmError,
  type LlmResult,
  type ModelClassification,
  type Moment,
  type MomentType,
} from './types'
import { parseClassification } from './validate'

/** Порог, ниже которого направление не применяем (ПРОМПТЫ.md: рекомендовано 0.5). */
export const DIRECTION_CONFIDENCE_THRESHOLD = 0.5

/**
 * Порог АВТОМАТИЧЕСКОГО применения: почти наверняка.
 *
 * Ручной разбор человек видит и может переставить, поэтому 0.5 там честно.
 * А автоматика должна молчать, если не уверена: ошибка, которую никто не
 * заметил, хуже отсутствия подсказки.
 */
export const AUTO_CONFIDENCE_THRESHOLD = 0.9

/** Приведение для сверки цитаты: регистр, ё, знаки препинания, пробелы. */
function normalizeForQuote(value: string): string {
  return value
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Есть ли цитата в тексте идеи — дословно, с точностью до знаков и регистра.
 *
 * Это ловушка для галлюцинаций: модель может придумать и направление,
 * и «цитату». Если придуманных слов в тексте нет — решение не применяется.
 * Пересказ своими словами тоже не проходит: тогда это не цитата.
 */
export function evidenceSupports(evidence: string | null, text: string): boolean {
  if (typeof evidence !== 'string' || evidence.trim() === '') return false
  const quote = normalizeForQuote(evidence)
  if (quote === '') return false
  return normalizeForQuote(text).includes(quote)
}

/** Идея, которую классифицируем. Больше ничего про неё знать не нужно. */
export interface ClassifyIdeaInput {
  text: string
  /** Текст, распознанный со скриншота (ПРОМПТЫ.md, раздел 5): используется, если text пуст. */
  extractedText?: string | null
}

/** Применённый результат классификации — то, что уходит в слой данных. */
export interface Classification extends ModelClassification {
  /** Применено ли направление. */
  direction_applied: boolean
  /**
   * Подтверждена ли догадка цитатой из текста.
   *
   * false — модель сослалась на слова, которых человек не писал (или не
   * сослалась вовсе): применяем только как подсказку человеку.
   */
  evidence_ok: boolean
  /** Что предлагала модель до порога: можно показать, но не записывать. */
  suggested_direction: string | null
  /** Применён ли момент. */
  moment_applied: boolean
  /** true — уверенность ниже порога; данные требуют человека. */
  low_confidence: boolean
}

export interface ClassifyOptions {
  /** Уже существующие направления пользователя — их показывает промпт. */
  directions?: readonly string[]
  /**
   * Правки, сделанные ЧЕЛОВЕКОМ: пары «текст → направление».
   *
   * Общие примеры показывают форму ответа, а эти — **его язык**. Без них
   * промпт учился бы на своих же догадках и закреплял свои ошибки.
   */
  learned?: readonly { text: string; direction: string }[]
  maxTokens?: number
  timeoutMs?: number
  signal?: AbortSignal
  /**
   * Кто решает: человек (`manual`, порог 0.5) или автоматика (`auto`, 0.9).
   * В обоих случаях нужна цитата из текста.
   */
  mode?: 'manual' | 'auto'
}

/** Что подать модели как текст идеи. */
export function pickIdeaText(idea: ClassifyIdeaInput): string {
  const text = (idea.text ?? '').trim()
  if (text) return text
  return (idea.extractedText ?? '').trim()
}

/**
 * Накладывает порог уверенности.
 *
 * `momentsToo` по умолчанию false: по документам правило про `confidence`
 * касается направления (АРХИТЕКТУРА.md, 11). Если понадобится глушить
 * и момент, его можно передать явно.
 */
export function applyConfidenceThreshold(
  model: ModelClassification,
  text: string,
  options: { momentsToo?: boolean; mode?: 'manual' | 'auto' } = {},
): Classification {
  const threshold =
    options.mode === 'auto' ? AUTO_CONFIDENCE_THRESHOLD : DIRECTION_CONFIDENCE_THRESHOLD
  const lowConfidence = model.confidence < threshold
  const evidenceOk = evidenceSupports(model.evidence, text)
  const suggestedDirection = model.direction_name

  // Применяем, только если уверены И догадка подтверждена словами человека.
  const confidentEnough = !lowConfidence && evidenceOk
  const directionApplied = confidentEnough && suggestedDirection !== null
  // Момент — такая же догадка, как направление: без уверенности и цитаты
  // он не должен попадать в данные (человек увидит дату, которой нет).
  const momentApplied = model.moment !== null && confidentEnough

  return {
    ...model,
    direction_name: directionApplied ? suggestedDirection : null,
    is_new_direction: directionApplied ? model.is_new_direction : false,
    moment: momentApplied ? model.moment : null,
    direction_applied: directionApplied,
    evidence_ok: evidenceOk,
    suggested_direction: suggestedDirection,
    moment_applied: momentApplied,
    low_confidence: lowConfidence,
  }
}

/**
 * Классифицировать одну идею.
 *
 * Возвращает результат-обёртку: ошибка не выбрасывается наружу, потому что
 * идея важнее обработки (АРХИТЕКТУРА.md, 11) — вызывающий код просто
 * оставит идею в инбоксе и вернётся к ней позже.
 */
export async function classifyIdea(
  client: LlmClient,
  idea: ClassifyIdeaInput,
  options: ClassifyOptions = {},
): Promise<LlmResult<Classification>> {
  const result = await classifyIdeaModel(client, idea, options)
  if (!result.ok) return result
  return {
    ...result,
    data: applyConfidenceThreshold(result.data, pickIdeaText(idea), {
      mode: options.mode ?? 'manual',
    }),
  }
}

/**
 * То же, но БЕЗ порога: нужно там, где догадку модели показывают
 * пользователю и решение принимает человек.
 */
export async function classifyIdeaModel(
  client: LlmClient,
  idea: ClassifyIdeaInput,
  options: ClassifyOptions = {},
): Promise<LlmResult<ModelClassification>> {
  const text = pickIdeaText(idea)
  if (text === '') {
    // Не тратим запрос на пустую строку.
    return failureResult(new LlmError('empty_input', 'Пустой текст идеи: классифицировать нечего.'), {
      model: client.config.model,
      task: 'classify',
    })
  }

  const messages = buildClassifierMessages({
    ideaText: text,
    directions: options.directions ?? [],
    learned: options.learned ?? [],
  })
  // parseClassification проверяет JSON-схему из ПРОМПТЫ.md; при невалидном
  // ответе клиент делает ровно один повтор.
  return client.chatJson(messages, parseClassification, {
    task: 'classify',
    json: true,
    maxTokens: options.maxTokens,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  })
}

/**
 * Свойства идеи для хранения: в СХЕМА-ДАННЫХ.md это объект
 * `{"быстро": true, "сезон": "лето"}`, а модель отдаёт массив строк.
 * Мостик между двумя формами, чтобы слой данных не разбирал строки сам.
 */
export function propsToObject(props: readonly string[]): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = {}
  for (const raw of props) {
    const tag = raw.trim()
    if (tag === '') continue
    const separator = tag.indexOf(':')
    if (separator > 0) {
      const key = tag.slice(0, separator).trim()
      const value = tag.slice(separator + 1).trim()
      if (key) result[key] = value === '' ? true : value
    } else {
      result[tag] = true
    }
  }
  return result
}

/** Правило момента для хранения (`moment_rule` в СХЕМА-ДАННЫХ.md). */
export function momentRuleOf(moment: Moment | null): MomentType | null {
  return moment ? moment.type : null
}