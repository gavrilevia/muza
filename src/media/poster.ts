/**
 * Обложки материалов: кадр для видео, уменьшенная копия для картинки.
 *
 * Зачем: Instagram сохраняет ролики под именами вида
 * `d2c22f1839554659878d53511cc95316.mp4`, и список идей превращается
 * в список хешей. Человек не вспомнит, что было в `d2c22f18`. Картинка
 * решает это лучше любого заголовка.
 *
 * Почему **без ffmpeg**: браузер уже умеет декодировать видео — он же
 * проигрывает эти ролики в интерфейсе. Значит, кадр можно взять через
 * `<video>` и canvas: это мгновенно, бесплатно и **не тянет 31 МБ ядра
 * ffmpeg** при первом же видео. ffmpeg остаётся для того, что браузер
 * прочитать не может.
 *
 * Храним готовый **data URL** (поле `poster`): он рисуется в списке без
 * создания ссылок и не течёт — не нужен ни `createObjectURL`, ни
 * освобождение. Размер ограничен: обложка нужна для карточки, а не для
 * просмотра, поэтому длинная сторона — 320 px и JPEG среднего качества.
 */

/** Настройки обложки. */
export interface PosterOptions {
  /** Ширина готовой картинки. Больше не нужно: это карточка списка. */
  maxWidth?: number
  /** Качество JPEG: 0…1. 0,6 — заметно меньше весит при том же виде. */
  quality?: number
  /** Сколько ждать метаданные и кадр. Медленное видео не должно висеть. */
  timeoutMs?: number
  /** Куда сообщать о ходе — для журнала и тестов. */
  onStage?: (stage: 'load' | 'seek' | 'draw' | 'done' | 'failed', note?: string) => void
}

const DEFAULTS = {
  maxWidth: 320,
  quality: 0.6,
  timeoutMs: 15_000,
}

/** Что-то пошло не так — обложки не будет. Расшифровка не должна страдать. */
function note(options: PosterOptions, stage: 'load' | 'seek' | 'draw' | 'done' | 'failed', text?: string): void {
  try {
    options.onStage?.(stage, text)
  } catch {
    /* журнал не важнее кадра */
  }
}

/** Ждёт событие элемента с ограничением по времени. */
function waitFor(
  target: HTMLVideoElement,
  event: string,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      target.removeEventListener(event, onEvent)
      target.removeEventListener('error', onError)
      resolve(ok)
    }
    const onEvent = () => finish(true)
    const onError = () => finish(false)
    const timer = setTimeout(() => finish(false), timeoutMs)
    target.addEventListener(event, onEvent, { once: true })
    target.addEventListener('error', onError, { once: true })
  })
}

/**
 * Делает обложку из видео. **Никогда не бросает**: не получилось — `null`.
 *
 * Обложка — украшение списка. Ради неё нельзя терять ни материал, ни идею,
 * поэтому все сбои (формат, который браузер не читает; таймаут на медленном
 * файле; нет canvas) заканчиваются тихим `null`.
 */
