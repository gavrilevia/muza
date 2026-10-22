/**
 * Конфиг сжатия видео: цифры, а не код вызова.
 *
 * Здесь собраны параметры, которые меняются решением продукта («по умолчанию
 * 720p», сколько битрейта оставлять), и адрес ядра ffmpeg. Вызывающий код
 * передаёт только то, что действительно отличается от общего случая.
 *
 * ## Про сборку ядра — это важно
 *
 * Берём **@ffmpeg/core** (одиночная сборка), а НЕ `@ffmpeg/core-mt`.
 * Причина простая: многопоточная сборка требует `SharedArrayBuffer`, а тот
 * отдаётся браузером только с заголовками COOP/COEP. GitHub Pages таких
 * заголовков не отдаёт и отдавать не будет — значит, `-mt` на публикации
 * просто не запустится. Одиночное ядро работает без заголовков.
 * Проверено по содержимому пакета: в `dist/esm/ffmpeg-core.js` версии 0.12.9
 * нет ни `SharedArrayBuffer`, ни pthread-вызовов.
 *
 * ## Откуда берётся ядро
 *
 * По умолчанию — с CDN (`unpkg`), по точной версии: 31 МБ wasm в репозиторий
 * и в `public/` не кладём (и не раздуваем бандл). Если ядро понадобится
 * держать у себя, достаточно подменить `coreBaseUrl` — интерфейс от этого
 * не меняется. Оговорка: у `@ffmpeg/core` лицензия GPL-2.0-or-later
 * (как у самого FFmpeg) — при самохостинге это стоит учесть.
 */

import type { VideoCompressionSettings, VideoCompressionStage } from './types'

/** Версия однопоточного ядра ffmpeg. Менять только вместе с проверкой. */
export const VIDEO_CORE_VERSION = '0.12.9'

/**
 * База, откуда берётся однопоточное ядро.
 *
 * Именно `dist/esm`: ядро загружается как ES-модуль внутри module-worker
 * (так его собирает Vite), и только у esm-сборки есть `export default`.
 */
export const VIDEO_CORE_BASE_URL = `https://unpkg.com/@ffmpeg/core@${VIDEO_CORE_VERSION}/dist/esm`

/** Путь к скрипту ядра внутри `VIDEO_CORE_BASE_URL`. */
export const VIDEO_CORE_SCRIPT = 'ffmpeg-core.js'

/** Путь к wasm-модулю ядра внутри `VIDEO_CORE_BASE_URL`. */
export const VIDEO_CORE_WASM = 'ffmpeg-core.wasm'

/** Тип результата: H.264 + AAC в mp4 — читается везде, где есть браузер. */
export const VIDEO_OUTPUT_MIME = 'video/mp4'

/** Имя результата во внутренней файловой системе ffmpeg. */
export const VIDEO_OUTPUT_NAME = 'muza-compressed.mp4'

/** Имя исходника, когда по типу не удалось понять расширение. */
export const VIDEO_FALLBACK_INPUT_NAME = 'muza-input.mp4'

/**
 * Разумный битрейт по высоте кадра (H.264, одна дорожка видео).
 * Значения — «смотрибельно на телефоне», не максимум качества: задача сжатия —
 * освободить место, а не сохранить 4K.
 */
export const VIDEO_BITRATE_BY_HEIGHT: ReadonlyArray<{ height: number; kbps: number }> = [
  { height: 2160, kbps: 14000 },
  { height: 1440, kbps: 7000 },
  { height: 1080, kbps: 4500 },
  { height: 720, kbps: 2500 },
  { height: 480, kbps: 1200 },
  { height: 360, kbps: 700 },
  { height: 240, kbps: 400 },
]

/**
 * Значения по умолчанию.
 *
 * Почему 720 и 2500 кбит/с: по ВИДЕО.md это даёт −60% для своей съёмки 1080p
 * и −75% для 4K, а картинка остаётся «посмотреть через год». Reels 720p
 * обычно и так лежат около 2.5 Мбит/с — такие файлы модуль не трогает
 * (см. `bitrateTolerance`).
 */
