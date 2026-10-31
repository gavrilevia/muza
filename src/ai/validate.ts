/**
 * Проверка ответа модели по JSON-схеме из ПРОМПТЫ.md — без внешних библиотек.
 *
 * Своя проверка нужна по двум причинам:
 * 1. Зависимостей в проекте нет и не будет.
 * 2. Нам важны не только ошибки, но и СПИСОК ошибок — его мы отправляем
 *    модели во втором (и последнем) запросе вместе с требованием
 *    «верни строго JSON по схеме» (АРХИТЕКТУРА.md, 11).
 *
 * Правило продукта: `confidence < 0.5` значение не применяется — порог
 * накладывается в classify.ts, потому что это логика продукта, а не разбор.
 */

import {
  IDEA_KINDS,
  MOMENT_TYPES,
  type LlmParseOutcome,
  type ModelClassification,
  type Moment,
} from './types'

/** Типы значений, которые понимает наша схема. */
const SCHEMA_TYPES = [
  'string',
  'number',
  'integer',
  'boolean',
  'object',
  'array',
  'null',
] as const

export type JsonSchemaType = (typeof SCHEMA_TYPES)[number]

/** Подмножество JSON Schema, которого хватает нашим промптам. */
export interface JsonSchema {
  type?: JsonSchemaType | JsonSchemaType[]
  /** Обязательные поля объекта. Проверяются, только если значение — объект. */
  required?: string[]
  properties?: Record<string, JsonSchema>
  items?: JsonSchema
  enum?: readonly unknown[]
  minLength?: number
  maxLength?: number
  minimum?: number
  maximum?: number
  minItems?: number
  maxItems?: number
}

/** Одна претензия к ответу модели. Путь — как в JSON Pointer, для понятности. */
export interface ValidationIssue {
  path: string
  message: string
}

function actualType(value: unknown): JsonSchemaType | 'other' {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  switch (typeof value) {
    case 'string':
      return 'string'
    case 'boolean':
      return 'boolean'
    case 'number':
      return Number.isInteger(value) ? 'integer' : 'number'
    case 'object':
      return 'object'
    default:
      return 'other'
  }
}

function matchesType(actual: JsonSchemaType | 'other', expected: JsonSchemaType): boolean {
  if (actual === expected) return true
  // Целое число годится там, где ждут число.
  return actual === 'integer' && expected === 'number'
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Проверяет значение по схеме. Возвращает пустой список, если всё хорошо.
 * Ошибки собираются все сразу: так модели понятнее, что исправить.
 */
export function validateAgainstSchema(
  value: unknown,
  schema: JsonSchema,
  path = '$',
): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  if (schema.type !== undefined) {
    const expected = Array.isArray(schema.type) ? schema.type : [schema.type]
    const actual = actualType(value)
    const ok = actual !== 'other' && expected.some((type) => matchesType(actual, type))
    if (!ok) {
      issues.push({
        path,
        message: `ожидался тип ${expected.join(' | ')}, получено ${actual}`,
      })
      // Дальше проверять нечего: остальные правила зависят от типа.
      return issues
    }
  }

  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    issues.push({
      path,
      message: `значение ${JSON.stringify(value)} не входит в список ${schema.enum.join(' | ')}`,
    })
  }

  if (typeof value === 'number' && !Number.isFinite(value)) {
    issues.push({ path, message: 'число не конечное (NaN или Infinity)' })
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      issues.push({ path, message: `короче ${schema.minLength} символов` })
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      issues.push({
        path,
        message: `длиннее ${schema.maxLength} символов (получено ${value.length})`,
      })
    }
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      issues.push({ path, message: `меньше минимума ${schema.minimum}` })
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      issues.push({ path, message: `больше максимума ${schema.maximum}` })
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      issues.push({ path, message: `элементов меньше ${schema.minItems}` })
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      issues.push({ path, message: `элементов больше ${schema.maxItems}` })
    }
    if (schema.items) {
      value.forEach((item, index) => {
        issues.push(...validateAgainstSchema(item, schema.items as JsonSchema, `${path}[${index}]`))
      })
    }
  }

  if (isPlainObject(value)) {
    for (const key of schema.required ?? []) {
      if (!(key in value) || value[key] === undefined) {
        issues.push({ path: `${path}.${key}`, message: 'обязательное поле отсутствует' })
      }
    }
    for (const [key, childSchema] of Object.entries(schema.properties ?? {})) {
      if (key in value && value[key] !== undefined) {
        issues.push(...validateAgainstSchema(value[key], childSchema, `${path}.${key}`))
      }
    }
  }

  return issues
}

