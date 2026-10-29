export { default as MaterialComment } from './MaterialComment.svelte'
export { default as MaterialViewer } from './MaterialViewer.svelte'
export {
  canPreview,
  firstMeaningfulLine,
  looksLikeFileName,
  meaningfulTitle,
  ownWords,
  recognizedText,
  technicalName,
} from './naming'
/**
 * Точка входа модуля «понять картинку».
 *
 * Снаружи нужно только это:
 *
 * ```ts
 * import { createImageUnderstandingService } from './media'
 *
 * const service = await createImageUnderstandingService({ store: metaStore })
 * const outcome = await service.understand({
 *   source: { blob: material.blob, mimeType: material.mime },
 *   onProgress: ({ progress, message }) => showProgress(progress, message),
 * })
 * if (outcome.ok) {
 *   // outcome.result.text → extracted_text, extraction='done'
 *   // outcome.result.costRub — стоимость по токенам
 * } else {
 *   // outcome.error.message — причина; материал и идея не тронуты
 * }
 * ```
 *
 * Или готовой кнопкой:
 *
 * ```svelte
 * <ImageButton {material} onChanged={applyMaterial} />
 * ```
 *
 * Почему модуль лежит отдельно от `src/video`: видео — это сжатие и речь,
 * у него своя тяжёлая логика (ffmpeg, модели распознавания). Картинка —
 * другой вход и другая задача (зрение модели), но тот же общий клиент ИИ.
 * `src/media` — место для работы с содержимым материалов вообще, чтобы
 * `src/video` не превращался в свалку.
 */

export { default as ImageButton } from './ImageButton.svelte'

export {
  IMAGE_UNDERSTANDING_TASK,
  ImageUnderstandingService,
  createImageUnderstandingService,
} from './ImageUnderstandingService'
export type {
  CreateImageUnderstandingServiceOptions,
  ImageUnderstandingDeps,
} from './ImageUnderstandingService'

export {
  IMAGE_JPEG_QUALITY,
  IMAGE_WEBP_QUALITY,
  MAX_IMAGE_LONG_SIDE,
  bytesToBase64,
  bytesToDataUrl,
  detectImageMime,
  detectImageMimeBytes,
  fitImageSize,
  prepareImageForModel,
} from './image'
export type { ImageFit, ImagePreparer } from './image'

export { IMAGE_UNDERSTANDING_PROMPT, buildImageUnderstandingMessages } from './prompt'
export { describeImageCost, formatImageCost } from './format'

export { ImageUnderstandingError } from './types'
export type {
  ImageUnderstandingErrorCode,
  ImageUnderstandingJob,
  ImageUnderstandingOutcome,
  ImageUnderstandingProgress,
  ImageUnderstandingResult,
  ImageUnderstandingSource,
  ImageUnderstandingStage,
  PreparedImage,
  SupportedImageMime,
} from './types'
