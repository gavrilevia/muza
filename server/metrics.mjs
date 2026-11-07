/**
 * Метрики: расход ИИ и хранение — БЕЗ содержимого идей.
 *
 * ГДЕ СЧИТАЕМ. На сервере, а не в браузере: он и так видит каждый запрос
 * к модели и каждую загрузку. Никакой телеметрии из приложения не нужно —
 * а значит, нечего и утекать.
 *
 * ЧТО ПИШЕМ. Только числа: задача, модель, токены, секунды, байты, код
 * ответа, длительность. Ни текстов, ни названий направлений, ни имён
 * файлов, ни IP.
 *
 * ФОРМАТ. Один файл на сутки: `metrics-YYYY-MM-DD.jsonl`, строка — событие.
 * Так не нужна ротация: старые дни можно удалять целиком, а сводка читает
 * только нужный диапазон.
 *
 * ЦЕНЫ — ЗЕРКАЛО `src/ai/config.ts`. Дублирование осознанное: сервер не
 * импортирует TypeScript приложения. Если тариф поменяется, менять в двух
 * местах; расхождение видно по сводке (стоимость не сойдётся с журналом
 * расходов в приложении).
 */

import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Префикс файлов метрик. */
export const METRICS_PREFIX = 'metrics-'

/** Сколько дней храним по умолчанию (сводка читает столько же). */
export const METRICS_RETENTION_DAYS = 90

/** Цены чата, ₽ за 1M токенов. */
const CHAT_PRICES = {
  'deepseek/deepseek-v4.1-flash': { input: 5.72047, output: 17.16141, cached: 0.45764 },
}

/** Цены расшифровки, ₽ за минуту звука. */
const TRANSCRIBE_PRICES = {
  'ai-sage/gigaam-v3': 0.24171,
  'openai/whisper-large-v3': 0.108,
  'openai/whisper-large-v3-turbo': 0.048,
}

/** `YYYY-MM-DD` по UTC. */
export function dayKey(date) {
  return date.toISOString().slice(0, 10)
}

/**
 * Стоимость одного события, ₽.
 *
 * `null` — модель незнакомая: лучше честно «не знаю», чем ноль, который
 * сложится с остальными и занизит счёт.
 */
export function costRub(event) {
  if (!event || event.type !== 'ai') return 0
  if (event.route === 'transcribe') {
    const perMinute = TRANSCRIBE_PRICES[event.model] ?? TRANSCRIBE_PRICES['ai-sage/gigaam-v3']
    return ((Number(event.seconds) || 0) / 60) * perMinute
  }
  const price = CHAT_PRICES[event.model]
  if (!price) return null
  const prompt = Number(event.prompt) || 0
  const cached = Math.min(Number(event.cached) || 0, prompt)
  const completion = Number(event.completion) || 0
  return (
    ((prompt - cached) * price.input + cached * price.cached + completion * price.output) / 1_000_000
  )
}

/**
 * Записывает событие. Никогда не бросает: метрика не важнее ответа
 * человеку. Ошибку только печатаем в журнал.
 */
export async function recordMetric(dir, event) {
  try {
    const at = event.at ? new Date(event.at) : new Date()
    const line = `${JSON.stringify({ ...event, at: at.toISOString() })}\n`
    await mkdir(dir, { recursive: true })
    await appendFile(join(dir, `${METRICS_PREFIX}${dayKey(at)}.jsonl`), line, 'utf8')
  } catch (error) {
    console.error('метрика не записалась:', error instanceof Error ? error.message : error)
  }
}

/** Читает события за последние `days` дней. Битые строки пропускает. */
export async function readMetrics(dir, { days = METRICS_RETENTION_DAYS, now = new Date() } = {}) {
  const from = new Date(now)
  from.setUTCDate(from.getUTCDate() - (Math.max(1, days) - 1))
  const fromDay = dayKey(from)

  let names = []
  try {
    names = await readdir(dir)
  } catch {
    return []
  }

  const events = []
  for (const name of names.sort()) {
    if (!name.startsWith(METRICS_PREFIX) || !name.endsWith('.jsonl')) continue
    const day = name.slice(METRICS_PREFIX.length, -'.jsonl'.length)
    if (day < fromDay) continue
    let text = ''
    try {
      text = await readFile(join(dir, name), 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        events.push(JSON.parse(line))
      } catch {
        // Битая строка не должна обнулять всю сводку.
      }
    }
  }
  return events
}

