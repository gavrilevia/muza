/**
 * TranscriptionService — расшифровка речи из видео и голосовых заметок.
 *
 * ## Что здесь есть
 *
 * - запрос к OpenAI-совместимому эндпоинту `POST /audio/transcriptions`
 *   (`multipart/form-data`): `file`, `model`, `language`, `response_format`;
 * - `response_format` всегда `json`: его принимают все модели. `verbose_json`
 *   нужен был ради `duration`, но Whisper Large V3 (запасная модель) его не
 *   принимает — провайдер отвечал 400, и спасение при сбое основной не
 *   работало. Длительность для стоимости берём из своих данных;
 * - длительность для стоимости ищется по порядку: явно переданная
 *   вызывающим кодом → прочитанная из файла через `<video>` → `encodedSec`
 *   вырезания звука → неизвестна. Чтение из файла обязательно: маленький
 *   файл уходит провайдеру без вырезания, и без этого шага стоимость
 *   становилась нулевой, хотя деньги уже списаны. Подробности — в
 *   `metadata.ts` и в `#durationFromFile`;
 * - если длительность так и не известна, стоимость — `null`, а не 0:
 *   интерфейс скажет «стоимость неизвестна». Ноль означал бы «бесплатно»,
 *   и это была бы неправда;
 * - ключ и адрес берутся из `meta` так же, как в `LlmClient`; в коде ключа нет;
 * - прогресс наружу: отправка и ожидание ответа — разные этапы (ВИДЕО.md, 5);
 * - таймаут и отмена через `AbortSignal`: закрыл карточку — работа встала;
 * - большие файлы: если файл больше лимита отправки, звук вырезается
 *   ffmpeg.wasm и уходит только он. Крупный исходник при этом монтируется
 *   в виртуальную ФС (WORKERFS), а не копируется в кучу wasm целиком:
 *   иначе на десятках мегабайт ffmpeg отвечает «Code=8». Если сервис всё
 *   равно ответил 413 — вырезаем звук и пробуем ещё раз;
 * - если перекодирование не удалось, вторая попытка копирует дорожку
 *   (`-c:a copy`): декодировать её не нужно, и незнакомый кодек ей не мешает;
 * - при сбое вырезания человек видит не только код выхода, но и причину из
 *   последних осмысленных строк лога ffmpeg — коротко, без прогресс-баров;
 * - выбор модели по языку: сначала расшифровывает основная (русская) модель,
 *   и только если в её тексте почти нет кириллицы, текст перезапрашивается
 *   у запасной (общей) модели. Русская речь лишнего запроса не делает;
 * - спасение запасной моделью при временном сбое основной: 5xx (в том числе
 *   503 «все провайдеры модели вернули ошибку»), таймаут и сетевой сбой.
 *   Если запасная ответила — отдаём её текст и говорим об этом; если нет —
 *   ошибка называет причину каждой модели. Постоянные отказы (401/403, 402,
 *   413, неизвестная модель, отмена) и `no_speech` второй попытки не делают;
 * - понятные ошибки по-русски: нет ключа (сеть не трогаем вообще), нет сети,
 *   таймаут, 401/403, 402, 413, 429, 5xx, пустой ответ, битый JSON.
 *   «В записи нет речи» — отдельный код `no_speech`: это не поломка.
 *
 * ## Чего здесь нет
 *
 * - базы и интерфейса: сервис только читает `blob` и возвращает текст;
 *   запись транскрипта в `transcript` — решение вызывающего кода;
 * - автоматического вызова модели: расшифровка запускается только по кнопке
 *   (СХЕМА-ДАННЫХ.md: «Транскрипт, кадры и OCR появляются позже, по кнопке»);
 * - повторов сетевых запросов: повторная отправка — это снова мегабайты и
 *   снова деньги, поэтому решение о повторе принимает вызывающий код по
 *   флагу `retriable`. Три исключения бесплатны для решения человека:
 *   вторая попытка вырезания (копирование дорожки), смена модели по языку
 *   (иначе текст на нерусской речи просто неверен) и запасная модель после
 *   временного сбоя основной — иначе человек получает отказ при том, что
 *   рабочая модель рядом. Неудачные попытки провайдер не тарифицирует,
 *   поэтому в `costRub` попадают только успешные.
 *
 * ## Ошибка не теряет идею и файл
 *
 * Сервис не бросает исключений и ничего не удаляет: любой сбой возвращается
 * как `{ ok: false, error }`, а исходный `blob` остаётся у вызывающего кода.
 */

import {
  costOfTranscription,
  hasApiKey,
  loadLlmConfig,
  type LlmConfig,
  type MetaStore,
  type TranscriptionPricing,
} from '../ai/config'
import {
  VIDEO_CORE_MIRRORS,
  VIDEO_CORE_MIRROR_TIMEOUT_MS,
  coreDownloadRatio,
  coreFileUrls,
  describeCoreMirrorFailures,
  downloadCoreToBlobURL,
  loadCoreFromMirrors,
  mirrorName,
  type CoreDownloadProgress,
} from './config'
import { formatBytes, formatSeconds, inputFileNameFor, parseEncodedSeconds, splitLogLines } from './logic'
import { readElementMetadata, type MetadataReader } from './metadata'
import {
  DEFAULT_TRANSCRIPTION_SETTINGS,
  FFMPEG_LOG_KEEP,
  WORKER_FS_TYPE,
  buildCopyAudioArgs,
  buildExtractAudioArgs,
  buildExtractFailureMessage,
  canRetryExtractionWithCopy,
  detectTranscriptionLanguage,
  isMeaningfulFfmpegLine,
  looksLikeMemoryFailure,
  looksLikeUnreadableFileFailure,
  pickFfmpegReasonLines,
  planAudioInput,
  resolveTranscriptionSettings,
  shouldExtractAudio,
  transcriptionModelName,
  type ExtractionFailure,
  type TranscriptionSettings,
} from './transcriptionConfig'
import {
  TranscriptionError,
  type TranscriptionAudio,
  type TranscriptionJob,
  type TranscriptionOutcome,
  type TranscriptionProgress,
  type TranscriptionResult,
  type TranscriptionSource,
  type TranscriptionStage,
} from './transcriptionTypes'
import type { FFFSType, FFmpeg, LogEvent } from '@ffmpeg/ffmpeg'

// --- Вспомогательное ---------------------------------------------------------

/** Общая полоса прогресса: длинным частям — почти всё место. */
const STAGE_RANGES: Readonly<Record<TranscriptionStage, readonly [number, number]>> = {
  check: [0, 0.02],
  extract: [0.02, 0.45],
  upload: [0.45, 0.65],
  wait: [0.65, 0.98],
  finish: [0.98, 1],
}

/** Куда сервис сообщает о ходе дела. */
type Reporter = (stage: TranscriptionStage, stageProgress: number | null, message: string) => void

/** Отмена — одна и та же ошибка на все случаи. */
function abortedError(): TranscriptionError {
  return new TranscriptionError('aborted', 'Расшифровка отменена. Файл и идея на месте.', {
    retriable: false,
  })
}

/** Положительное конечное число или `null`. */
function positiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

/** Короткий хвост текста — для понятного сообщения об ошибке. */
function shortText(text: string, limit = 200): string {
  const compact = (text ?? '').replace(/\s+/g, ' ').trim()
  return compact.length > limit ? `${compact.slice(0, limit)}…` : compact
}

/** Сообщение из тела ошибки провайдера: строка или `{ message }`. */
function errorMessageOf(error: unknown): string {
  if (typeof error === 'string') return error
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return ''
}

/**
 * Убирает из ответа провайдера совет «выберите другую модель»: в интерфейсе
 * «Музы» выбора модели нет, и предлагать человеку несуществующую кнопку —
 * значит обманывать. Остальное пояснение провайдера («все провайдеры модели
 * вернули ошибку») остаётся: это настоящая причина.
 */
