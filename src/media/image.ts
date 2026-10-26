/**
 * Подготовка картинки к отправке модели: определить формат по байтам,
 * прочитать размеры и уменьшить длинную сторону.
 *
 * ## Почему картинка уменьшается
 *
 * Модель смотрит на изображение по пикселям, а провайдер берёт за них токены:
 * чем больше кадр, тем дороже один и тот же вопрос. Фотография с телефона
 * (например, 4032×3024) — это в разы больше пикселей, чем нужно, чтобы
 * прочитать текст или понять сюжет. Поэтому перед отправкой длинная сторона
 * приводится к ~1568 px: этого хватает и для мелкого текста на скриншоте,
 * и для узнавания предмета, а счёт и размер base64-строки остаются
 * предсказуемыми. Огромное фото без уменьшения может не пройти по лимиту
 * размера запроса — тогда человек заплатил бы за попытку и не получил ответа.
 *
 * ## Почему тип определяется по файлу
 *
 * У картинки из буфера обмена или из «Поделиться» `blob.type` бывает пустым,
 * а у файла, переименованного вручную, — неверным. Если поверить названию,
 * можно собрать `data:image/png;base64,…` из JPEG: провайдер ответит ошибкой
 * или, хуже, модель увидит мусор. Сигнатура первых байт — единственный
 * признак, который нельзя перепутать.
 */

import {
  ImageUnderstandingError,
  type PreparedImage,
  type SupportedImageMime,
} from './types'

/**
 * Предел длинной стороны. 1568 — не случайное число: это удобный потолок
 * для моделей зрения (картинка остаётся читаемой, но не стоит как гигантский
 * скан). Значение — константа, чтобы его можно было проверить тестом.
 */
export const MAX_IMAGE_LONG_SIDE = 1568

/** Качество перекодирования: текст на скриншоте остаётся различимым. */
export const IMAGE_JPEG_QUALITY = 0.9
export const IMAGE_WEBP_QUALITY = 0.9

/** Размер после подгонки: что просим у canvas и что реально уйдёт модели. */
export interface ImageFit {
  width: number
  height: number
  /** true — исходник был больше предела и его уменьшили. */
  scaled: boolean
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff]
const RIFF_SIGNATURE = [0x52, 0x49, 0x46, 0x46] // "RIFF"
const WEBP_SIGNATURE = [0x57, 0x45, 0x42, 0x50] // "WEBP"

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[offset + i] !== signature[i]) return false
  }
  return true
}

/**
 * Формат по сигнатуре. Возвращает `null` для всего, что не PNG/JPEG/WebP:
 * SVG, GIF, HEIC и архивы модели в таком виде не отправляем.
 */
export function detectImageMimeBytes(bytes: Uint8Array): SupportedImageMime | null {
  if (startsWith(bytes, PNG_SIGNATURE)) return 'image/png'
  if (startsWith(bytes, JPEG_SIGNATURE)) return 'image/jpeg'
  // WebP — это RIFF-контейнер, но не любой RIFF: на 8-м байте должно быть "WEBP".
  if (startsWith(bytes, RIFF_SIGNATURE) && startsWith(bytes, WEBP_SIGNATURE, 8)) {
    return 'image/webp'
  }
  return null
}

/** Читает только начало файла: для сигнатуры достаточно 16 байт. */
export async function detectImageMime(blob: Blob): Promise<SupportedImageMime | null> {
  const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer())
  return detectImageMimeBytes(head)
}

/**
 * Подгоняет размер под предел, не растягивая маленькие картинки.
 * Пропорции сохраняются, длинная сторона становится ровно `maxLongSide`.
 */
export function fitImageSize(
  width: number,
  height: number,
  maxLongSide: number = MAX_IMAGE_LONG_SIDE,
): ImageFit {
  const w = Math.max(1, Math.round(Number.isFinite(width) ? width : 0))
  const h = Math.max(1, Math.round(Number.isFinite(height) ? height : 0))
  const limit = Math.max(1, Math.round(maxLongSide))
  const longest = Math.max(w, h)
  if (longest <= limit) return { width: w, height: h, scaled: false }
  const ratio = limit / longest
  return {
    width: Math.max(1, Math.round(w * ratio)),
    height: Math.max(1, Math.round(h * ratio)),
    scaled: true,
  }
}

/** Байты → base64. Реализовано здесь, чтобы не тащить зависимость и FileReader. */
export function bytesToBase64(bytes: Uint8Array): string {
  // Кусками: `String.fromCharCode(...миллион аргументов)` переполняет стек.
  const chunkSize = 0x2000
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length))
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}

/** Собирает data-URL с ТЕМ типом, который определили по байтам. */
export function bytesToDataUrl(bytes: Uint8Array, mimeType: SupportedImageMime): string {
  return `data:${mimeType};base64,${bytesToBase64(bytes)}`
}

/** Функция подготовки картинки. Подменяется в тестах: canvas в Node нет. */
export type ImagePreparer = (input: {
  blob: Blob
  maxLongSide?: number
}) => Promise<PreparedImage>

