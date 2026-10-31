/**
 * Фоновый разбор материалов: расшифровка речи и понимание картинок.
 *
 * РЕШЕНИЕ АВТОРА: делать это сразу после загрузки, а не по кнопке.
 * «Постоянно нажимать „расшифровать“, плюс разбирать нерасшифрованные видео
 * в разборе — это так себе». Цена оказалась ниже, чем мы думали сначала
 * (около копейки за запись), и ручной шаг того не стоит.
 *
 * Это меняет прежнее правило «ничего в фоне». Поэтому здесь есть оговорки,
 * без которых автоматика была бы опасной:
 *
 * - **ничего не отправляем, если нет ключа** — иначе каждый запуск давал бы
 *   пачку ошибок;
 * - **уважаем `ai_opt_out`** — идея, исключённая человеком из ИИ-обработки,
 *   не уходит в сеть ни при каких обстоятельствах. Раньше это поле нигде
 *   не проверялось, и мы бы нарушили обещание о приватности;
 * - **уже распознанное не трогаем**, а неудачное не повторяем бесконечно:
 *   ручная кнопка остаётся для повтора;
 * - **по одному файлу за раз** и в фоне: телефон не должен греться
 *   и упираться, а список обновляется по мере готовности.
 */

import { materialRepository, type Idea, type Material } from '../data'
import { metaStore } from '../directions/meta'
import { readApiKey } from '../directions/meta'
import { createTranscriptionService } from '../video/TranscriptionService'
import { createLlmClient } from '../ai'
import { captureFrames } from '../video/frames'
import { buildFramesMessages } from './prompt'
import { isReadable } from './health'
import { createImageUnderstandingService } from './ImageUnderstandingService'

/** Короткий текст считаем отсутствием речи: музыка, шум, случайная фраза. */
const MIN_SPEECH_CHARS = 20

export interface AutoProcessOptions {
  /** Идеи, исключённые человеком из ИИ-обработки: их не отправляем никогда. */
  ideas?: readonly Idea[]
  /** Что-то готово — сообщаем наружу, чтобы список обновился сразу. */
  onUpdated?: (material: Material) => void
  /** Отмена: при уходе со страницы работа прекращается. */
  signal?: AbortSignal
}

export interface AutoProcessReport {
  processed: number
  failed: number
  /** Сколько пропущено из-за запрета на ИИ — честно показываем в журнале. */
  skippedOptOut: number
}

/** Нужен ли этому материалу автоматический разбор. */
export function needsProcessing(material: Material): boolean {
  if (!material.blob) return false
  // Уже есть текст — второй раз не платим.
  if ((material.extracted_text ?? '').trim() !== '') return false
  // Провал не повторяем: иначе каждый запуск снова тратил бы деньги на то,
  // что уже не получилось. Повторить можно кнопкой.
  if (material.extraction === 'failed' || material.extraction === 'skipped') return false
  return material.kind === 'video' || material.kind === 'audio' || material.kind === 'image'
}

/**
 * Разбирает материалы пакетом. Никогда не бросает: автоматика не должна
 * ломать приложение, даже если сеть пропала на середине.
 */