function sanitizeProviderHint(text: string): string {
  return (text ?? '')
    .replace(
      /[,;]?\s*(?:и\s+)?повторите\s+запрос\s+позже\s+или\s+выберите\s+другую\s+модель\.?/gi,
      '',
    )
    .replace(/(?:или\s+)?выберите\s+другую\s+модель\.?/gi, '')
    .replace(/[,;]?\s*please\s+try\s+again\s+later\.?/gi, '')
    .replace(
      /(?:or\s+)?(?:choose|select)\s+(?:a\s+)?(?:different\s+|another\s+)?model\.?/gi,
      '',
    )
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,;:])/g, '$1')
    .trim()
}

/** Понятный хвост тела ответа об ошибке. */
function describeBody(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: unknown }
    const message = errorMessageOf(parsed?.error)
    if (message !== '') return shortText(sanitizeProviderHint(message))
  } catch {
    // Не JSON — покажем хвост как есть: так хотя бы видно, что ответил сервис.
  }
  return shortText(sanitizeProviderHint(body))
}

/** Ошибка от провайдера: понятный текст и решение «повторять или нет». */
function httpError(status: number, body: string): TranscriptionError {
  const tail = describeBody(body)
  // Пояснение провайдера сохраняем отдельно: из него собираются причины
  // обеих моделей, когда не ответила ни одна.
  const detail = tail === '' ? null : tail
  if (status === 401 || status === 403) {
    return new TranscriptionError(
      'auth',
      `Ключ API отклонён сервисом распознавания (${status}). Проверьте ключ в настройках — файл и идея на месте.`,
      { status, retriable: false, detail },
    )
  }
  if (status === 402) {
    return new TranscriptionError(
      'budget',
      `На счёте провайдера не хватает средств (402). Расшифровка не выполнена, файл не потерян.`,
      { status, retriable: false, detail },
    )
  }
  if (status === 413) {
    return new TranscriptionError(
      'too_large',
      `Сервис распознавания не принял файл: он больше допустимого размера (413). ${
        tail || 'Попробуем вырезать звук.'
      }`,
      { status, retriable: false, detail },
    )
  }
  if (status === 408) {
    return new TranscriptionError(
      'timeout',
      'Сервис распознавания не успел ответить (408). Файл не потерян — попробуйте позже.',
      { status, retriable: true, detail },
    )
  }
  if (status === 429) {
    return new TranscriptionError(
      'rate_limit',
      'Слишком много запросов к распознаванию (429). Подождите немного и попробуйте снова — файл не потерян.',
      { status, retriable: true, detail },
    )
  }
  if (status >= 500) {
    return new TranscriptionError(
      'server',
      `Сервис распознавания недоступен (${status}). Файл не потерян — подождите немного и попробуйте снова. ${tail}`,
      { status, retriable: true, detail },
    )
  }
  if (status === 415) {
    return new TranscriptionError(
      'http',
      `Сервис распознавания не принимает такой формат (415). ${tail || 'Нужен звук в mp3, m4a, wav, ogg или webm.'}`,
      { status, retriable: false, detail },
    )
  }
  return new TranscriptionError(
    'http',
    `Распознавание отклонено (${status}): ${tail || 'без пояснений'}`,
    { status, retriable: false, detail },
  )
}

/**
 * Временный ли сбой модели: 5xx (включая 503 «все провайдеры вернули
 * ошибку»), таймаут и сетевой сбой. Только при таком сбое есть смысл
 * повторить запрос другой моделью: он не связан с ключом, деньгами или
 * самим файлом и может пройти через минуту.
 *
 * 429 и битый ответ сюда **не** входят: сервис ответил, и смена модели
 * на том же эндпоинте вряд ли поможет, а лишний запрос — это лишние деньги
 * и время. 401/403 (ключ), 402 (деньги), 413 (размер), 400/404 (модель)
 * и отмена — постоянные: повтор бессмысленен.
 */
export function isTemporaryTranscriptionFailure(error: TranscriptionError): boolean {
  if (error.code === 'timeout' || error.code === 'network' || error.code === 'server') return true
  return error.status !== null && error.status >= 500
}

/**
 * Стоит ли пробовать запасную модель: сбой временный и модели различаются.
 * Если человек настроил одну и ту же модель на оба случая, второй попытки
 * нет — она была бы тем же самым запросом.
 */
export function canTryFallbackModel(
  error: TranscriptionError,
  primaryModel: string,
  fallbackModel: string,
): boolean {
  if (primaryModel === fallbackModel) return false
  return isTemporaryTranscriptionFailure(error)
}

/** Короткая причина отказа одной модели: код ответа и пояснение провайдера. */
function attemptFailureReason(error: TranscriptionError): string {
  const detail = error.detail ? ` — ${error.detail}` : ''
  if (error.code === 'server') {
    const status = error.status === null ? '' : ` (${error.status})`
    return `сервис был недоступен${status}${detail}`
  }
  if (error.code === 'timeout') {
    return error.status === 408
      ? `сервис не успел ответить (408)${detail}`
      : 'сервис не ответил за отведённое время'
  }
  if (error.code === 'network') return 'нет связи с сервисом'
  return shortText(error.message, 160)
}

/**
 * Обе модели не ответили: в тексте — причина каждой, как для зеркал ядра.
 * Иначе человек видит только половину картины и не понимает, почему
 * повторять всё ещё имеет смысл.
 */
export function describeModelFailures(
  primary: { model: string; error: TranscriptionError },
  fallback: { model: string; error: TranscriptionError },
): string {
  // Точку с конца каждой причины убираем: причины разделяются точкой
  // с запятой, и «ошибку.;» на экране выглядит как сбой вёрстки.
  const reasonOf = (model: string, error: TranscriptionError): string =>
    `${transcriptionModelName(model)}: ${attemptFailureReason(error)}`.replace(/[.\s]+$/, '')
  const reasons = [
    reasonOf(primary.model, primary.error),
    reasonOf(fallback.model, fallback.error),
  ].join('; ')
  return (
    'Сервис распознавания сейчас не отвечает — подождите немного и попробуйте снова. ' +
    'Файл и идея на месте.\n' +
    `Причины: ${reasons}.`
  )
}

/** Человеческая причина сбоя основной модели — для примечания к результату. */
function humanFailureReason(error: TranscriptionError): string {
  if (error.code === 'timeout') return 'сервис не успел ответить'
  if (error.code === 'network') return 'пропала связь'
  return 'сервис был недоступен'
}

/**
 * Похоже ли, что отказ связан с размером или форматом файла.
 * Тогда есть смысл вырезать звук и попробовать один раз ещё.
 */
function isFileRejection(error: TranscriptionError): boolean {
  if (error.status === 413 || error.status === 415) return true
  if (error.status === 400) {
    return /format|codec|media|audio|file|формат|кодек|аудио|файл/i.test(error.message)
  }
  return false
}

/** Сообщение про нехватку памяти: одно на все случаи. */
function memoryError(cause?: unknown): TranscriptionError {
  return new TranscriptionError(
    'extract_failed',
    'Браузеру не хватило памяти, чтобы вырезать звук. Закройте лишние вкладки и попробуйте ещё раз — оригинал не тронут.',
    { retriable: true, cause },
  )
}

/** Что известно о файле, когда сбой случился: нужно для понятного сообщения. */
interface ExtractionContext {
  /** Размер исходника, байт. */
  sizeBytes?: number
  /** Лимит отправки: больше него файл для браузера уже «крупный». */
  maxUploadBytes?: number
}

/**
 * Файл не удалось прочитать браузеру: это не кодек, а размер.
 *
 * Отдельное сообщение вместо `File could not be read! Code=8`: такой текст
 * ничего не говорит человеку и выглядит как поломка приложения. На деле
 * ролик слишком велик, чтобы разобрать его в браузере, и нужен сервер.
 * Оригинал при этом не тронут — это важно сказать.
 */
function unreadableInputError(context: ExtractionContext): TranscriptionError {
  const size = context.sizeBytes ?? 0
  const limit = context.maxUploadBytes ?? 0
  if (size > limit) {
    return new TranscriptionError(
      'extract_failed',
      `Видео ${formatBytes(size)} слишком большое, чтобы обработать его в браузере: нужен сервер. ` +
        'Оригинал не тронут — идея и файл на месте. Можно отправить звук отдельно ' +
        'или взять запись покороче.',
      { retriable: false },
    )
  }
  return new TranscriptionError(
    'extract_failed',
    'Не удалось прочитать файл для вырезания звука: возможно, он повреждён или недоступен. ' +
      'Оригинал не тронут — попробуйте другую запись.',
    { retriable: false },
  )
}

