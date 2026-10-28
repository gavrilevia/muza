/**
 * Слияние дублей: одна мысль, записанная дважды.
 *
 * Вопрос про дубли решается **в триаже и только там** (`КОНЦЕПЦИЯ-v1.md`):
 * при захвате спрашивать нельзя — это трение в момент, когда человек просто
 * хочет сохранить мысль.
 *
 * Главное правило проекта: **ничего не удаляется**. Поэтому слияние — это
 * не «удалить лишнее», а «соединить, а след оставить»:
 *
 * - текст второй идеи **дописывается** в первую с пометкой, откуда он;
 * - материалы **переезжают** в первую (файлы не копируются и не теряются);
 * - вторая уходит **в архив** с причиной «слито с …» — она остаётся
 *   в поиске, и её можно вернуть, если слияние оказалось ошибкой.
 *
 * Так человек ничего не теряет даже при неверном решении — а это важнее,
 * чем аккуратность списка.
 */

import { ideaRepository, materialRepository } from '../data'
import { historyStore } from '../data'
import { appendIdeaNote } from '../data/edit'
import type { Idea } from '../data'
import type { Material } from '../data'

/** Что получилось при слиянии: для отчёта человеку. */
export interface MergeOutcome {
  target: Idea
  merged: Idea
  movedMaterials: number
}

/**
 * Дописывает идею `sourceId` в `targetId`.
 *
 * Порядок действий выбран так, чтобы **сбой на любом шаге не терял данные**:
 * сначала переносим материалы, потом текст, и только потом архивируем
 * вторую. Если что-то оборвётся в середине, обе идеи останутся на месте,
 * а материалы — у одной из них.
 */
export async function mergeIdeas(targetId: string, sourceId: string): Promise<MergeOutcome> {
  if (targetId === sourceId) throw new Error('Это одна и та же идея.')

  const target = await ideaRepository.get(targetId)
  if (!target) throw new Error('Идея, с которой сливаем, не нашлась.')
  const source = await ideaRepository.get(sourceId)
  if (!source) throw new Error('Идея, которую сливаем, не нашлась.')

  // 1. Материалы переезжают к первой идее: файлы остаются те же, меняется
  //    только принадлежность — копировать байты незачем.
  const materials: Material[] = await materialRepository.listByIdea(sourceId)
  let movedMaterials = 0
  for (const material of materials) {
    await materialRepository.update(material.id, { idea_id: targetId })
    movedMaterials += 1
  }

  // 2. Текст второй идеи дописывается в первую — вместе с её заголовком,
  //    иначе из записи непонятно, что именно пришло из второй.
  const sourceText = [source.title.trim(), source.body.trim()].filter((part) => part !== '').join('\n\n')
  const note = sourceText === ''
    ? `(пустая запись, только материалы)`
    : `${sourceText}\n\n— из идеи, слитой с этой`
  const withText = await appendIdeaNote(targetId, note)

  // 3. Вторая уходит в архив С ПРИЧИНОЙ и остаётся в поиске.
  const archived = await ideaRepository.update(sourceId, {
    status: 'archived',
    archived_reason: `слито с «${(target.title || target.body).trim().slice(0, 60)}»`,
  })

  await historyStore.append({
    idea_id: sourceId,
    type: 'archive',
    actor: 'user',
    summary: 'Слито с другой идеей (в архив, возвратимо)',
    ref: targetId,
  })
  await historyStore.append({
    idea_id: targetId,
    type: 'link',
    actor: 'user',
    summary: `Присоединена идея${movedMaterials > 0 ? ` и ${movedMaterials} ${plural(movedMaterials, 'материал', 'материала', 'материалов')}` : ''}`,
    ref: sourceId,
  })

  return { target: withText, merged: archived, movedMaterials }
}

/** Есть ли что вообще сливать: без текста и материалов сливать нечего. */
export function canMerge(idea: Idea, materials: readonly Material[]): boolean {
  return idea.title.trim() !== '' || idea.body.trim() !== '' || materials.length > 0
}

function plural(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10
  const mod100 = count % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few
  return many
}