/**
 * Открывает картинку браузерным декодером.
 *
 * `createImageBitmap` есть во всех актуальных браузерах и сам учитывает
 * EXIF-поворот: после уменьшения картинка будет в правильной ориентации.
 * Если его нет — это не «неподдержанный формат», а неподходящая среда;
 * сообщение так и говорит, чтобы человек не искал проблему в файле.
 */
async function decodeImage(blob: Blob): Promise<ImageBitmap> {
  if (typeof createImageBitmap !== 'function') {
    throw new ImageUnderstandingError(
      'decode_failed',
      'Браузер не умеет читать изображения для отправки. Обновите браузер или откройте «Музу» в другом.',
    )
  }
  try {
    return await createImageBitmap(blob, { imageOrientation: 'from-image' })
  } catch (cause) {
    throw new ImageUnderstandingError(
      'decode_failed',
      'Не удалось прочитать картинку: файл повреждён или браузер не понимает этот формат.',
      { cause },
    )
  }
}

/** canvas.toBlob в виде промиса: ошибка колбэка не должна теряться. */
function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob(
        (blob) => {
          if (blob) resolve(blob)
          else reject(new Error('canvas.toBlob вернул пустой результат'))
        },
        type,
        quality,
      )
    } catch (cause) {
      reject(cause)
    }
  })
}

/**
 * Готовит картинку к модели.
 *
 * Всегда перерисовывает её через canvas: это заодно нормализует поворот
 * и убирает EXIF, который модель может понять неверно. Маленькие картинки
 * не растягиваются — canvas получает их исходный размер.
 */
export const prepareImageForModel: ImagePreparer = async ({ blob, maxLongSide }) => {
  if (!(blob instanceof Blob) || blob.size === 0) {
    throw new ImageUnderstandingError('empty_file', 'Файл картинки пустой — смотреть нечего.')
  }

  const mimeType = await detectImageMime(blob)
  if (!mimeType) {
    throw new ImageUnderstandingError(
      'unsupported_format',
      'Формат картинки не поддержан: нужен PNG, JPEG или WebP. Файл не отправлен.',
    )
  }

  const bitmap = await decodeImage(blob)
  const originalWidth = bitmap.width
  const originalHeight = bitmap.height
  if (!originalWidth || !originalHeight) {
    bitmap.close()
    throw new ImageUnderstandingError('decode_failed', 'У картинки нулевой размер — отправлять нечего.')
  }

  const fit = fitImageSize(originalWidth, originalHeight, maxLongSide)

  // JPEG не умеет прозрачность: без белой подложки прозрачные места станут
  // чёрными, и текст на них пропадёт.
  const outputMime = mimeType
  const quality =
    outputMime === 'image/jpeg'
      ? IMAGE_JPEG_QUALITY
      : outputMime === 'image/webp'
        ? IMAGE_WEBP_QUALITY
        : undefined

  let outputBytes: Uint8Array
  let outputWidth = fit.width
  let outputHeight = fit.height
  try {
    if (typeof document === 'undefined') {
      throw new ImageUnderstandingError(
        'prepare_failed',
        'В этой среде нельзя уменьшить картинку: нет canvas. Файл не отправлен.',
      )
    }
    const canvas = document.createElement('canvas')
    canvas.width = fit.width
    canvas.height = fit.height
    const context = canvas.getContext('2d')
    if (!context) {
      throw new ImageUnderstandingError('prepare_failed', 'Браузер не дал canvas для подготовки картинки.')
    }
    if (outputMime === 'image/jpeg') {
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, fit.width, fit.height)
    }
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.drawImage(bitmap, 0, 0, fit.width, fit.height)

    const prepared = await canvasToBlob(canvas, outputMime, quality)
    outputBytes = new Uint8Array(await prepared.arrayBuffer())
    outputWidth = canvas.width
    outputHeight = canvas.height
  } catch (cause) {
    if (cause instanceof ImageUnderstandingError) throw cause
    throw new ImageUnderstandingError(
      'prepare_failed',
      'Не удалось уменьшить картинку перед отправкой. Файл не отправлен.',
      { cause },
    )
  } finally {
    bitmap.close()
  }

  // canvas может молча отдать PNG вместо запрошенного WebP — поэтому тип
  // подготовленной картинки тоже определяем по её байтам, а не по просьбе.
  const actualMime = detectImageMimeBytes(outputBytes)
  if (!actualMime) {
    throw new ImageUnderstandingError(
      'prepare_failed',
      'После подготовки картинка оказалась в неизвестном формате. Файл не отправлен.',
    )
  }

  return {
    dataUrl: bytesToDataUrl(outputBytes, actualMime),
    mimeType: actualMime,
    width: outputWidth,
    height: outputHeight,
    originalWidth,
    originalHeight,
    bytes: outputBytes.byteLength,
    resized: fit.scaled,
  }
}