/**
 * Любое исключение превращаем в понятную ошибку вырезания звука.
 * Строки лога, если они есть, добавляют к сообщению настоящую причину:
 * без них остаётся только «ffmpeg не справился».
 */
function asExtractionError(
  error: unknown,
  logLines: readonly string[] = [],
  context: ExtractionContext = {},
): TranscriptionError {
  if (error instanceof TranscriptionError) return error
  const message = error instanceof Error ? error.message : String(error)
  if (/AbortError|aborted|was aborted/i.test(message)) return abortedError()
  if (looksLikeMemoryFailure(`${message} ${logLines.join(' ')}`)) return memoryError(error)
  // «Code=8» — это не причина, а симптом: браузер не смог прочитать файл
  // (обычно из-за размера). Показываем это раньше разбора лога, иначе
  // человек снова увидит технический текст вместо объяснения.
  if (looksLikeUnreadableFileFailure(`${message} ${logLines.join(' ')}`)) {
    return unreadableInputError(context)
  }
  if (pickFfmpegReasonLines(logLines).length > 0) {
    return new TranscriptionError('extract_failed', buildExtractFailureMessage(logLines), {
      retriable: true,
      cause: error,
    })
  }
  // В логе причины нет — значит, ffmpeg, скорее всего, вообще не запускался:
  // не загрузилось ядро (31 МБ по сети), не записался файл в его память или
  // ядро упало до первого вывода. Тогда единственный источник правды — сам
  // текст ошибки, и **выбрасывать его нельзя**: без него «ядро не скачалось»
  // выглядит точно так же, как «кодек не поддержан», и починить нечего.
  // Именно так мы потеряли причину на четырёх живых файлах пользователя.
  const detail = shortText(message, 160)
  return new TranscriptionError(
    'extract_failed',
    'Не удалось вырезать звук из файла. Оригинал не тронут: попробуйте ещё раз ' +
      'или отправьте голосовую заметку.' +
      (detail
        ? `\nПричина: ${detail}`
        : ' Причина неизвестна: ffmpeg не сообщил ничего — вероятно, не удалось загрузить его ядро.'),
    { retriable: true, cause: error },
  )
}

/**
 * Вторая попытка вырезания: копирование дорожки вместо перекодирования.
 *
 * Возвращает код выхода копирования или `null`, если повтор не нужен
 * (отмена, таймаут, нехватка памяти). Вынесено отдельно, чтобы решение
 * о повторе проверялось тестом без настоящего ffmpeg.
 */
export async function retryExtractionWithCopy(options: {
  /** Почему провалилась первая попытка. */
  failure: ExtractionFailure
  /** Запуск копирования: те же имена, другая команда. */
  runCopy: () => Promise<number>
}): Promise<number | null> {
  if (!canRetryExtractionWithCopy(options.failure)) return null
  return options.runCopy()
}

/** Сбой вырезания по коду выхода: причина — из лога, код — для диагностики. */
function ffmpegFailureError(
  exitCode: number,
  logLines: readonly string[],
  context: ExtractionContext,
): TranscriptionError {
  if (looksLikeMemoryFailure(logLines.join(' '))) return memoryError()
  // Тот же «Code=8», но пришедший строкой лога, а не исключением.
  if (looksLikeUnreadableFileFailure(logLines.join(' '))) return unreadableInputError(context)
  return new TranscriptionError('extract_failed', buildExtractFailureMessage(logLines, exitCode), {
    retriable: true,
  })
}

/** Обещание с ограничением по времени: зависшая загрузка не должна висеть вечно. */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => TranscriptionError,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error || typeof error === 'string' ? error : new Error(String(error)))
      },
    )
  })
}

/** Байты результата как `BlobPart`: копируем только неполный буфер. */
function bytesOf(data: Uint8Array): ArrayBuffer {
  if (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength) {
    return data.buffer as ArrayBuffer
  }
  const copy = new Uint8Array(data.byteLength)
  copy.set(data)
  return copy.buffer
}

/**
 * Ждём чтение метаданных не дольше `ms`; не успело или упало — `null`.
 *
 * Свой предел ожидания нужен поверх таймаута самого чтения: `readMetadata`
 * можно подменить, и зависшее чтение не должно подвесить расшифровку.
 * Провал здесь — не ошибка: длительность просто возьмётся из следующего
 * источника, а стоимость честно скажет, что она неизвестна.
 */
function settledWithin<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), Math.max(0, ms))
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(null)
      },
    )
  })
}

// --- Вырезание звука ---------------------------------------------------------

/** Что нужно вырезанию звука (подменяется в тестах). */
export interface AudioExtractionJob {
  source: TranscriptionSource
  settings: TranscriptionSettings
  /** Прогресс внутри этапа, 0..1; `null` — этап неделим. */
  onProgress?: (stageProgress: number | null, message: string) => void
  signal?: AbortSignal
}

/**
 * Вырезание звуковой дорожки. Отдельный тип нужен не «для красоты»:
 * настоящий ffmpeg в Node не запускается, и без подмены путь вырезания
 * нельзя проверить тестом (в бою — браузерная реализация ниже).
 */
export type AudioExtractor = (job: AudioExtractionJob) => Promise<TranscriptionAudio>

/**
 * Ядро ffmpeg для вырезания звука. Держим одно на приложение: это десятки
 * мегабайт, и скачивать их на каждую расшифровку нельзя.
 *
 * Отдельный экземпляр, а не ядро `VideoCompressor`: тот свой ffmpeg наружу
 * не отдаёт, а менять готовый модуль сжатия нельзя. Плата за это — при
 * одновременном сжатии и вырезании в памяти окажутся два ядра; если это
 * станет проблемой, `releaseAudioExtractor()` освобождает наше.
 */
let audioCore: FFmpeg | null = null
let audioCoreLoading: Promise<FFmpeg> | null = null

/** Отпускаем ядро: после сбоя доверять ему нельзя. `true` — памяти больше нет. */
function resetAudioCore(): void {
  try {
    audioCore?.terminate()
  } catch {
    // Уже мёртв — и хорошо.
  }
  audioCore = null
  audioCoreLoading = null
}

/** Освободить память, занятую ядром вырезания звука. */
export function releaseAudioExtractor(): boolean {
  resetAudioCore()
  return true
}

/**
 * Скачивает однопоточное ядро и создаёт воркер (только при первом вырезании).
 *
 * Ядро берётся не с одного CDN, а с первого доступного из `VIDEO_CORE_MIRRORS`:
 * 31 МБ с `unpkg.com` из России могут не прийти вовсе (живой случай: мелкие
 * видео расшифровывались, крупные падали, и в логе ffmpeg было пусто). Если
 * зеркало не ответило — молча пробуем следующее; JS и wasm всегда с одной
 * базы, поэтому версии совпадают. Успешный путь (первое зеркало отвечает)
 * не изменился ни на шаг.
 */
