/**
 * Запись голоса через `MediaRecorder`.
 *
 * Требования АРХИТЕКТУРА-PWA.md (раздел 4): микрофон работает и на Android,
 * и на iOS, но только по HTTPS. Захват обязан быть мгновенным, поэтому
 * запись кладётся в память маленькими порциями (`start(1000)`), а материал
 * сохраняется сразу после остановки — без транскрипции и без сети.
 *
 * Что решаем сами:
 *   - формат записи: Safari умеет только `audio/mp4`, Chrome — webm/opus;
 *   - длительность: у webm-записи из MediaRecorder в заголовке часто нет
 *     длительности, поэтому считаем время сами от старта до остановки.
 */

import { asCaptureFile, CaptureUnsupportedError, extensionForMime, pickAudioMimeType, stampedName } from './logic'
import type { CaptureFile } from './types'

/** Итог записи: файл и сколько он длился. */
export interface RecordingResult {
  file: CaptureFile
  durationSec: number
}

/** Идущая запись: её можно остановить или выбросить. */
export interface VoiceRecording {
  /** Останавливает запись и отдаёт файл. */
  stop(): Promise<RecordingResult>
  /** Останавливает запись и выбрасывает её (микрофон всё равно освобождается). */
  cancel(): void
}

/** Есть ли в браузере всё нужное для записи. */
export function isVoiceSupported(): boolean {
  if (typeof MediaRecorder === 'undefined') return false
  if (typeof navigator === 'undefined') return false
  return typeof navigator.mediaDevices?.getUserMedia === 'function'
}

/**
 * Начинает запись. Бросает `CaptureUnsupportedError`, если браузер не умеет,
 * и ошибку доступа (NotAllowedError и подобные), если пользователь запретил.
 * Сообщение для человека строит `describeCaptureError`.
 */
export async function startVoiceRecording(): Promise<VoiceRecording> {
  if (!isVoiceSupported()) {
    throw new CaptureUnsupportedError(
      'Этот браузер не умеет записывать голос. Запишите диктофоном и приложите файлом.',
    )
  }

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  const mimeType = pickAudioMimeType((type) => MediaRecorder.isTypeSupported(type))
  let recorder: MediaRecorder
  try {
    recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
  } catch (e) {
    stopTracks(stream)
    throw e
  }

  const chunks: Blob[] = []
  recorder.addEventListener('dataavailable', (event) => {
    if (event.data && event.data.size > 0) chunks.push(event.data)
  })

  const startedAt = Date.now()
  // Порция раз в секунду: если вкладку выгрузят из памяти, потеряется секунда,
  // а не вся запись.
  recorder.start(1000)

  const actualType = recorder.mimeType || mimeType || 'audio/webm'
  let finished = false

  const finish = (): RecordingResult => {
    stopTracks(stream)
    const durationSec = Math.max(0, (Date.now() - startedAt) / 1000)
    const blob = new Blob(chunks, { type: actualType })
    if (blob.size === 0) {
      throw new Error('Запись получилась пустой — микрофон ничего не передал. Попробуйте ещё раз.')
    }
    const name = stampedName('voice', extensionForMime(actualType), new Date())
    return { file: asCaptureFile(blob, name, actualType), durationSec }
  }

  return {
    stop(): Promise<RecordingResult> {
      return new Promise<RecordingResult>((resolve, reject) => {
        if (finished) {
          reject(new Error('Запись уже остановлена.'))
          return
        }
        finished = true

        const fail = (error: unknown) => {
          stopTracks(stream)
          reject(error instanceof Error ? error : new Error('Запись не удалась.'))
        }

        recorder.addEventListener(
          'stop',
          () => {
            try {
              resolve(finish())
            } catch (e) {
              fail(e)
            }
          },
          { once: true },
        )
        recorder.addEventListener('error', (event) => {
          // `event` у MediaRecorder — ErrorEvent, но lib.dom типизирует его шире.
          fail((event as unknown as { error?: unknown }).error ?? new Error('Сбой записи.'))
        })

        try {
          if (recorder.state === 'inactive') resolve(finish())
          else recorder.stop()
        } catch (e) {
          fail(e)
        }
      })
    },

    cancel(): void {
      if (finished) return
      finished = true
      try {
        if (recorder.state !== 'inactive') recorder.stop()
      } catch {
        /* запись уже мертва — важно только отпустить микрофон */
      }
      stopTracks(stream)
    },
  }
}

/** Микрофон нужно отпускать всегда: иначе индикатор записи горит и после остановки. */
function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop()
}
