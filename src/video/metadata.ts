/**
 * Метаданные файла через `<video>`: длительность и размер кадра.
 *
 * Одно место на два модуля — сжатие (`VideoCompressor`) и расшифровку
 * (`TranscriptionService`). Это не «общая мелочь»: обе задачи решают по
 * длительности разные, но одинаково денежные вопросы, и разъехавшиеся копии
 * чтения дали бы разные ответы на одном и том же файле.
 *
 * ## Зачем длительность вообще читать из файла
 *
 * Стоимость расшифровки — это `длительность × тариф за минуту`. Раньше
 * длительность брали только из двух мест: `source.durationSec` (если передал
 * вызывающий код) или `encodedSec` вырезания звука. Но маленький файл (до
 * лимита отправки) уходит провайдеру **напрямую**, без вырезания: `encodedSec`
 * взять неоткуда, длительность оставалась неизвестной, и стоимость молча
 * превращалась в 0 ₽ — хотя запрос уже стоил денег. Поэтому длительность
 * читается из самого файла: `<video>` отдаёт её без ffmpeg, без копирования
 * байтов и без сети. Не убирайте этот шаг как «лишний» — он и есть источник
 * правды для стоимости небольших записей.
 *
 * ## Почему таймаут и почему `null`, а не исключение
 *
 * Браузер может не знать кодек, файл может быть повреждён, а метаданные —
 * не прийти вовсе. Это не повод срывать сжатие или расшифровку: чтение
 * ограничено таймаутом, а любой сбой возвращает `null`, и вызывающий код
 * спокойно переходит к следующему источнику длительности.
 */

import type { PartialMediaInfo } from './logic'

/**
 * Сколько ждём метаданные, мс. Одно значение на сжатие и на расшифровку:
 * это ожидание одного и того же события `loadedmetadata`, и разные цифры
 * здесь только запутали бы.
 */
export const DEFAULT_METADATA_TIMEOUT_MS = 10_000

/**
 * Как читаются метаданные. Тип нужен, чтобы в проверках подменить чтение:
 * настоящему `<video>` в Node неоткуда взяться.
 */
export type MetadataReader = (
  blob: Blob,
  timeoutMs: number,
) => Promise<PartialMediaInfo | null>

/**
 * Метаданные через `<video>`: быстро, без ffmpeg и без копирования файла.
 * `null` — браузер не смог (незнакомый кодек, битый файл, нет DOM).
 */
export async function readElementMetadata(
  blob: Blob,
  timeoutMs: number = DEFAULT_METADATA_TIMEOUT_MS,
): Promise<PartialMediaInfo | null> {
  if (typeof document === 'undefined' || typeof URL?.createObjectURL !== 'function') return null
  const url = URL.createObjectURL(blob)
  const video = document.createElement('video')
  video.preload = 'metadata'
  video.muted = true
  video.playsInline = true
  video.src = url
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('metadata timeout')), timeoutMs)
      const finish = (fn: () => void) => () => {
        clearTimeout(timer)
        fn()
      }
      video.addEventListener('loadedmetadata', finish(resolve), { once: true })
      video.addEventListener('error', finish(() => reject(new Error('metadata error'))), { once: true })
    })
    const width = video.videoWidth
    const height = video.videoHeight
    const duration = video.duration
    return {
      width: width > 0 ? width : null,
      height: height > 0 ? height : null,
      durationSec: Number.isFinite(duration) && duration > 0 ? duration : null,
    }
  } catch {
    return null
  } finally {
    video.removeAttribute('src')
    video.load()
    URL.revokeObjectURL(url)
  }
}

/**
 * Только длительность — для расчёта стоимости расшифровки.
 *
 * Логика чтения здесь не дублируется: это тот же `readElementMetadata`.
 * `null` — длительность из файла получить не удалось.
 */
export async function readDurationSec(
  blob: Blob,
  timeoutMs: number = DEFAULT_METADATA_TIMEOUT_MS,
): Promise<number | null> {
  const info = await readElementMetadata(blob, timeoutMs)
  const seconds = info?.durationSec
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? seconds : null
}
