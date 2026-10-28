/**
 * Жизнь текста идеи: дополнить и изменить.
 *
 * Замысел проекта (СХЕМА-ДАННЫХ.md): `idea.md` — **живой документ**, а
 * `history.jsonl` — **append-only журнал**. Отсюда правило: «ни одна развилка
 * не удаляется и не правится; исправление = новая развилка `reformulation`».
 *
 * Поэтому здесь две РАЗНЫЕ операции, и их нельзя смешивать:
 *
 * - **Дополнить** — «я написал мало, вот ещё мысль». Текст **дописывается**
 *   с датой и не трогает написанное раньше. Так видно, как идея росла.
 * - **Изменить** — «опечатка, сформулировал неточно». Текст меняется, но
 *   **прежняя версия остаётся в истории**: ничего не переписывается молча.
 *
 * Если оставить только правку, человек начнёт переписывать первую мысль —
 * и потеряет то, с чего начинал. А первая формулировка ценна тем, что она
 * первая.
 */

import { ideaRepository } from './IdeaRepository'
import { historyStore } from './HistoryStore'
import type { Idea } from './types'

/** Дата для пометки дополнения: «28 октября» — человеку, а не машине. */
export function noteStamp(at: Date = new Date()): string {
  try {
    const day = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' }).format(at)
    const time = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(at)
    return `${day}, ${time}`
  } catch {
    return at.toISOString().slice(0, 10)
  }
}

/**
 * Дописывает мысль к идее с датой.
 *
 * Не заменяет написанное, а добавляет: идея растёт, и это видно в карточке.
 * Дополнение становится частью тела — значит, сразу попадает и в поиск,
 * и в разбор направлений, без отдельной работы.
 */
export async function appendIdeaNote(
  id: string,
  note: string,
  at: Date = new Date(),
): Promise<Idea> {
  const clean = (note ?? '').trim()
  if (clean === '') throw new Error('Пустое дополнение добавлять нечего.')

  const idea = await ideaRepository.get(id)
  if (!idea) throw new Error('Идея не нашлась — возможно, её уже удалили.')

  const line = `— дополнено ${noteStamp(at)}: ${clean}`
  const body = idea.body.trim() === '' ? line : `${idea.body.replace(/\s+$/, '')}\n\n${line}`

  const updated = await ideaRepository.update(id, { body })
  await historyStore.append({
    idea_id: id,
    type: 'development',
    actor: 'user',
    summary: `Дополнено: ${clean.length > 80 ? `${clean.slice(0, 80)}…` : clean}`,
    meta: { note: clean },
  })
  return updated
}

/**
 * Меняет заголовок и текст идеи — для опечаток и неточных формулировок.
 *
 * Прежний текст уходит в историю: даже «просто исправил» не означает
 * «стёр». Так развилка остаётся восстанавливаемой, а журнал — честным.
 */
export async function editIdeaText(
  id: string,
  patch: { title?: string; body?: string },
): Promise<Idea> {
  const idea = await ideaRepository.get(id)
  if (!idea) throw new Error('Идея не нашлась — возможно, её уже удалили.')

  const nextTitle = patch.title === undefined ? idea.title : patch.title.trim()
  const nextBody = patch.body === undefined ? idea.body : patch.body

  const changedTitle = nextTitle !== idea.title
  const changedBody = nextBody !== idea.body
  if (!changedTitle && !changedBody) return idea

  const updated = await ideaRepository.update(id, { title: nextTitle, body: nextBody })

  // Прежнюю версию кладём в `meta`: иначе «исправление» окажется молчаливым
  // стиранием, а этого схема данных прямо запрещает.
  const what = changedTitle && changedBody ? 'заголовок и текст' : changedTitle ? 'заголовок' : 'текст'
  await historyStore.append({
    idea_id: id,
    type: 'reformulation',
    actor: 'user',
    summary: `Изменён ${what}`,
    meta: {
      previous_title: idea.title,
      previous_body: idea.body,
      reason: 'правка человеком',
    },
  })
  return updated
}