export async function captureVideoPoster(
  blob: Blob,
  options: PosterOptions = {},
): Promise<string | null> {
  const settings = { ...DEFAULTS, ...options }
  if (typeof document === 'undefined') return null

  const url = URL.createObjectURL(blob)
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.preload = 'metadata'
  video.crossOrigin = 'anonymous'
  video.src = url
  video.style.display = 'none'

  try {
    if (!(await waitFor(video, 'loadedmetadata', settings.timeoutMs))) {
      note(options, 'failed', 'метаданные не прочитались')
      return null
    }
    note(options, 'load', `длительность ${Number.isFinite(video.duration) ? video.duration.toFixed(1) : '?'} с`)

    // Кадр берём не с нуля: в начале часто чёрный экран или затемнение.
    // Десятая часть записи, но не дальше первой секунды — на длинном видео
    // десятая часть уже далеко, а на коротком секунда была бы концом.
    const duration = Number.isFinite(video.duration) ? video.duration : 0
    const at = duration > 0 ? Math.max(0.1, Math.min(1, duration * 0.1)) : 0

    if (at > 0) {
      const seeked = waitFor(video, 'seeked', settings.timeoutMs)
      video.currentTime = at
      if (!(await seeked)) {
        // Не смогли перемотать — рисуем первый доступный кадр, это тоже
        // лучше хеша. Не повод отказываться от обложки вовсе.
        note(options, 'seek', 'перемотка не удалась, беру первый кадр')
      } else {
        note(options, 'seek', `кадр на ${at.toFixed(1)} с`)
      }
    }

    const width = video.videoWidth
    const height = video.videoHeight
    if (!width || !height) {
      note(options, 'failed', 'размер кадра неизвестен')
      return null
    }

    const scale = Math.min(1, settings.maxWidth / width)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(width * scale))
    canvas.height = Math.max(1, Math.round(height * scale))
    const context = canvas.getContext('2d')
    if (!context) {
      note(options, 'failed', 'canvas недоступен')
      return null
    }
    context.drawImage(video, 0, 0, canvas.width, canvas.height)
    const dataUrl = canvas.toDataURL('image/jpeg', settings.quality)
    note(options, 'draw', `${canvas.width}×${canvas.height}`)

    // Пустая картинка хуже отсутствия: если canvas не нарисовался, лучше
    // оставить список как есть, чем показать серый прямоугольник.
    if (!dataUrl.startsWith('data:image/jpeg') || dataUrl.length < 100) {
      note(options, 'failed', 'кадр пустой')
      return null
    }
    note(options, 'done', `${Math.round(dataUrl.length / 1024)} КБ`)
    return dataUrl
  } catch (e) {
    note(options, 'failed', e instanceof Error ? e.message : String(e))
    return null
  } finally {
    // Освобождаем всегда: иначе браузер держит весь файл в памяти.
    video.removeAttribute('src')
    video.load()
    URL.revokeObjectURL(url)
  }
}

/**
 * Уменьшенная копия картинки — для того же места в списке.
 *
 * Зачем отдельная функция, а не кадр из видео: у картинки нет «момента»,
 * зато есть **поворот в EXIF**. Телефон снимает горизонтально, а записывает
 * «поверни на 90°» — без учёта этого обложки-портреты лежали бы на боку.
 * `createImageBitmap` умеет применить поворот сам (`imageOrientation`).
 *
 * Никогда не бросает: не получилось — `null`, список покажет имя файла.
 */
export async function captureImagePoster(
  blob: Blob,
  options: PosterOptions = {},
): Promise<string | null> {
  const settings = { ...DEFAULTS, ...options }
  if (typeof document === 'undefined') return null

  try {
    // `from-image` применяет поворот из EXIF — иначе фото с телефона
    // показывались бы боком.
    let bitmap: ImageBitmap
    try {
      bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' })
    } catch {
      bitmap = await createImageBitmap(blob)
    }
    note(options, 'load', `${bitmap.width}×${bitmap.height}`)

    const scale = Math.min(1, settings.maxWidth / bitmap.width)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const context = canvas.getContext('2d')
    if (!context) {
      bitmap.close?.()
      note(options, 'failed', 'canvas недоступен')
      return null
    }
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close?.()
    const dataUrl = canvas.toDataURL('image/jpeg', settings.quality)
    note(options, 'draw', `${canvas.width}×${canvas.height}`)
    if (!dataUrl.startsWith('data:image/jpeg') || dataUrl.length < 100) {
      note(options, 'failed', 'картинка пустая')
      return null
    }
    note(options, 'done', `${Math.round(dataUrl.length / 1024)} КБ`)
    return dataUrl
  } catch (e) {
    note(options, 'failed', e instanceof Error ? e.message : String(e))
    return null
  }
}

/**
 * Делает обложку по роду материала. Видео — кадр, картинка — уменьшение.
 *
 * Один вход для вызывающего кода: фон и досоздание не должны знать,
 * с чем именно имеют дело.
 */
export async function capturePoster(
  blob: Blob,
  kind: string,
  options: PosterOptions = {},
): Promise<string | null> {
  if (kind === 'video') return captureVideoPoster(blob, options)
  if (kind === 'image') return captureImagePoster(blob, options)
  return null
}

/**
 * Нужна ли обложка этому материалу.
 *
 * Видео и картинки — и только если обложки ещё нет. Без файла делать
 * нечего: рисовать придётся из содержимого, а его нет.
 */
export function needsPoster(material: { kind: string; poster?: string | null; blob?: Blob }): boolean {
  if (material.poster || !material.blob) return false
  return material.kind === 'video' || material.kind === 'image'
}