/**
 * Сводка: итоги, по дням и по моделям.
 *
 * `installs` — сколько разных `X-Muza-Install` видели; если приложение
 * заголовок не шлёт, будет 0 (и это нормально).
 */
export async function summarizeMetrics(dir, options = {}) {
  const days = Math.max(1, Number(options.days) || 30)
  const now = options.now ? new Date(options.now) : new Date()
  const events = await readMetrics(dir, { days, now })

  const totals = {
    requests: 0,
    costRub: 0,
    unpriced: 0,
    tokensIn: 0,
    tokensOut: 0,
    tokensCached: 0,
    seconds: 0,
    uploadBytes: 0,
    uploads: 0,
    errors: 0,
  }
  const byDay = {}
  const byModel = {}
  const installs = new Set()

  const bump = (bucket, event, cost) => {
    bucket.requests += 1
    bucket.tokensIn += Number(event.prompt) || 0
    bucket.tokensOut += Number(event.completion) || 0
    bucket.tokensCached += Number(event.cached) || 0
    bucket.seconds += Number(event.seconds) || 0
    if (cost === null) bucket.unpriced = (bucket.unpriced || 0) + 1
    else bucket.costRub += cost
  }

  for (const event of events) {
    const cost = costRub(event)
    if (typeof event.install === 'string' && event.install !== '') installs.add(event.install)
    const day = typeof event.at === 'string' ? event.at.slice(0, 10) : dayKey(now)

    if (event.type === 'upload') {
      totals.uploads += 1
      totals.uploadBytes += Number(event.bytes) || 0
      if (!event.ok) totals.errors += 1
      const bucket = (byDay[day] ??= { requests: 0, costRub: 0, uploadBytes: 0, uploads: 0, errors: 0, tokensIn: 0, tokensOut: 0, tokensCached: 0, seconds: 0 })
      bucket.uploads += 1
      bucket.uploadBytes += Number(event.bytes) || 0
      if (!event.ok) bucket.errors += 1
      continue
    }

    totals.requests += 1
    if (cost === null) totals.unpriced += 1
    else totals.costRub += cost
    totals.tokensIn += Number(event.prompt) || 0
    totals.tokensOut += Number(event.completion) || 0
    totals.tokensCached += Number(event.cached) || 0
    totals.seconds += Number(event.seconds) || 0
    if (Number(event.status) >= 400) totals.errors += 1

    const dayBucket = (byDay[day] ??= { requests: 0, costRub: 0, uploadBytes: 0, uploads: 0, errors: 0, tokensIn: 0, tokensOut: 0, tokensCached: 0, seconds: 0 })
    bump(dayBucket, event, cost)
    if (Number(event.status) >= 400) dayBucket.errors += 1

    const model = String(event.model ?? event.route ?? 'неизвестно')
    const modelBucket = (byModel[model] ??= { requests: 0, costRub: 0, tokensIn: 0, tokensOut: 0, tokensCached: 0, seconds: 0 })
    bump(modelBucket, event, cost)

  }

  const round = (value) => Math.round(value * 10000) / 10000
  totals.costRub = round(totals.costRub)
  for (const bucket of Object.values(byDay)) bucket.costRub = round(bucket.costRub)
  for (const bucket of Object.values(byModel)) bucket.costRub = round(bucket.costRub)

  return {
    from: dayKey(new Date(now.getTime() - (days - 1) * 86400000)),
    to: dayKey(now),
    days,
    installs: installs.size,
    totals,
    byDay,
    byModel,
  }
}

/** Удаляет файлы метрик старше срока хранения. */
export async function pruneMetrics(dir, { days = METRICS_RETENTION_DAYS, now = new Date() } = {}) {
  const from = new Date(now)
  from.setUTCDate(from.getUTCDate() - Math.max(1, days))
  const fromDay = dayKey(from)
  let names = []
  try {
    names = await readdir(dir)
  } catch {
    return 0
  }
  let removed = 0
  for (const name of names) {
    if (!name.startsWith(METRICS_PREFIX) || !name.endsWith('.jsonl')) continue
    const day = name.slice(METRICS_PREFIX.length, -'.jsonl'.length)
    if (day >= fromDay) continue
    try {
      const { unlink } = await import('node:fs/promises')
      await unlink(join(dir, name))
      removed += 1
    } catch {
      /* не удалилось — не беда */
    }
  }
  return removed
}
