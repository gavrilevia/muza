/**
 * Обучение промпта на правках человека.
 *
 * Идея: направление ставит ИИ, но **решает человек**. Когда он переставляет
 * направление руками, это не «ещё одно событие», а **урок**: вот такой текст
 * он отнёс вот к такой группе.
 *
 * Почему без этого нельзя: учиться на собственных догадках модели значит
 * **закреплять её ошибки**. Нужен сигнал от человека — и он берётся только
 * из правок.
 *
 * Как это попадает в промпт: пара «текст → направление» уходит в примеры
 * (`buildClassifierMessages`). Поэтому промпт говорит языком ЭТОГО человека,
 * и перекос в тематику уходит сам: у кулинара примеры кулинарные,
 * у программиста — программные.
 *
 * Про кэш: примеры меняются ТОЛЬКО когда человек правит, а не на каждой
 * идее. Между правками префикс стабилен, и кэш провайдера продолжает
 * работать (он в 12 раз дешевле обычных токенов).
 */

import { historyStore } from '../data'

/** Один урок: как человек назвал эту мысль. */
export interface LearnedExample {
  text: string
  direction: string
}

/**
 * Последние правки человека — самые свежие важнее.
 *
 * Берём немного: промпт не должен расти бесконечно, а пять-шесть свежих
 * примеров дают больше, чем тридцать старых.
 */
export async function readLearnedExamples(limit = 6): Promise<LearnedExample[]> {
  try {
    const entries = await historyStore.listAll()
    const seen = new Set<string>()
    const result: LearnedExample[] = []

    // Свежие вперёд: история хранится по времени.
    for (let i = entries.length - 1; i >= 0 && result.length < limit; i -= 1) {
      const entry = entries[i]
      if (!entry) continue
      const meta = entry.meta ?? {}
      const direction = typeof meta.learned_direction === 'string' ? meta.learned_direction.trim() : ''
      const text = typeof meta.learned_text === 'string' ? meta.learned_text.trim() : ''
      if (direction === '' || text === '') continue
      // Одна и та же группа дважды не нужна: важно разнообразие, а не объём.
      const key = `${direction}|${text.slice(0, 40)}`
      if (seen.has(key)) continue
      seen.add(key)
      result.push({ text, direction })
    }
    return result
  } catch {
    // История недоступна — учиться не на чем. Это не ошибка: промпт
    // просто останется прежним.
    return []
  }
}