export const DEFAULT_VIDEO_COMPRESSION_SETTINGS: VideoCompressionSettings = {
  targetHeight: 720,
  videoBitrateKbps: null, // null — берём из таблицы по целевой высоте
  audioBitrateKbps: 128,
  videoCodec: 'libx264',
  audioCodec: 'aac',
  preset: 'veryfast',
  pixelFormat: 'yuv420p',
  maxrateFactor: 1.5,
  bufsizeSeconds: 3,
  bitrateTolerance: 1.25,
  // Выше этого файл целиком копируется в память wasm, а heap у wasm32 —
  // 2 ГБ на всё. Такой файл честнее отдать серверной реализации.
  maxInputBytes: 1024 * 1024 * 1024,
  metadataTimeoutMs: 10_000,
  coreLoadTimeoutMs: 120_000,
  encodeTimeoutMs: 30 * 60_000,
}

/**
 * Доли общего прогресса по этапам.
 *
 * Холодный запуск включает скачивание ядра (десятки мегабайт) — оно заметно
 * на глаз, поэтому ему отдана треть полосы. В тёплом запуске ядро уже
 * загружено, и почти вся полоса принадлежит кодированию.
 */
export const VIDEO_PROGRESS_STAGES_COLD: Readonly<
  Record<VideoCompressionStage, readonly [number, number]>
> = {
  check: [0, 0.02],
  download: [0.02, 0.35],
  probe: [0.35, 0.4],
  encode: [0.4, 0.98],
  finish: [0.98, 1],
}

/** То же, но ядро уже загружено — скачивания в полосе нет. */
export const VIDEO_PROGRESS_STAGES_WARM: Readonly<
  Record<VideoCompressionStage, readonly [number, number]>
> = {
  check: [0, 0.02],
  download: [0.02, 0.02],
  probe: [0.02, 0.05],
  encode: [0.05, 0.98],
  finish: [0.98, 1],
}

/**
 * Битрейт под целевую высоту: берём ближайшую табличную строку, а за
 * пределами таблицы — пересчитываем по площади кадра (битрейт растёт
 * примерно как высота в степени 1.5).
 */
export function videoBitrateForHeight(height: number): number {
  const wanted = Number.isFinite(height) && height > 0 ? height : 720
  const table = VIDEO_BITRATE_BY_HEIGHT
  let nearest = table[table.length - 1]
  let best = Number.POSITIVE_INFINITY
  for (const row of table) {
    const distance = Math.abs(row.height - wanted)
    if (distance < best) {
      best = distance
      nearest = row
    }
  }
  if (wanted === nearest.height) return nearest.kbps
  // Одна формула на оба направления: битрейт растёт как высота в степени 1.5.
  const scaled = nearest.kbps * (wanted / nearest.height) ** 1.5
  return Math.max(100, Math.round(scaled / 50) * 50)
}

/** Чётное число: H.264 требует чётных сторон кадра. */
function clampEven(value: number, min: number, max: number): number {
  const bounded = Math.min(Math.max(Math.round(value), min), max)
  return bounded % 2 === 0 ? bounded : bounded + 1
}

function positive(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * Собирает итоговые параметры: значения по умолчанию + правки.
 * Всё, что может прийти из настроек пользователя, здесь причёсывается —
 * дальше по коду параметры уже валидные.
 */
export function resolveCompressionSettings(
  base: VideoCompressionSettings = DEFAULT_VIDEO_COMPRESSION_SETTINGS,
  overrides: Partial<VideoCompressionSettings> = {},
): VideoCompressionSettings {
  const merged: VideoCompressionSettings = { ...base, ...overrides }
  return {
    ...merged,
    // 144p — нижняя граница, выше 4320p сжимать в браузере бессмысленно.
    targetHeight: clampEven(merged.targetHeight, 144, 4320),
    videoBitrateKbps:
      merged.videoBitrateKbps === null || merged.videoBitrateKbps === undefined
        ? null
        : positive(merged.videoBitrateKbps, 2500),
    audioBitrateKbps: positive(merged.audioBitrateKbps, 128),
    maxrateFactor: Math.max(1, positive(merged.maxrateFactor, 1.5)),
    bufsizeSeconds: positive(merged.bufsizeSeconds, 3),
    bitrateTolerance: Math.max(1, positive(merged.bitrateTolerance, 1.25)),
    maxInputBytes: positive(merged.maxInputBytes, DEFAULT_VIDEO_COMPRESSION_SETTINGS.maxInputBytes),
    metadataTimeoutMs: positive(merged.metadataTimeoutMs, 10_000),
    coreLoadTimeoutMs: positive(merged.coreLoadTimeoutMs, 120_000),
    encodeTimeoutMs: positive(merged.encodeTimeoutMs, 30 * 60_000),
  }
}
