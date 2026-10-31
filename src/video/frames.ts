/**
 * Кадры видео: для роликов БЕЗ речи.
 *
 * Проблема, которую это решает: в ролике без слов расшифровывать нечего,
 * и модель не получает **ничего** — идея остаётся «Записью без слов».
 * А ведь по картинке понятно многое: что за предмет, что происходит,
 * что написано на экране.
 *
 * Как берём: браузер умеет декодировать видео сам (он же его проигрывает),
 * поэтому кадры достаются через `<video>` и canvas — **без ffmpeg и без
 * 31 МБ загрузки**. Это уже проверено на обложках, здесь тот же приём.
 *
 * Сколько берём: немного. Пять-восемь кадров дают представление о ролике,
 * а каждый кадр — это токены входа. Больше кадров не значит лучше:
 * на десятом подряд модель уже не видит нового.
 *
 * Никогда не бросаем: не вышло — пустой список, и идея остаётся как была.
 */

export interface FrameOptions {
  /** Сколько кадров взять. */
  count?: number
  /** Ширина кадра: для понимания этого достаточно. */
  maxWidth?: number
  /** Качество JPEG. */
  quality?: number
  /** Сколько ждать метаданные и каждый кадр. */
  timeoutMs?: number
}

const DEFAULTS = {
  count: 6,
  maxWidth: 512,
  quality: 0.6,
  timeoutMs: 15_000,
}

/** Ждёт событие элемента с ограничением по времени. */
function waitFor(target: HTMLVideoElement, event: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false
    const finish = (ok: boolean) => {
      if (done) return
      done = true
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
 * Берёт кадры равномерно по всему ролику.
 *
 * Равномерно, а не подряд с начала: начало часто вступление или заставка,
 * а суть может быть в конце. Плюс **первый кадр берём не с нуля** — там
 * бывает чёрный экран.
 */
export async function captureFrames(
  blob: Blob,
  options: FrameOptions = {},
): Promise<string[]> {
  const settings = { ...DEFAULTS, ...options }
  if (typeof document === 'undefined') return []

  const url = URL.createObjectURL(blob)
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.preload = 'metadata'
  video.src = url
  video.style.display = 'none'

  try {
    if (!(await waitFor(video, 'loadedmetadata', settings.timeoutMs))) return []
    const duration = Number.isFinite(video.duration) ? video.duration : 0
    if (duration <= 0 || !video.videoWidth) return []

    const count = Math.max(1, Math.min(settings.count, 12))
    const scale = Math.min(1, settings.maxWidth / video.videoWidth)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale))
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale))
    const context = canvas.getContext('2d')
    if (!context) return []

    const frames: string[] = []
    for (let i = 0; i < count; i += 1) {
      // Равномерно, но не с самого начала: первый кадр — на десятой части.
      const at = duration * (0.1 + (0.8 * i) / Math.max(1, count - 1))
      const seeked = waitFor(video, 'seeked', settings.timeoutMs)
      video.currentTime = Math.min(Math.max(at, 0), Math.max(0, duration - 0.05))
      if (!(await seeked)) continue
      context.drawImage(video, 0, 0, canvas.width, canvas.height)
      const dataUrl = canvas.toDataURL('image/jpeg', settings.quality)
      // Пустой кадр лучше пропустить, чем отправить серую заливку.
      if (dataUrl.startsWith('data:image/jpeg') && dataUrl.length > 100) frames.push(dataUrl)
    }
    return frames
  } catch {
    return []
  } finally {
    video.removeAttribute('src')
    video.load()
    URL.revokeObjectURL(url)
  }
}