async function createAudioCore(report: Reporter2, signal?: AbortSignal): Promise<FFmpeg> {
  const outcome = await loadCoreFromMirrors<FFmpeg>({
    mirrors: VIDEO_CORE_MIRRORS,
    signal,
    // У расшифровки отдельного «бюджета ядра» нет: берём общий предел ожидания
    // одного зеркала. Полный бюджет вырезания (extractTimeoutMs) остаётся
    // снаружи, в `ensureAudioCore`, и всё равно ограничивает перебор.
    timeoutMs: VIDEO_CORE_MIRROR_TIMEOUT_MS,
    onMirrorFailed: (failure, nextMirror) => {
      report(
        null,
        nextMirror === null
          ? `Зеркало ${mirrorName(failure.mirror)}: ${failure.reason}.`
          : `Зеркало ${mirrorName(failure.mirror)}: ${failure.reason} — пробуем ${mirrorName(nextMirror)}…`,
      )
    },
    load: async (mirror, attemptSignal) => {
      const { FFmpeg: FFmpegClass } = await import('@ffmpeg/ffmpeg')
      const module = new FFmpegClass()
      const urls = coreFileUrls(mirror)
      let coreURL: string | null = null
      let wasmURL: string | null = null
      const download =
        (from: number, to: number) =>
        (event: CoreDownloadProgress): void => {
          const ratio = coreDownloadRatio(event)
          report(
            ratio === null ? null : from + (to - from) * ratio,
            `Готовим ffmpeg… ${formatBytes(event.received)}`,
          )
        }
      try {
        // Своё скачивание вместо `toBlobURL` с прогрессом: у той ошибка
        // «body stream already read» на jsdelivr (подробно — в config.ts).
        coreURL = await downloadCoreToBlobURL(urls.script, 'text/javascript', {
          signal: attemptSignal,
          onProgress: download(0, 0.5),
        })
        wasmURL = await downloadCoreToBlobURL(urls.wasm, 'application/wasm', {
          signal: attemptSignal,
          onProgress: download(0.5, 1),
        })
        await module.load({ coreURL, wasmURL }, { signal: attemptSignal })
        return module
      } catch (error) {
        // Ядро этой попытки больше не нужно: следующее зеркало получит своё.
        module.terminate()
        throw error
      } finally {
        // Ядро уже собрано в воркере — blob-адреса больше не нужны.
        if (coreURL) URL.revokeObjectURL(coreURL)
        if (wasmURL) URL.revokeObjectURL(wasmURL)
      }
    },
  })

  if (outcome.ok) return outcome.core
  if (outcome.aborted) throw abortedError()

  // Отдельный случай: сломалось не вырезание, а САМО ЯДРО ffmpeg.
  // Это 31 МБ по сети, и на телефоне оно может не скачаться. Сообщение должно
  // отличаться от «кодек не поддержан», иначе причина снова потеряется, —
  // поэтому перечисляем причину КАЖДОГО зеркала, а не общее «не загрузилось».
  const reasons = describeCoreMirrorFailures(outcome.failures)
  if (looksLikeMemoryFailure(reasons)) throw memoryError()
  throw new TranscriptionError(
    'extract_failed',
    'Не удалось подготовить сжатие звука: ядро ffmpeg не загрузилось ни с одного зеркала. ' +
      'Оно скачивается один раз и весит около 31 МБ — проверьте соединение ' +
      'и попробуйте снова. Оригинал не тронут, идея и файл на месте.' +
      `\nПричины: ${reasons}`,
    { retriable: true },
  )
}

/** Прогресс вырезания без общей полосы: сюда его переводит сервис. */
type Reporter2 = (stageProgress: number | null, message: string) => void

