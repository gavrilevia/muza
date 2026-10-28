/**
 * Точка входа модуля захвата.
 *
 * Интерфейс (App.svelte) знает только это:
 *   import { capture, CaptureChannels } from './capture'
 *
 * Разделение внутри:
 *   - `logic`    — чистые решения (проверяются тестом в Node);
 *   - `captureService` — сохранить идею и материалы;
 *   - `recorder` — микрофон (MediaRecorder);
 *   - `shareInbox` — приём «Поделиться» из другого приложения;
 *   - `CaptureChannels.svelte` — кнопки каналов.
 */

export { default as CaptureChannels } from './CaptureChannels.svelte'

export { capture, captureMany, draftsFor, ideaRequestsFor, isEmptyCapture } from './captureService'
export { materialFromDraft, saveMaterials } from './materials'
export { backfillPosters, onPosterReady } from './captureService'
export {
  describeCaptureError,
  unsupportedMessage,
  CaptureUnsupportedError,
  asCaptureFile,
  capturedViaFor,
  capturedViaForFiles,
  capturedViaForShare,
  extensionForMime,
  firstLine,
  formatDuration,
  hostOf,
  isAudio,
  isImage,
  isPdf,
  isPlainText,
  isVideo,
  materialCanBeProcessed,
  materialKindFor,
  materialOriginFor,
  pickAudioMimeType,
  pluralRu,
  shareReturnState,
  splitSharedFields,
  stampedName,
  suggestBody,
  suggestTitle,
  AUDIO_MIME_CANDIDATES,
} from './logic'
export type { CaptureAction, SharedFields, TitleInput, BodyInput } from './logic'
export { isVoiceSupported, startVoiceRecording } from './recorder'
export type { RecordingResult, VoiceRecording } from './recorder'
export {
  SHARE_CACHE,
  clearSharedHandoff,
  hasSharedHandoff,
  peekSharedHandoff,
  shouldAcceptShare,
} from './shareInbox'
export type { ShareHandoff } from './shareInbox'
export type {
  CaptureBatchOutcome,
  CaptureChannel,
  CaptureFile,
  CaptureMaterialDraft,
  CaptureOutcome,
  CaptureRequest,
  FileLike,
  StoredMaterial,
} from './types'
