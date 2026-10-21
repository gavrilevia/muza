/**
 * CaptureService — единственная точка, где идея рождается в базе.
 *
 * Порядок важнее деталей:
 *   1. сначала сохраняем саму идею (текст + `captured_via`) — это то, что
 *      человек уже набрал, и это нельзя потерять ни при каком сбое;
 *   2. только потом прикладываем материалы.
 * Поэтому сбой на шаге 2 даёт предупреждение, а не потерю захвата.
 *
 * Здесь нет ни сети, ни ИИ, ни ожидания обработки: захват обязан быть
 * мгновенным и работать офлайн (АРХИТЕКТУРА-PWA.md, разделы 3.2 и 4).
 */

import { ideaRepository } from '../data'
import { capturedViaFor, suggestBody, suggestTitle } from './logic'
import { saveMaterials } from './materials'
import type {
  CaptureChannel,
  CaptureFile,
  CaptureMaterialDraft,
  CaptureOutcome,
  CaptureRequest,
} from './types'

/**
 * Заготовки материалов по запросу: файлы канала плюс ссылка, если ею
 * поделились. Порядок — как пришло: файлы, потом ссылка.
 */
export function draftsFor(request: CaptureRequest): CaptureMaterialDraft[] {
  const drafts: CaptureMaterialDraft[] = []
  const files: readonly CaptureFile[] = request.files ?? []
  for (const file of files) {
    drafts.push(
      request.channel === 'voice'
        ? { kind: 'file', file, durationSec: request.durationSec ?? null }
        : { kind: 'file', file },
    )
  }
  const url = (request.url ?? '').trim()
  if (url) drafts.push({ kind: 'link', url, title: request.sourceTitle ?? null })
  return drafts
}

/** Есть ли что сохранять: пустая идея без текста и без файлов не создаётся. */
export function isEmptyCapture(request: CaptureRequest): boolean {
  const text = (request.text ?? '').trim()
  const url = (request.url ?? '').trim()
  const files = request.files ?? []
  return !text && !url && files.length === 0
}

/**
 * Сохраняет идею и, если получится, её материалы.
 *
 * Бросает только тогда, когда идею сохранить не удалось. Материалы — отдельная
 * попытка: их сбой возвращается в `warning`, а идея остаётся в базе.
 */
export async function capture(request: CaptureRequest): Promise<CaptureOutcome> {
  const files = request.files ?? []
  const channel: CaptureChannel = request.channel
  if (isEmptyCapture(request)) {
    throw new Error('Сохранять нечего: ни текста, ни файлов.')
  }

  const idea = await ideaRepository.create({
    title: suggestTitle({
      channel,
      text: request.text,
      sourceTitle: request.sourceTitle,
      url: request.url,
      files,
      durationSec: request.durationSec,
    }),
    body: suggestBody({ channel, text: request.text, url: request.url }),
    captured_via: capturedViaFor(channel, files),
  })

  let materials: CaptureOutcome['materials'] = []
  let warning: string | null = null
  try {
    materials = await saveMaterials(idea.id, draftsFor(request), channel)
  } catch (e) {
    const reason = e instanceof Error ? e.message : 'неизвестная ошибка хранилища'
    warning = `Идея сохранена, а материалы приложить не удалось: ${reason}`
  }

  return { idea, materials, warning }
}