/** Ядро: одно на приложение, загружается при первом вырезании. */
async function ensureAudioCore(
  report: Reporter2,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<FFmpeg> {
  if (audioCore?.loaded) return audioCore
  if (!audioCoreLoading) {
    audioCoreLoading = withTimeout(
      createAudioCore(report, signal),
      timeoutMs,
      () =>
        new TranscriptionError(
          'extract_failed',
          'Ядро ffmpeg не загрузилось за отведённое время. Оно скачивается один раз — ' +
            'проверьте соединение и попробуйте снова. Оригинал не тронут.',
          { retriable: true },
        ),
    )
  }
  try {
    audioCore = await audioCoreLoading
  } finally {
    audioCoreLoading = null
  }
  return audioCore
}

/**
 * Браузерное вырезание звука через ffmpeg.wasm.
 *
 * Крупный исходник **монтируется** в `/mnt` через `WORKERFS`, а не
 * перекладывается целиком в кучу wasm. `fetchFile` + `writeFile` читают весь
 * ролик в память страницы и копируют его в wasm; на десятках мегабайт куча
 * кончается, файл в виртуальной ФС оказывается неполным, и ffmpeg отвечает
 * `File could not be read! Code=8` (живой случай с телефона). `WORKERFS`
 * отдаёт байты демультиплексору по мере надобности, поэтому монтирование —
 * основной путь, а `writeFile` — только запасной, если монтирование
 * недоступно. Не заменяйте монтирование обратно на `writeFile`: ошибка
 * Code=8 вернётся.
 *
 * Кодируем только звук (AAC, моно, 16 кГц), читаем результат и снимаем
 * монтирование/удаляем временные файлы. Оригинал не изменяется и никуда
 * не отправляется.
 */
export async function extractAudioWithFfmpeg(
  job: AudioExtractionJob,
  deps: AudioExtractionDeps = {},
): Promise<TranscriptionAudio> {
  const settings = job.settings
  const report: Reporter2 = job.onProgress ?? (() => {})
  if (job.signal?.aborted) throw abortedError()

  const loadCore = deps.loadCore ?? ensureAudioCore
  const ffmpeg = await loadCore(report, job.signal, settings.extractTimeoutMs)
  // `fetchFile` нужен только запасному пути: на успешном пути файл читает
  // WORKERFS, и в память страницы ничего не копируется.
  const readBlob =
    deps.readBlob ??
    (async (blob: Blob): Promise<Uint8Array> => {
      const { fetchFile } = await import('@ffmpeg/util')
      return fetchFile(blob)
    })
  const inputName = inputFileNameFor(job.source)
  const outputName = settings.audioFileName
  const context: ExtractionContext = {
    sizeBytes: job.source.blob.size,
    maxUploadBytes: settings.maxUploadBytes,
  }
  let encodedSec: number | null = null
  /** Осмысленные строки лога текущей попытки: из них собирается причина. */
  let logLines: string[] = []
  /** Лог уже провалившейся попытки: причина может быть только в нём. */
  let failedLog: string[] = []
  /** Точка монтирования, если WORKERFS сработал: её обязательно снять. */
  let mountPoint: string | null = null
  /** Путь, который реально получает ffmpeg: `/mnt/<имя>` или просто имя. */
  let inputPath = inputName

  const onLog = (event: LogEvent): void => {
    for (const line of splitLogLines(event.message)) {
      const seconds = parseEncodedSeconds(line)
      if (seconds !== null) {
        encodedSec = seconds
        const total = positiveNumber(job.source.durationSec)
        report(
          total === null ? null : 0.5 + 0.5 * Math.min(1, seconds / total),
          total === null
            ? `Вырезаем звук… ${formatSeconds(seconds)}`
            : `Вырезаем звук… ${formatSeconds(seconds)} из ${formatSeconds(total)}`,
        )
      }
      // Прогресс и служебные строки в памяти не держим: причину они не
      // объясняют, а место на телефоне не бесконечное.
      if (!isMeaningfulFfmpegLine(line)) continue
      logLines.push(line)
      if (logLines.length > FFMPEG_LOG_KEEP) logLines.shift()
    }
  }

  /** Одна попытка: свой бюджет времени и своя отмена. */
  const run = (args: string[]): Promise<number> =>
    withTimeout(
      ffmpeg.exec(args, -1, { signal: job.signal }),
      settings.extractTimeoutMs,
      () =>
        new TranscriptionError(
          'extract_failed',
          'Вырезание звука не уложилось в отведённое время. Попробуйте запись покороче — ' +
            'оригинал не тронут.',
          { retriable: true },
        ),
    )

  ffmpeg.on('log', onLog)
  try {
    report(0.5, 'Готовим файл для вырезания звука…')
    // WORKERFS требует `File` с именем: по нему строится путь в точке
    // монтирования. Имя берём из `inputFileNameFor` — с настоящим расширением,
    // иначе демультиплексор ffmpeg не поймёт контейнер.
    const canMount =
      typeof ffmpeg.mount === 'function' &&
      typeof ffmpeg.unmount === 'function' &&
      typeof File === 'function'
    let plan = planAudioInput(inputName, canMount)
    if (plan.mode === 'mount') {
      try {
        await ensureMountPoint(ffmpeg, plan.mountPoint)
        const file = asMountedFile(job.source.blob, plan.fileName)
        const mounted = await ffmpeg.mount(
          // Константа — строка, а API ждёт enum: значение то же самое.
          WORKER_FS_TYPE as FFFSType,
          { files: [file] },
          plan.mountPoint,
        )
        // Ядро без WORKERFS отвечает `false`, а не исключением.
        if (mounted === false) throw new Error('WORKERFS is not available')
        mountPoint = plan.mountPoint
        inputPath = plan.inputPath
      } catch {
        // Монтирование не удалось — не ломаем то, что работало: прежний
        // `writeFile`. Он дороже по памяти, но для небольших файлов годится,
        // а на крупных ниже сработает понятное сообщение про размер.
        report(0.5, 'Не удалось смонтировать файл — копируем его в память…')
        plan = planAudioInput(inputName, false)
      }
    }
    if (mountPoint === null) {
      inputPath = plan.inputPath
      await ffmpeg.writeFile(inputPath, await readBlob(job.source.blob))
    }
    if (job.signal?.aborted) throw abortedError()

    let exitCode = await run(buildExtractAudioArgs(inputPath, outputName, settings))
    if (job.signal?.aborted) throw abortedError()

    if (exitCode !== 0) {
      failedLog = logLines
      // Вторая попытка — до сброса ядра: копирование дорожки не требует
      // декодирования и проходит там, где перекодирование не может.
      // Отмена и таймаут сюда не доходят (они бросают исключение), а при
      // нехватке памяти повтор бессмысленен.
      const retryCode = await retryExtractionWithCopy({
        failure: {
          aborted: job.signal?.aborted === true,
          timedOut: false,
          outOfMemory: looksLikeMemoryFailure(failedLog.join(' ')),
        },
        runCopy: () => {
          report(0.5, 'Пробуем второй способ: копируем звук без перекодирования…')
          logLines = []
          return run(buildCopyAudioArgs(inputPath, outputName))
        },
      })
      if (retryCode !== null) {
        exitCode = retryCode
        if (job.signal?.aborted) throw abortedError()
      }
      if (exitCode !== 0) {
        throw ffmpegFailureError(
          exitCode,
          logLines.length > 0 ? logLines : failedLog,
          context,
        )
      }
    }

    const data = await ffmpeg.readFile(outputName)
    if (!(data instanceof Uint8Array)) {
      throw new TranscriptionError(
        'extract_failed',
        'Не удалось прочитать вырезанный звук. Оригинал не тронут.',
        { retriable: true },
      )
    }
    return {
      blob: new Blob([bytesOf(data)], { type: settings.audioMimeType }),
      mimeType: settings.audioMimeType,
      durationSec: positiveNumber(job.source.durationSec) ?? encodedSec,
    }
  } catch (error) {
    const failure = asExtractionError(
      error,
      logLines.length > 0 ? logLines : failedLog,
      context,
    )
    // После сбоя памяти, таймаута или отмены ядро в негодном состоянии.
    if (
      failure.code === 'aborted' ||
      failure.code === 'extract_failed' ||
      failure.code === 'timeout'
    ) {
      resetAudioCore()
    }
    throw failure
  } finally {
    ffmpeg.off('log', onLog)
    // `unmount` обязателен в finally, в том числе при ошибке и отмене: иначе
    // следующая расшифровка не смонтирует /mnt заново (точка занята), и
    // крупный файл снова упадёт.
    if (mountPoint !== null) await safeUnmount(ffmpeg, mountPoint)
    await safeDelete(ffmpeg, inputPath)
    await safeDelete(ffmpeg, outputName)
  }
}

/**
 * Подмена ядра и чтения Blob — только для проверок: настоящий ffmpeg.wasm
 * в Node не запускается (нужны Worker и DOM). В бою обе подмены не заданы.
 */
export interface AudioExtractionDeps {
  /** Готовое ядро ffmpeg; по умолчанию — `ensureAudioCore`. */
  loadCore?: (
    report: Reporter2,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ) => Promise<FFmpeg>
  /** Чтение Blob для запасного `writeFile`; по умолчанию — `fetchFile`. */
  readBlob?: (blob: Blob) => Promise<Uint8Array>
}

/** Файл для WORKERFS: обязательно с именем — из него WORKERFS строит путь. */
function asMountedFile(blob: Blob, name: string): File {
  if (blob instanceof File && blob.name === name) return blob
  return new File([blob], name, { type: blob.type })
}

/** Точка монтирования должна существовать: уже созданная — не ошибка. */
async function ensureMountPoint(ffmpeg: FFmpeg, mountPoint: string): Promise<void> {
  try {
    await ffmpeg.createDir(mountPoint)
  } catch {
    // Каталог уже есть после прошлой расшифровки — монтировать можно.
  }
}

/** Снять монтирование: ошибка снятия не важнее результата вырезания. */
async function safeUnmount(ffmpeg: FFmpeg, mountPoint: string): Promise<void> {
  try {
    await ffmpeg.unmount(mountPoint)
  } catch {
    // Ядро могло быть уже уничтожено после сбоя: снимать нечего.
  }
}

/** Удаление файла из внутренней ФС: ошибка удаления не важнее задания. */
async function safeDelete(ffmpeg: FFmpeg, path: string): Promise<void> {
  try {
    await ffmpeg.deleteFile(path)
  } catch {
    // Файла могло не быть — это не повод падать.
  }
}

// --- Сервис ------------------------------------------------------------------

/** Что реально уходит провайдеру. */
interface UploadPayload {
  blob: Blob
  mimeType: string
  name: string
  durationSec: number | null
  /** Звук уже вырезан из видео: второй раз вырезать нечего. */
  extracted: boolean
}

/** Сеть и вырезание звука подменяются в тестах; в бою — значения по умолчанию. */
export interface TranscriptionServiceDeps {
  /** Подмена сети: в тестах сюда приходит своя функция. */
  fetch?: typeof fetch
  /** Подмена вырезания звука (в Node настоящий ffmpeg не запускается). */
  extractAudio?: AudioExtractor
  /**
   * Подмена чтения метаданных: в Node нет `<video>`, а проверить источник
   * длительности и его приоритет нужно без браузера.
   */
  readMetadata?: MetadataReader
}

/** Что нужно, чтобы собрать сервис. */
export interface TranscriptionServiceOptions {
  /** Правки параметров расшифровки поверх значений по умолчанию. */
  settings?: Partial<TranscriptionSettings>
  /** Подмена сети и вырезания звука. */
  deps?: TranscriptionServiceDeps
}

/**
 * Минимум того, что читаем из ответа распознавания.
 *
 * Обязательно только `text`: на `response_format: json` провайдер присылает
 * `{"text": "..."}`. Поля `duration`, `usage` и `segments` — необязательный
 * бонус: в `json` их может не быть вовсе, и это нормальный ответ, а не ошибка.
 */
interface TranscribePayload {
  text?: unknown
  duration?: unknown
  segments?: Array<{ end?: unknown }>
  usage?: { durationSeconds?: unknown }
  error?: unknown
  id?: unknown
  status?: unknown
}

/**
 * Длительность отправленного звука — для расчёта стоимости.
 *
 * Порядок: сначала то, что провайдер всё-таки прислал (`duration`, `usage`
 * или `segments`) — если измерение есть, оно точнее нашего, ведь это ровно
 * тот звук, который он обработал. Но `json` этих полей обычно не содержит,
 * поэтому **опорное** значение — наше собственное (`fallbackSec`): явно
 * переданное, прочитанное из файла или `encodedSec` вырезания. Нет ни
 * одного источника — `null`, а не 0: неизвестная длительность означает
 * неизвестную стоимость, и выдумывать ноль нельзя.
 */
function readDuration(payload: TranscribePayload, fallbackSec: number | null): number | null {
  const direct = positiveNumber(payload.duration)
  if (direct !== null) return direct
  const usage = positiveNumber(payload.usage?.durationSeconds)
  if (usage !== null) return usage
  const segments = payload.segments
  if (Array.isArray(segments) && segments.length > 0) {
    const last = positiveNumber(segments[segments.length - 1]?.end)
    if (last !== null) return last
  }
  return positiveNumber(fallbackSec)
}

/**
 * Итог одного запроса. Язык здесь ещё не решён: его определяет вызывающий
 * код по тексту, и от этого зависит, будет ли вторая попытка.
 */
interface AttemptResult {
  text: string
  /** `null` — длительность неизвестна ни нам, ни провайдеру. */
  durationSec: number | null
  /** `null` — стоимость посчитать нельзя (неизвестна длительность). */
  costRub: number | null
  /** Модель, которой сделан именно этот запрос. */
  model: string
}

type AttemptOutcome =
  | { ok: true; result: AttemptResult }
  | { ok: false; error: TranscriptionError }

/**
 * Расшифровка речи. Один экземпляр на приложение — он помнит, что ядро
 * ffmpeg уже загружено, и не скачивает его заново.
 */
export class TranscriptionService {
  readonly #config: LlmConfig
  readonly #settings: TranscriptionSettings
  readonly #fetchImpl: typeof fetch
  readonly #extractAudio: AudioExtractor
  readonly #readMetadata: MetadataReader

  constructor(config: LlmConfig, options: TranscriptionServiceOptions = {}) {
    this.#config = config
    this.#settings = resolveTranscriptionSettings(
      DEFAULT_TRANSCRIPTION_SETTINGS,
      options.settings ?? {},
    )
    const deps = options.deps ?? {}
    const fetchImpl =
      deps.fetch ??
      (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined)
    if (!fetchImpl) {
      throw new TranscriptionError(
        'unsupported',
        'В этой среде недоступен fetch: расшифровка речи невозможна.',
        { retriable: false },
      )
    }
    this.#fetchImpl = fetchImpl
    this.#extractAudio = deps.extractAudio ?? extractAudioWithFfmpeg
    this.#readMetadata = deps.readMetadata ?? readElementMetadata
  }

  /** Модель расшифровки, с которой работает сервис (из конфига, не из кода вызова). */
  get model(): string {
    return this.#config.transcribeModel
  }

  /** Запасная модель: к ней обращаемся, только если речь не на русском. */
  get fallbackModel(): string {
    return this.#config.transcribeFallbackModel
  }

  /** Параметры расшифровки: лимит, язык, таймауты. */
  get settings(): TranscriptionSettings {
    return this.#settings
  }

  /** Есть ли ключ: если нет — запрос не уходит и ошибка понятная. */
  hasKey(): boolean {
    return hasApiKey(this.#config)
  }

  /** Расшифровать звук. Ничего не пишет и не удаляет: только возвращает текст. */
  async transcribe(job: TranscriptionJob): Promise<TranscriptionOutcome> {
    const source = job.source
    const report = createReporter(job.onProgress)
    report('check', 0, 'Проверяем файл…')

    // Проверки до сети: нет ключа, отмена. Запросов — ноль.
    const preflight = this.#preflight(job)
    if (preflight) return { ok: false, error: preflight }

    const size = source.blob?.size ?? 0
    if (!source.blob || size <= 0) {
      return {
        ok: false,
        error: new TranscriptionError('invalid_file', 'Файл пустой — расшифровывать нечего.'),
      }
    }

    let payload = uploadOf(source)
    // Вызывающий код длительность не передал — читаем её из самого файла.
    // Это обязательный шаг, а не «оптимизация»: файл меньше лимита уходит
    // провайдеру напрямую, без вырезания, и `encodedSec` взять неоткуда.
    // Без чтения из файла стоимость такого запроса молча становилась нулевой,
    // хотя деньги за него уже списаны. Чтение ограничено таймаутом и при
    // провале не мешает расшифровке — просто идём к следующему источнику.
    if (payload.durationSec === null) {
      const fromFile = await this.#durationFromFile(source.blob, report)
      // Отмена во время чтения метаданных — всё равно отмена.
      if (job.signal?.aborted) return { ok: false, error: abortedError() }
      if (fromFile !== null) payload = { ...payload, durationSec: fromFile }
    }
    // Файл больше лимита — сначала вырезаем звук, и только его отправляем.
    if (shouldExtractAudio(payload.blob.size, this.#settings)) {
      const extracted = await this.#extract(payload, job, report)
      if (!extracted.ok) return { ok: false, error: extracted.error }
      payload = extracted.payload
      const tooBig = this.#ensureFits(payload)
      if (tooBig) return { ok: false, error: tooBig }
    }

    const primary = await this.#sendWithFileRetry(payload, job, report)
    if (primary.ok) {
      return this.#withLanguageFallback(primary.outcome, primary.payload, job, report)
    }

    // Основная модель не ответила по временной причине? Рядом есть запасная,
    // и молча сдаваться незачем: человек нажал «Расшифровать», а не «узнать,
    // что у провайдера упал провайдер русской модели».
    return this.#withProviderFallback(primary.error, primary.payload, job, report)
  }

  /**
   * Длительность из файла — только когда её не передал вызывающий код.
   *
   * Метаданные видео надёжнее `encodedSec` вырезания: вырезание может не
   * дойти до конца файла, и тогда оно даст меньше секунд, чем в записи есть.
   * Поэтому чтение из файла стоит выше, а таймаут и `null` при любом сбое
   * оставляют расшифровку живой.
   */
  async #durationFromFile(blob: Blob, report: Reporter): Promise<number | null> {
    const timeoutMs = this.#settings.metadataTimeoutMs
    report('check', null, 'Определяем длительность записи…')
    try {
      const info = await settledWithin(this.#readMetadata(blob, timeoutMs), timeoutMs)
      return positiveNumber(info?.durationSec)
    } catch {
      // Незнакомый кодек, битый файл, нет DOM — не беда: цена будет честной.
      return null
    }
  }

  /**
   * Основная расшифровка: запрос и — если сервис отказал из-за размера или
   * формата (например, mp4 в списке форматов не значится) — одна попытка
   * с вырезанным звуком. Обе идут основной моделью.
   */
  async #sendWithFileRetry(
    payload: UploadPayload,
    job: TranscriptionJob,
    report: Reporter,
  ): Promise<
    | { ok: true; outcome: AttemptResult; payload: UploadPayload }
    | { ok: false; error: TranscriptionError; payload: UploadPayload }
  > {
    const first = await this.#send(
      payload,
      report,
      job.signal,
      this.#config.transcribeModel,
      this.#config.transcribePricing,
    )
    if (first.ok) return { ok: true, outcome: first.result, payload }

    if (!payload.extracted && isFileRejection(first.error)) {
      const extracted = await this.#extract(payload, job, report)
      if (!extracted.ok) return { ok: false, error: extracted.error, payload }
      const tooBig = this.#ensureFits(extracted.payload)
      if (tooBig) return { ok: false, error: tooBig, payload }
      const second = await this.#send(
        extracted.payload,
        report,
        job.signal,
        this.#config.transcribeModel,
        this.#config.transcribePricing,
      )
      if (second.ok) return { ok: true, outcome: second.result, payload: extracted.payload }
      // Запасной модели тоже достанется тот файл, который реально ушёл,
      // а не исходный: иначе после вырезания звука она снова получила бы
      // слишком большой файл.
      return { ok: false, error: this.#secondFailure(second.error), payload: extracted.payload }
    }

    return { ok: false, error: first.error, payload }
  }

  /**
   * Спасение запасной моделью после временного сбоя основной.
   *
   * Порядок и деньги: неудачный запрос провайдер не тарифицирует, поэтому
   * в `costRub` попадает только удачная попытка. Если не ответила и запасная,
   * наружу уходит ошибка с причинами **обеих** моделей — человек должен
   * видеть, что дело не в его файле и что повторить стоит.
   *
   * Постоянные отказы (ключ, деньги, размер, неизвестная модель, отмена)
   * сюда не доходят: `canTryFallbackModel` их отсекает, и лишнего запроса нет.
   */
  async #withProviderFallback(
    primary: TranscriptionError,
    payload: UploadPayload,
    job: TranscriptionJob,
    report: Reporter,
  ): Promise<TranscriptionOutcome> {
    const fallbackModel = this.#config.transcribeFallbackModel
    if (!canTryFallbackModel(primary, this.#config.transcribeModel, fallbackModel)) {
      return { ok: false, error: primary }
    }
    // Отмена важнее любой попытки: человек уже закрыл карточку.
    if (job.signal?.aborted) return { ok: false, error: abortedError() }

    report('upload', null, 'Основная модель не ответила — пробуем запасную…')
    const fallback = await this.#send(
      payload,
      report,
      job.signal,
      fallbackModel,
      this.#config.transcribeFallbackPricing,
    )
    if (fallback.ok) {
      const language = detectTranscriptionLanguage(fallback.result.text)
      report('finish', 1, 'Расшифровка готова')
      return {
        ok: true,
        result: {
          text: fallback.result.text,
          durationSec: fallback.result.durationSec,
          // За неудачную попытку не списано — показываем только то, что
          // действительно заплатили, иначе цифры разойдутся с балансом.
          costRub: fallback.result.costRub,
          model: fallbackModel,
          language,
          usedFallback: true,
          fallbackReason: 'provider',
          note:
            `Основная модель не ответила: ${humanFailureReason(primary)}. ` +
            'Текст распознала запасная модель — списано только за удачную попытку.',
        },
      }
    }

    // «Речи нет» — это ответ запасной модели, а не её сбой: повторять нечего,
    // и человек должен увидеть обычное спокойное «в записи нет речи».
    if (fallback.error.code === 'no_speech') return { ok: false, error: fallback.error }
    if (fallback.error.code === 'aborted') return { ok: false, error: fallback.error }

    return { ok: false, error: this.#bothModelsFailed(primary, fallback.error) }
  }

  /**
   * Ошибка «не ответила ни одна модель». Код, статус и признак повтора берём
   * у основной попытки: именно её сбой был временным, и повторять имеет смысл.
   */
  #bothModelsFailed(primary: TranscriptionError, fallback: TranscriptionError): TranscriptionError {
    return new TranscriptionError(
      primary.code,
      describeModelFailures(
        { model: this.#config.transcribeModel, error: primary },
        { model: this.#config.transcribeFallbackModel, error: fallback },
      ),
      {
        status: primary.status,
        retriable: primary.retriable,
        detail: primary.detail,
        cause: fallback.cause ?? primary.cause,
      },
    )
  }

  /**
   * Решение о языке — по тексту, который уже получен.
   *
   * Порядок именно такой, а не «сначала определить язык»: чтобы узнать язык,
   * текст всё равно нужен. Русская речь — основной случай, и для неё лишнего
   * запроса не делается вовсе; вторая попытка оплачивается только там, где
   * основная модель выдала почти одну латиницу (GigaAM на английском пишет
   * латиницей — по этому и видно, что речь не русская).
   *
   * Вторая попытка не делается, если модели совпали (так настроил человек)
   * и если текст пустой: пустой текст — это отсутствие речи, а не язык,
   * и решается он раньше, ошибкой `no_speech`.
   */
  async #withLanguageFallback(
    primary: AttemptResult,
    payload: UploadPayload,
    job: TranscriptionJob,
    report: Reporter,
  ): Promise<TranscriptionOutcome> {
    const language = detectTranscriptionLanguage(primary.text)
    const fallbackModel = this.#config.transcribeFallbackModel
    if (language !== 'other' || fallbackModel === this.#config.transcribeModel) {
      report('finish', 1, 'Расшифровка готова')
      return { ok: true, result: this.#resultOf(primary, language, false) }
    }

    report('upload', null, 'Речь не на русском — пробуем общую модель…')
    const fallback = await this.#send(
      payload,
      report,
      job.signal,
      fallbackModel,
      this.#config.transcribeFallbackPricing,
    )
    if (!fallback.ok) {
      // Запасная модель не ответила — но текст основной у нас уже есть,
      // и за него уже заплачено. Возвращаем его: пусть хуже, чем ждали,
      // однако человек не остаётся с ошибкой и без денег. Причина отказа
      // идёт примечанием, а не пропадает.
      report('finish', 1, 'Расшифровка готова')
      return {
        ok: true,
        result: {
          ...this.#resultOf(primary, language, false),
          note:
            `Речь не на русском, а общая модель не ответила (${fallback.error.message}). ` +
            'Показан текст русской модели — он может быть с ошибками. ' +
            (primary.costRub === null
              ? 'Файл и идея не тронуты, стоимость расшифровки неизвестна.'
              : `Файл и идея не тронуты, за расшифровку списано ${primary.costRub.toFixed(4)} ₽.`),
        },
      }
    }

    report('finish', 1, 'Расшифровка готова')
    return {
      ok: true,
      result: {
        text: fallback.result.text,
        durationSec: fallback.result.durationSec,
        // Платим за обе попытки — значит, и показываем сумму обеих:
        // человек должен видеть настоящую цену, а не половину. Если хотя бы
        // одна сумма неизвестна, неизвестна и общая: складывать с нулём
        // значило бы выдать догадку за факт.
        costRub:
          primary.costRub === null || fallback.result.costRub === null
            ? null
            : primary.costRub + fallback.result.costRub,
        model: fallbackModel,
        language: 'other',
        usedFallback: true,
        fallbackReason: 'language',
        note: null,
      },
    }
  }

  /** Собирает наружный результат из попытки: язык и признак повтора — снаружи. */
  #resultOf(
    attempt: AttemptResult,
    language: TranscriptionResult['language'],
    usedFallback: boolean,
    fallbackReason: TranscriptionResult['fallbackReason'] = null,
  ): TranscriptionResult {
    return {
      text: attempt.text,
      durationSec: attempt.durationSec,
      costRub: attempt.costRub,
      model: attempt.model,
      language,
      usedFallback,
      fallbackReason,
      note: null,
    }
  }

  /** Проверки, при которых запрос в сеть не уходит вообще. */
  #preflight(job: TranscriptionJob): TranscriptionError | null {
    if (!hasApiKey(this.#config)) {
      return new TranscriptionError(
        'no_key',
        'Не задан ключ API. Добавьте его в настройках — запрос на расшифровку не отправлен, ' +
          'файл и идея на месте.',
        { retriable: false },
      )
    }
    if (job.signal?.aborted) return abortedError()
    return null
  }

  /** Влезает ли то, что мы собираемся отправить. */
  #ensureFits(payload: UploadPayload): TranscriptionError | null {
    if (payload.blob.size <= this.#settings.maxUploadBytes) return null
    return new TranscriptionError(
      'too_large',
      `Даже звук из этого файла весит ${formatBytes(payload.blob.size)} — больше лимита отправки ` +
        `(${formatBytes(this.#settings.maxUploadBytes)}). Разделите запись на части: ` +
        'оригинал не тронут.',
      { retriable: false },
    )
  }

  /** Уточняем отказ после второй попытки: «не влез даже звук» — это не 5xx. */
  #secondFailure(error: TranscriptionError): TranscriptionError {
    if (error.status === 413 || error.code === 'too_large') {
      return new TranscriptionError(
        'too_large',
        `Сервис распознавания не принял даже звук (413): запись длиннее, чем ` +
          `${formatBytes(this.#settings.maxUploadBytes)} звука. Разделите её на части — оригинал не тронут.`,
        { status: 413, retriable: false },
      )
    }
    return error
  }

  /** Вырезание звука: наружу — только понятная ошибка. */
  async #extract(
    payload: UploadPayload,
    job: TranscriptionJob,
    report: Reporter,
  ): Promise<{ ok: true; payload: UploadPayload } | { ok: false; error: TranscriptionError }> {
    report(
      'extract',
      0,
      `Файл ${formatBytes(payload.blob.size)} — больше лимита отправки ` +
        `(${formatBytes(this.#settings.maxUploadBytes)}). Вырезаем звук…`,
    )
    try {
      const audio = await this.#extractAudio({
        source: {
          blob: payload.blob,
          mimeType: payload.mimeType,
          name: payload.name,
          durationSec: payload.durationSec,
        },
        settings: this.#settings,
        onProgress: (stageProgress, message) => report('extract', stageProgress, message),
        signal: job.signal,
      })
      if (job.signal?.aborted) return { ok: false, error: abortedError() }
      if (!audio.blob || audio.blob.size <= 0) {
        return {
          ok: false,
          error: new TranscriptionError(
            'extract_failed',
            'После вырезания звука не осталось байтов: возможно, в файле нет звуковой дорожки. ' +
              'Оригинал не тронут.',
            { retriable: false },
          ),
        }
      }
      return {
        ok: true,
        payload: {
          blob: audio.blob,
          mimeType: audio.mimeType,
          name: this.#settings.audioFileName,
          // Порядок источников длительности: уже известная (явная или из
          // файла) сильнее `encodedSec` вырезания — вырезание может не дойти
          // до конца записи и занизить стоимость.
          durationSec: payload.durationSec ?? positiveNumber(audio.durationSec),
          extracted: true,
        },
      }
    } catch (error) {
      return {
        ok: false,
        error: asExtractionError(error, [], {
          sizeBytes: payload.blob.size,
          maxUploadBytes: this.#settings.maxUploadBytes,
        }),
      }
    }
  }

  /**
   * Один сетевой запрос: multipart, ключ, таймаут, отмена, разбор ответа.
   *
   * Модель и тариф — параметры, а не поля конфига: запасная попытка идёт
   * другой моделью и по другому тарифу, и цена считается по каждой отдельно.
   */
  async #send(
    payload: UploadPayload,
    report: Reporter,
    signal: AbortSignal | undefined,
    model: string,
    pricing: TranscriptionPricing,
  ): Promise<AttemptOutcome> {
    if (signal?.aborted) return { ok: false, error: abortedError() }

    const timeoutMs = this.#settings.requestTimeoutMs
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    const onExternalAbort = (): void => controller.abort()
    if (signal) signal.addEventListener('abort', onExternalAbort)

    let response: Response
    let body = ''
    try {
      const form = new FormData()
      form.set('file', payload.blob, payload.name)
      form.set('model', model)
      form.set('language', this.#settings.language)
      // Всегда `json`, и это осознанно: `verbose_json` принимает не каждая
      // модель — Whisper Large V3 отвечает на него 400 «формат не
      // поддерживается», и запасная модель падает всегда. Длительность для
      // стоимости у нас своя (метаданные видео или вырезание звука), поэтому
      // «богатый» формат не нужен. Не возвращать: это ломает запасную модель.
      form.set('response_format', this.#settings.responseFormat)

      report('upload', null, `Отправляем ${formatBytes(payload.blob.size)} на расшифровку…`)
      const pending = this.#fetchImpl(`${this.#config.baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: {
          // Content-Type не ставим: boundary для multipart подставляет браузер.
          Authorization: `Bearer ${this.#config.apiKey}`,
          Accept: 'application/json',
        },
        body: form,
        signal: controller.signal,
      })
      report('wait', null, 'Ждём ответ сервиса распознавания…')
      response = await pending
      body = await response.text()
    } catch (cause) {
      if (timedOut) {
        return {
          ok: false,
          error: new TranscriptionError(
            'timeout',
            `Сервис распознавания не ответил за ${Math.round(timeoutMs / 1000)} с. ` +
              'Файл не потерян — попробуйте позже или возьмите запись покороче.',
            { retriable: true, cause },
          ),
        }
      }
      if (signal?.aborted) return { ok: false, error: abortedError() }
      return {
        ok: false,
        error: new TranscriptionError(
          'network',
          'Нет связи с сервисом распознавания. Проверьте интернет — файл и идея на месте.',
          { retriable: true, cause },
        ),
      }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onExternalAbort)
    }

    if (!response.ok) return { ok: false, error: httpError(response.status, body) }

    const trimmed = body.trim()
    if (trimmed === '') {
      return {
        ok: false,
        error: new TranscriptionError(
          'empty_response',
          'Сервис распознавания вернул пустой ответ. Файл не потерян — попробуйте ещё раз.',
          { retriable: true },
        ),
      }
    }

    let data: TranscribePayload
    try {
      data = JSON.parse(trimmed) as TranscribePayload
    } catch (cause) {
      return {
        ok: false,
        error: new TranscriptionError(
          'invalid_json',
          'Ответ сервиса распознавания не является JSON. Файл не потерян — попробуйте ещё раз.',
          { retriable: true, cause },
        ),
      }
    }

    if (data?.error) {
      return {
        ok: false,
        error: new TranscriptionError(
          'http',
          `Сервис распознавания вернул ошибку: ${
            sanitizeProviderHint(errorMessageOf(data.error)) || 'без пояснений'
          }`,
          { retriable: false },
        ),
      }
    }

    const text = typeof data?.text === 'string' ? data.text.trim() : ''
    if (text === '') {
      // Асинхронные модели (aiesa/*) вместо текста присылают задачу: это
      // не «тишина в записи», и объяснять надо иначе.
      if (typeof data?.status === 'string' || typeof data?.id === 'string') {
        return {
          ok: false,
          error: new TranscriptionError(
            'unsupported',
            'Провайдер вернул задачу вместо текста: выбранная модель распознаёт речь ' +
              'асинхронно, и такой режим пока не поддержан. Файл и идея на месте.',
            { retriable: false },
          ),
        }
      }
      // Речи в записи нет — это обычный случай (ролик без слов), а не
      // поломка: отдельный код, чтобы интерфейс показал его спокойно.
      // Второй попытки здесь тоже нет: дело не в языке, а в отсутствии речи.
      return {
        ok: false,
        error: new TranscriptionError(
          'no_speech',
          'В записи нет речи — распознавать нечего. Для роликов без слов это обычное дело: ' +
            'файл и идея на месте.',
          { retriable: false },
        ),
      }
    }

    const durationSec = readDuration(data, payload.durationSec)
    return {
      ok: true,
      result: {
        text,
        durationSec,
        // Нет длительности — нет и суммы: `null` честнее нуля, который
        // выглядел бы как «бесплатно», хотя запрос уже оплачен.
        costRub: durationSec === null ? null : costOfTranscription(durationSec, pricing),
        model,
      },
    }
  }
}