export async function autoProcessMaterials(
  materials: readonly Material[],
  options: AutoProcessOptions = {},
): Promise<AutoProcessReport> {
  const report: AutoProcessReport = { processed: 0, failed: 0, skippedOptOut: 0 }

  // Без ключа ничего не делаем: это не ошибка, а обычное состояние первого
  // запуска. Тихая пачка неудач была бы хуже.
  const key = await readApiKey().catch(() => '')
  if (key === '') return report

  const optOut = new Set((options.ideas ?? []).filter((idea) => idea.ai_opt_out).map((idea) => idea.id))

  const queue = materials.filter(needsProcessing)
  if (queue.length === 0) return report

  // Сервисы создаём один раз на весь пакет: они тяжёлые (ядро ffmpeg,
  // настройки), и создавать их на каждый файл было бы расточительно.
  let transcription: Awaited<ReturnType<typeof createTranscriptionService>> | null = null
  let understanding: Awaited<ReturnType<typeof createImageUnderstandingService>> | null = null

  for (const material of queue) {
    if (options.signal?.aborted) break

    if (optOut.has(material.idea_id)) {
      report.skippedOptOut += 1
      continue
    }

    try {
      const blob = material.blob
      if (!blob) continue

      // ФАЙЛ МОЖЕТ БЫТЬ ПОТЕРЯН. Браузер молча вытесняет большие видео,
      // когда ему мало места, а запись «видео 231 МБ» остаётся. Раньше это
      // выглядело как «В записи нет речи» — то есть мы обвиняли ролик в том,
      // чего в нём нет, и человек искал причину в себе. Теперь говорим как есть.
      if (!(await isReadable(blob))) {
        await materialRepository
          .update(material.id, { extraction: 'failed' })
          .catch(() => null)
        report.failed += 1
        continue
      }

      let text: string | null = null

      if (material.kind === 'image') {
        understanding ??= await createImageUnderstandingService({ store: metaStore })
        const outcome = await understanding.understand({
          source: {
            blob,
            mimeType: material.mime ?? blob.type ?? null,
            name: material.file,
          },
        })
        if (outcome.ok) text = outcome.result.text
      } else {
        transcription ??= await createTranscriptionService({ store: metaStore })
        const outcome = await transcription.transcribe({
          source: {
            blob,
            mimeType: material.mime ?? blob.type ?? null,
            name: material.file,
            durationSec: material.duration_sec ?? null,
          },
        })
        if (outcome.ok) text = outcome.result.text
      }

      // РОЛИК БЕЗ РЕЧИ. Расшифровывать нечего, но это не значит, что идеи
      // нет: по кадрам видно, что показывают и что написано на экране.
      // Раньше такая запись оставалась «Записью без слов» навсегда.
      //
      // Ролик с ОДНОЙ МУЗЫКОЙ — тот же случай. Но здесь есть ловушка:
      // на музыке распознавание речи иногда выдаёт мусор («спасибо за
      // просмотр») вместо пустоты. Тогда кадры не запускались бы, и в идее
      // оставалась бы случайная фраза. Поэтому короткий текст считаем
      // отсутствием речи: настоящая речь редко короче двадцати знаков.
      const speechTooShort = text !== null && text.trim() !== '' && text.trim().length < MIN_SPEECH_CHARS
      if ((text === null || text.trim() === '' || speechTooShort) && material.kind === 'video') {
        const frames = await captureFrames(blob, { count: 6 })
        if (frames.length > 0) {
          const client = await createLlmClient({ store: metaStore })
          const outcome = await client.chat(buildFramesMessages(frames), {
            task: 'frames',
            // Кадры — это картинки, а картинки «весят» много. Запас нужен
            // на описание, а не на рассуждение.
            maxTokens: 512,
          })
          // Кадры описывают то, что видно, — и это полезнее случайной
          // фразы. Заменяем только если описание действительно содержательнее.
          if (outcome.ok) {
            const described = outcome.data.trim()
            if (described !== '' && described.length > (text ?? '').trim().length) text = described
          }
        }
      }

      if (text !== null && text.trim() !== '') {
        const updated = await materialRepository.update(material.id, {
          extraction: 'done',
          extracted_text: text,
        })
        options.onUpdated?.(updated)
        report.processed += 1
      } else {
        // Понятное «речи нет» — это не сбой, но помечаем, чтобы не повторять.
        await materialRepository.update(material.id, { extraction: 'failed' }).catch(() => null)
        report.failed += 1
      }
    } catch {
      report.failed += 1
      await materialRepository.update(material.id, { extraction: 'failed' }).catch(() => null)
    }
  }

  return report
}