/** Схема момента из ПРОМПТЫ.md. */
export const MOMENT_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['type', 'value', 'reasoning'],
  properties: {
    type: { type: 'string', enum: MOMENT_TYPES },
    value: { type: ['string', 'null'], maxLength: 120 },
    reasoning: { type: 'string', maxLength: 200 },
  },
}

/**
 * Схема ответа классификатора из ПРОМПТЫ.md: поля те же, что в шаблоне
 * «Верни JSON», ограничения — по правилам из раздела 0.
 */
export const CLASSIFIER_SCHEMA: JsonSchema = {
  type: 'object',
  required: [
    'kind',
    'direction_name',
    'is_new_direction',
    'confidence',
    'props',
    'moment',
    'reasoning',
  ],
  properties: {
    kind: { type: 'string', enum: IDEA_KINDS },
    direction_name: { type: ['string', 'null'], maxLength: 60 },
    is_new_direction: { type: 'boolean' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    // Массив строк по ПРОМПТЫ.md; объект тоже принимаем — так свойства
    // хранятся в СХЕМА-ДАННЫХ.md, и ответ в этом виде не должен пропадать.
    props: {
      type: ['array', 'object'],
      maxItems: 12,
      items: { type: 'string', maxLength: 40 },
    },
    moment: {
      type: ['object', 'null'],
      required: MOMENT_SCHEMA.required,
      properties: MOMENT_SCHEMA.properties,
    },
    reasoning: { type: 'string', maxLength: 200 },
  },
}

/** Убирает markdown-обёртку: ```json ... ``` — частая выходка модели. */
function stripCodeFences(text: string): string {
  const fenced = /```(?:json|JSON)?\s*([\s\S]*?)```/.exec(text)
  return fenced ? fenced[1].trim() : text
}

/** Берёт сбалансированный по скобкам объект, начиная с первой `{`. */
function sliceBalancedObject(text: string, start: number): string | null {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const char = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
    } else if (char === '{') {
      depth += 1
    } else if (char === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

/**
 * Достаёт JSON из ответа модели: без markdown, с текстом до и после.
 * Возвращает разобранное значение или список причин, почему не вышло.
 */
export function extractJson(text: string): { ok: true; value: unknown } | { ok: false; issues: string[] } {
  const issues: string[] = []
  const trimmed = (text ?? '').trim()
  if (!trimmed) return { ok: false, issues: ['ответ модели пустой'] }

  const candidates: string[] = []
  const fenced = stripCodeFences(trimmed)
  candidates.push(fenced)
  const firstBrace = fenced.indexOf('{')
  if (firstBrace > 0) candidates.push(fenced.slice(firstBrace))
  const balanced = firstBrace >= 0 ? sliceBalancedObject(fenced, firstBrace) : null
  if (balanced) candidates.push(balanced)

  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      return { ok: true, value: JSON.parse(candidate) }
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error))
    }
  }
  return { ok: false, issues: [`не удалось разобрать JSON: ${issues[0] ?? 'неизвестная причина'}`] }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isPlainObject(value) ? value : null
}

function toTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * Приводит разобранный JSON к нашему виду там, где это однозначно:
 * строка вместо числа, объект вместо массива свойств, пустая строка → null.
 *
 * Смысл — не гонять модель на повтор из-за мелочей. Всё спорное (чужой
 * `kind`, `confidence` вне диапазона) остаётся как есть и валится схемой.
 */
