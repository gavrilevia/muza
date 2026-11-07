/**
 * Проверка метрик: цена, сводка, фильтр по дням, битые строки.
 *
 * Живой сервер не поднимаем: логика метрик чистая и работает с папкой.
 * Проверка самих ручек — в auth-selftest (там же поднимается сервер).
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  METRICS_PREFIX,
  costRub,
  dayKey,
  pruneMetrics,
  readMetrics,
  recordMetric,
  summarizeMetrics,
} from '../server/metrics.mjs'

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass += 1
    console.log(`  ✔ ${name}${extra ? ' — ' + extra : ''}`)
  } else {
    fail += 1
    console.log(`  ✘ ${name}${extra ? ' — ' + extra : ''}`)
  }
}

const dir = join(process.cwd(), 'node_modules/.tmp/metrics-selftest')
await rm(dir, { recursive: true, force: true })
await mkdir(dir, { recursive: true })

// --- Цена -----------------------------------------------------------------

{
  const chat = costRub({
    type: 'ai',
    route: 'chat',
    model: 'deepseek/deepseek-v4.1-flash',
    prompt: 1000,
    cached: 200,
    completion: 100,
  })
  // (800 × 5.72047 + 200 × 0.45764 + 100 × 17.16141) / 1M
  ok('цена чата считается по тарифу', Math.abs(chat - 0.006384) < 0.00001, String(chat))

  const transcribe = costRub({
    type: 'ai',
    route: 'transcribe',
    model: 'ai-sage/gigaam-v3',
    seconds: 120,
  })
  ok('цена расшифровки — за минуты', Math.abs(transcribe - 0.48342) < 0.00001, String(transcribe))

  const unknown = costRub({ type: 'ai', route: 'chat', model: 'неизвестная', prompt: 10 })
  ok('незнакомая модель — «не знаю», а не ноль', unknown === null)
}

// --- Запись и сводка -------------------------------------------------------

{
  const now = new Date('2026-11-07T12:00:00Z')
  const yesterday = new Date('2026-11-06T12:00:00Z')
  const longAgo = new Date('2026-10-01T12:00:00Z')

  await recordMetric(dir, {
    type: 'ai', route: 'chat', model: 'deepseek/deepseek-v4.1-flash',
    prompt: 1000, cached: 200, completion: 100, status: 200, install: 'a', at: now,
  })
  await recordMetric(dir, {
    type: 'ai', route: 'transcribe', model: 'ai-sage/gigaam-v3',
    seconds: 120, status: 200, install: 'a', at: yesterday,
  })
  await recordMetric(dir, { type: 'upload', bytes: 1024, ok: true, install: 'b', at: now })
  await recordMetric(dir, {
    type: 'ai', route: 'chat', model: 'неизвестная', prompt: 10, status: 500, at: now,
  })
  await recordMetric(dir, { type: 'upload', bytes: 50, ok: true, at: longAgo })

  const summary = await summarizeMetrics(dir, { days: 2, now })
  ok('запросы посчитаны', summary.totals.requests === 3, String(summary.totals.requests))
  ok('стоимость сложена', Math.abs(summary.totals.costRub - (0.0064 + 0.48342)) < 0.0001, String(summary.totals.costRub))
  ok('незнакомая модель в «не оценено»', summary.totals.unpriced === 1)
  ok('ошибка 500 учтена', summary.totals.errors === 1)
  ok('загрузки и байты', summary.totals.uploads === 1 && summary.totals.uploadBytes === 1024)
  ok('установки — разные', summary.installs === 2, String(summary.installs))
  ok('старая загрузка вне диапазона', summary.totals.uploads === 1)

  ok('по дням есть оба дня', Object.keys(summary.byDay).length === 2, Object.keys(summary.byDay).join(','))
  ok('по моделям есть расшифровка', Boolean(summary.byModel['ai-sage/gigaam-v3']))

  // Битая строка не должна ломать сводку.
  const file = join(dir, `${METRICS_PREFIX}${dayKey(now)}.jsonl`)
  const before = await readFile(file, 'utf8')
  await writeFile(file, `${before}это не json\n`, 'utf8')
  const after = await summarizeMetrics(dir, { days: 2, now })
  ok('битая строка пропущена', after.totals.requests === 3)

  const onlyToday = await summarizeMetrics(dir, { days: 1, now })
  ok('день фильтруется', onlyToday.totals.requests === 2, String(onlyToday.totals.requests))
}

// --- Чистка старых ---------------------------------------------------------

{
  const oldFile = join(dir, `${METRICS_PREFIX}2026-01-01.jsonl`)
  await writeFile(oldFile, '{}\n', 'utf8')
  const removed = await pruneMetrics(dir, { days: 30, now: new Date('2026-11-07T12:00:00Z') })
  ok('старый файл удалён', removed >= 1, String(removed))
  const left = await readMetrics(dir, { days: 3650, now: new Date('2026-11-07T12:00:00Z') })
  ok('свежие остались', left.length > 0)
}

await rm(dir, { recursive: true, force: true })

console.log('--------------------------------------------')
console.log(`Пройдено: ${pass}   Провалено: ${fail}`)
process.exit(fail > 0 ? 1 : 0)
