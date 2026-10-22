/**
 * Разбор ответа модели на промпт «называтель направлений» (ПРОМПТЫ.md, раздел 4).
 *
 * Отдельный парсер, потому что в `src/ai` схема для этого промпта не задана:
 * модуль ИИ править нельзя, поэтому проверка живёт здесь и опирается
 * на общий `extractJson`.
 */

import { extractJson, type LlmParseOutcome } from '../ai'

/** Что модель предлагает: имя направления и почему. */
export interface DirectionSuggestion {
  name: string | null
  confidence: number
  reasoning: string
}

/** Достаёт из ответа имя, уверенность и обоснование; мусор — понятная ошибка. */
export function parseDirectionSuggestion(raw: string): LlmParseOutcome<DirectionSuggestion> {
  const json = extractJson(raw)
  if (!json.ok) return { ok: false, kind: 'invalid_json', issues: json.issues }

  const value = json.value
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, kind: 'invalid_schema', issues: ['Ожидался объект JSON с полем name.'] }
  }

  const record = value as Record<string, unknown>
  const issues: string[] = []

  let name: string | null = null
  if (record.name === null || record.name === undefined) {
    name = null
  } else if (typeof record.name === 'string') {
    const trimmed = record.name.trim()
    name = trimmed === '' ? null : trimmed.slice(0, 60)
  } else {
    issues.push('name: ожидалась строка или null.')
  }

  let confidence = 0
  const rawConfidence = record.confidence
  if (typeof rawConfidence === 'number' && Number.isFinite(rawConfidence)) {
    confidence = rawConfidence
  } else if (typeof rawConfidence === 'string' && rawConfidence.trim() !== '') {
    const parsed = Number(rawConfidence.replace(',', '.'))
    if (Number.isFinite(parsed)) confidence = parsed
    else issues.push('confidence: ожидалось число от 0 до 1.')
  } else {
    issues.push('confidence: ожидалось число от 0 до 1.')
  }
  confidence = Math.min(Math.max(confidence, 0), 1)

  const reasoning =
    typeof record.reasoning === 'string' ? record.reasoning.trim().slice(0, 200) : ''

  if (issues.length > 0) return { ok: false, kind: 'invalid_schema', issues }
  return { ok: true, value: { name, confidence, reasoning } }
}