/** Что отправляем: файл как есть, имя — по типу или из исходника. */
function uploadOf(source: TranscriptionSource): UploadPayload {
  const name =
    typeof source.name === 'string' && source.name.trim() !== ''
      ? source.name.trim()
      : inputFileNameFor(source)
  return {
    blob: source.blob,
    mimeType: source.mimeType ?? source.blob?.type ?? '',
    name,
    durationSec: positiveNumber(source.durationSec),
    extracted: false,
  }
}

/** Прогресс 0..1 по всему заданию; полоса не идёт назад. */
function createReporter(onProgress?: (event: TranscriptionProgress) => void): Reporter {
  let last = 0
  return (stage, stageProgress, message) => {
    if (!onProgress) return
    const [start, end] = STAGE_RANGES[stage]
    const within = stageProgress === null ? 0 : Math.min(Math.max(stageProgress, 0), 1)
    const progress = Math.min(1, Math.max(last, start + (end - start) * within))
    last = progress
    try {
      onProgress({ progress, stage, stageProgress, message })
    } catch {
      // Чужой колбэк не должен ломать расшифровку: прогресс — это украшение,
      // а исходный файл и результат важнее.
    }
  }
}

/** Что нужно, чтобы собрать сервис: хранилище настроек и необязательные правки. */
export interface CreateTranscriptionServiceOptions {
  /** Хранилище `meta` из IndexedDB (слой данных пишет другой агент). */
  store?: MetaStore
  /** Явные переопределения конфига — сильнее значений из хранилища. */
  config?: Partial<LlmConfig>
  /** Правки параметров расшифровки. */
  settings?: Partial<TranscriptionSettings>
  /** Подмена сети и вырезания звука (в основном для тестов). */
  deps?: TranscriptionServiceDeps
}

/**
 * Собирает сервис: читает ключ, адрес, модель и цену из `meta`.
 * Ключ в коде не хранится — только в `meta` или в явном параметре.
 */
export async function createTranscriptionService(
  options: CreateTranscriptionServiceOptions = {},
): Promise<TranscriptionService> {
  const config = await loadLlmConfig(options.store, options.config ?? {})
  return new TranscriptionService(config, { settings: options.settings, deps: options.deps })
}