export function coerceClassification(value: unknown): unknown {
  const record = asRecord(value)
  if (!record) return value

  const result: Record<string, unknown> = { ...record }

  if (typeof result.kind === 'string') result.kind = result.kind.trim().toLowerCase()

  if (typeof result.confidence === 'string' && result.confidence.trim() !== '') {
    const parsed = Number(result.confidence)
    if (Number.isFinite(parsed)) result.confidence = parsed
  }

  if (result.direction_name !== null && result.direction_name !== undefined) {
    result.direction_name = toTrimmedString(result.direction_name)
  }

  // Строку «да/нет/true/false» тоже принимаем: модель иногда отвечает текстом.
  if (typeof result.is_new_direction === 'string') {
    const flag = result.is_new_direction.trim().toLowerCase()
    if (['true', 'да', 'yes', '1'].includes(flag)) result.is_new_direction = true
    else if (['false', 'нет', 'no', '0'].includes(flag)) result.is_new_direction = false
  }

  // Свойства: строка «быстро, дорого», массив строк или объект из СХЕМА-ДАННЫХ.
  const props = result.props
  if (typeof props === 'string') {
    result.props = props
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item !== '')
  } else if (isPlainObject(props)) {
    result.props = Object.entries(props)
      .filter(([, enabled]) => enabled !== false && enabled !== null)
      .map(([key, enabled]) => (enabled === true ? key : `${key}:${String(enabled)}`))
  } else if (Array.isArray(props)) {
    result.props = props.map((item) => String(item).trim()).filter((item) => item !== '')
  }

  if (result.moment === undefined) result.moment = null

  if (typeof result.reasoning !== 'string') {
    if (Array.isArray(result.reasoning)) result.reasoning = result.reasoning.join(' ')
    else if (result.reasoning !== null && result.reasoning !== undefined) {
      result.reasoning = String(result.reasoning)
    }
  }

  return result
}

/** Превращает проверенное значение в `ModelClassification` (без применения порога). */
export function toModelClassification(value: unknown): ModelClassification {
  const record = asRecord(value) ?? {}
  const moment = asRecord(record.moment)
  const momentValue: Moment | null = moment
    ? {
        type: moment.type as Moment['type'],
        // `reasoning` внутри момента БОЛЬШЕ НЕ СПРАШИВАЕМ: мы его нигде
        // не показывали, а модель тратила на него токены. Ответ стоит
        // дороже промпта, поэтому лишнее поле — прямая потеря денег.
        value: toTrimmedString(moment.value),
      }
    : null
  return {
    kind: record.kind as ModelClassification['kind'],
    direction_name: toTrimmedString(record.direction_name),
    is_new_direction: record.is_new_direction === true,
    confidence: typeof record.confidence === 'number' ? record.confidence : 0,
    props: Array.isArray(record.props)
      ? record.props.map((item) => String(item)).filter((item) => item !== '')
      : [],
    moment: momentValue && momentValue.type !== 'none' ? momentValue : null,
    reasoning: typeof record.reasoning === 'string' ? record.reasoning : '',
  }
}

/**
 * Полный разбор ответа классификатора: достать JSON → причесать →
 * проверить схему → привести к типу.
 *
 * Такой разбор отдаётся клиенту: он сам решает, повторять запрос или нет.
 */
export function parseClassification(raw: string): LlmParseOutcome<ModelClassification> {
  const extracted = extractJson(raw)
  if (!extracted.ok) return { ok: false, kind: 'invalid_json', issues: extracted.issues }

  const coerced = coerceClassification(extracted.value)
  const issues = validateAgainstSchema(coerced, CLASSIFIER_SCHEMA)
  if (issues.length > 0) {
    return {
      ok: false,
      kind: 'invalid_schema',
      issues: issues.map((issue) => `${issue.path}: ${issue.message}`),
    }
  }
  return { ok: true, value: toModelClassification(coerced) }
}