/**
 * Точка входа модуля сжатия видео.
 *
 * Снаружи нужно только это:
 *
 * ```ts
 * import { videoCompressor } from './video'
 *
 * // 1. Узнать, стоит ли вообще: ffmpeg здесь НЕ загружается.
 * const inspection = await videoCompressor.inspect({ blob: material.blob, mimeType: material.mime })
 * if (inspection.ok && !inspection.plan.needed) {
 *   // «Сжатие не нужно: 1280×720, 1.9 Мбит/с…» — можно показать человеку
 * } else if (inspection.ok) {
 *   showEstimate(inspection.plan.message) // «≈ 220 МБ вместо 600 МБ (−63%)»
 * }
 *
 * // 2. Сжать по кнопке. Прогресс — 0..1, можно рисовать полосу.
 * const outcome = await videoCompressor.compress({
 *   source: { blob: material.blob, mimeType: material.mime },
 *   onProgress: ({ progress, message }) => showProgress(progress, message),
 * })
 * if (outcome.ok) {
 *   // Новые байты. Оригинал НЕ тронут: что делать со старым — решает вызывающий код.
 *   const { blob, bytesBefore, bytesAfter } = outcome.result
 * } else {
 *   showError(outcome.error.message) // «Браузеру не хватило памяти…», «Сжатие не нужно…»
 * }
 * ```
 *
 * Что важно помнить вызывающему коду:
 * - модуль не трогает ни IndexedDB, ни материалы: только читает `blob` и
 *   возвращает новый (`MaterialRepository.update` — ваше решение и ваш вызов);
 * - ffmpeg подключается при первом `compress` (десятки мегабайт) и остаётся
 *   в памяти — при нехватке места зовите `release()`;
 * - `signal` реально останавливает работу: отменять длинное сжатие можно и нужно.
 */

export {
  BrowserVideoCompressor,
  createVideoCompressor,
  videoCompressor,
} from './VideoCompressor'
export type { ProgressSink, VideoCompressor } from './VideoCompressor'

export {
  DEFAULT_VIDEO_COMPRESSION_SETTINGS,
  VIDEO_CORE_BASE_URL,
  VIDEO_CORE_VERSION,
  VIDEO_OUTPUT_MIME,
  resolveCompressionSettings,
  videoBitrateForHeight,
} from './config'

export {
  buildCompressArgs,
  buildPlan,
  classifyFfmpegFailure,
  detectRuntimeEnv,
  formatBitrate,
  formatBytes,
  formatSeconds,
  inputFileNameFor,
  measuredBitrateBps,
  mergeMediaInfo,
  missingRuntimeFeatures,
  parseEncodedSeconds,
  parseProbeLine,
  planTarget,
  probeFromLines,
  progressAt,
  savingsOf,
  splitLogLines,
  targetDimensions,
} from './logic'
export type { PartialMediaInfo, VideoRuntimeEnv } from './logic'

export { VideoCompressionError } from './types'
export type {
  VideoCompressionErrorCode,
  VideoCompressionJob,
  VideoCompressionOutcome,
  VideoCompressionPlan,
  VideoCompressionProgress,
  VideoCompressionResult,
  VideoCompressionSettings,
  VideoCompressionStage,
  VideoCompressionTarget,
  VideoInspectionOutcome,
  VideoMediaInfo,
  VideoPreloadOutcome,
  VideoSource,
} from './types'
