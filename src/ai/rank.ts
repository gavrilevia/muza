/**
 * Подбор, уровень 2: модель выбирает из двадцати.
 *
 * Замысел (`АРХИТЕКТУРА.md`, §8): локальный фильтр работает всегда и
 * бесплатно, а когда запроса словами не хватает — **по кнопке** зовём
 * модель. И зовём не «по всей базе», а по **двадцати кандидатам**, уже
 * отобранным локально.
 *
 * Почему двадцать: модель выбирает из короткого списка точнее и это
 * в разы дешевле. Отдать ей пятьсот идей — значит заплатить за то,
 * что мы и так умеем бесплатно.
 *
 * Почему по кнопке: это единственное место в подборе, которое стоит
 * денег. Тратить их без спроса нельзя — решает человек.
 */

import { failureResult, type LlmClient } from './LlmClient'
import { LlmError } from './types'
import type { LlmParseOutcome, LlmResult } from './types'
import { extractJson } from './validate'
import { buildRankerMessages, type RankerCandidate } from './prompts'

/** Одна выбранная идея: идентификатор и **почему** она подходит. */
export interface RankedIdea {
  id: string
  why: string
}

export interface Ranking {
  selected: RankedIdea[]
  /** Если ничего не подошло — здесь объяснение, а не пустота. */
  reasoning: string
}

/**
 * Разбирает ответ модели.
 *
 * Проверяем руками и строго: ответ приходит от внешнего сервиса, и доверять
 * ему нельзя. Выдуманные идентификаторы отбрасываем — иначе в выдаче
 * появятся идеи, которых у человека нет.
 */
export function parseRanking(
  raw: string,
  allowedIds: ReadonlySet<string>,
): LlmParseOutcome<Ranking> {
  const extracted = extractJson(raw)
  if (!extracted.ok) return { ok: false, kind: 'invalid_json', issues: extracted.issues }

  const source = (extracted.value ?? {}) as Record<string, unknown>
  const reasoning = typeof source.reasoning === 'string' ? source.reasoning.trim() : ''
  const list = Array.isArray(source.selected) ? source.selected : []

  const selected: RankedIdea[] = []
  const seen = new Set<string>()
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue
    const entry = item as Record<string, unknown>
    const id = typeof entry.id === 'string' ? entry.id : ''
    // Только те идеи, которые мы сами и отправили.
    if (!allowedIds.has(id) || seen.has(id)) continue
    const why = typeof entry.why === 'string' ? entry.why.trim() : ''
    if (why === '') continue
    seen.add(id)
    selected.push({ id, why })
  }

  const issues: string[] = []
  if (list.length > 0 && selected.length === 0) {
    issues.push('ни одна выбранная идея не найдена среди кандидатов')
  }
  if (issues.length > 0) return { ok: false, kind: 'invalid_schema', issues }

  return { ok: true, value: { selected, reasoning } }
}

export interface RankOptions {
  query: string
  candidates: readonly RankerCandidate[]
  limit?: number
  signal?: AbortSignal
  /** Сколько даём модели времени: сложный запрос думает дольше разбора. */
  timeoutMs?: number
}

/**
 * Просит модель выбрать лучшее из кандидатов.
 *
 * Пустой список кандидатов не отправляем: платить за запрос, где нечего
 * выбирать, незачем.
 */
export async function rankIdeas(
  client: LlmClient,
  options: RankOptions,
): Promise<LlmResult<Ranking>> {
  const query = options.query.trim()
  const limit = options.limit ?? 5

  if (query === '') {
    return failureResult(new LlmError('empty_input', 'Пустой запрос: выбирать не из чего.'), {
      model: client.config.model,
      task: 'select',
    })
  }
  if (options.candidates.length === 0) {
    return failureResult(
      new LlmError('empty_input', 'Нет кандидатов: сначала нужен локальный отбор.'),
      { model: client.config.model, task: 'select' },
    )
  }

  const allowed = new Set(options.candidates.map((candidate) => candidate.id))
  const messages = buildRankerMessages({ query, candidates: options.candidates, limit })

  return client.chatJson<Ranking>(
    messages,
    (raw) => parseRanking(raw, allowed),
    {
      task: 'select',
      json: true,
      // 20 идей в запросе — это заметный текст, а ответ короткий. Запас
      // нужен на рассуждение, иначе ответ не успеет начаться.
      maxTokens: 2048,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    },
  )
}
