export { captureFrames } from './frames'
export type { FrameOptions } from './frames'
export { default as CompressButton } from './CompressButton.svelte'
/**
 * Точка входа модуля работы с видео: сжатие и расшифровка речи.
 *
 * Сжатие — снаружи нужно только это:
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
 *
 * Расшифровка речи — отдельный сервис (подробности в его шапке):
 *
 * ```ts
 * import { createTranscriptionService } from './video'
 *
 * const service = await createTranscriptionService({ store }) // ключ из meta
 * const outcome = await service.transcribe({
 *   source: { blob: material.blob, mimeType: material.mime, durationSec: material.duration },
 *   onProgress: ({ progress, message }) => showProgress(progress, message),
 * })
 * if (outcome.ok) {
 *   // outcome.result: { text, durationSec, costRub } — пишет вызывающий код
 * }
 * ```
 */

export { default as TranscribeButton } from './TranscribeButton.svelte'

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

export {
  TranscriptionService,
  createTranscriptionService,
  releaseAudioExtractor,
} from './TranscriptionService'
export type {
  AudioExtractionJob,
  AudioExtractor,
  CreateTranscriptionServiceOptions,
  TranscriptionServiceDeps,
  TranscriptionServiceOptions,
} from './TranscriptionService'

export {
  DEFAULT_MAX_UPLOAD_BYTES,
  DEFAULT_TRANSCRIPTION_SETTINGS,
  OPENAI_DIRECT_MAX_UPLOAD_BYTES,
  TRANSCRIPTION_AUDIO_MIME,
  TRANSCRIPTION_AUDIO_NAME,
  buildExtractAudioArgs,
  resolveTranscriptionSettings,
  shouldExtractAudio,
} from './transcriptionConfig'
export type {
  TranscriptionResponseFormat,
  TranscriptionSettings,
} from './transcriptionConfig'

export { TranscriptionError } from './transcriptionTypes'
export type {
  TranscriptionAudio,
  TranscriptionErrorCode,
  TranscriptionJob,
  TranscriptionOutcome,
  TranscriptionProgress,
  TranscriptionResult,
  TranscriptionSource,
  TranscriptionStage,
} from './transcriptionTypes'

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
