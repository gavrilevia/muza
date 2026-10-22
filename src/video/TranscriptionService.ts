/**
 * TranscriptionService — расшифровка речи из видео и голосовых заметок.
 *
 * ## Что здесь есть
 *
 * - запрос к OpenAI-совместимому эндпоинту `POST /audio/transcriptions`
 *   (`multipart/form-data`): `file`, `model`, `language`, `response_format`;
 * - ключ и адрес берутся из `meta` так же, как в `LlmClient`; в коде ключа нет;
 * - прогресс наружу: отправка и ожидание ответа — разные этапы (ВИДЕО.md, 5);
 * - таймаут и отмена через `AbortSignal`: закрыл карточку — работа встала;
 * - большие файлы: если файл больше лимита отправки, звук вырезается
 *   ffmpeg.wasm и уходит только он. Если сервис всё равно ответил 413 —
 *   вырезаем звук и пробуем ещё раз;
 * - понятные ошибки по-русски: нет ключа (сеть не трогаем вообще), нет сети,
 *   таймаут, 401/403, 402, 413, 429, 5xx, пустой ответ, битый JSON.
 *
 * ## Чего здесь нет
 *
 * - базы и интерфейса: сервис только читает `blob` и возвращает текст;
 *   запись транскрипта в `transcript` — решение вызывающего кода;
 * - автоматического вызова модели: расшифровка запускается только по кнопке
 *   (СХЕМА-ДАННЫХ.md: «Транскрипт, кадры и OCR появляются позже, по кнопке»);
 * - повторов: повторная отправка — это снова мегабайты и снова деньги,
 *   поэтому решение о повторе принимает вызывающий код по флагу `retriable`.
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
} from '../ai/config'
import { VIDEO_CORE_BASE_URL, VIDEO_CORE_SCRIPT, VIDEO_CORE_WASM } from './config'
import { formatBytes, formatSeconds, inputFileNameFor, parseEncodedSeconds, splitLogLines } from './logic'
import {
  DEFAULT_TRANSCRIPTION_SETTINGS,
  buildExtractAudioArgs,
  resolveTranscriptionSettings,
  shouldExtractAudio,
  type TranscriptionSettings,
} from './transcriptionConfig'
import {
  TranscriptionError,
  type TranscriptionAudio,
  type TranscriptionJob,
  type TranscriptionOutcome,
  type TranscriptionProgress,
  type TranscriptionSource,
  type TranscriptionStage,
} from './transcriptionTypes'
import type { FFmpeg, LogEvent } from '@ffmpeg/ffmpeg'

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

/** Понятный хвост тела ответа об ошибке. */
function describeBody(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: unknown }
    const message = errorMessageOf(parsed?.error)
    if (message !== '') return shortText(message)
  } catch {
    // Не JSON — покажем хвост как есть: так хотя бы видно, что ответил сервис.
  }
  return shortText(body)
}

/** Ошибка от провайдера: понятный текст и решение «повторять или нет». */
function httpError(status: number, body: string): TranscriptionError {
  const tail = describeBody(body)
  if (status === 401 || status === 403) {
    return new TranscriptionError(
      'auth',
      `Ключ API отклонён сервисом распознавания (${status}). Проверьте ключ в настройках — файл и идея на месте.`,
      { status, retriable: false },
    )
  }
  if (status === 402) {
    return new TranscriptionError(
      'budget',
      `На счёте провайдера не хватает средств (402). Расшифровка не выполнена, файл не потерян.`,
      { status, retriable: false },
    )
  }
  if (status === 413) {
    return new TranscriptionError(
      'too_large',
      `Сервис распознавания не принял файл: он больше допустимого размера (413). ${
        tail || 'Попробуем вырезать звук.'
      }`,
      { status, retriable: false },
    )
  }
  if (status === 408) {
    return new TranscriptionError(
      'timeout',
      'Сервис распознавания не успел ответить (408). Файл не потерян — попробуйте позже.',
      { status, retriable: true },
    )
  }
  if (status === 429) {
    return new TranscriptionError(
      'rate_limit',
      'Слишком много запросов к распознаванию (429). Подождите немного и попробуйте снова — файл не потерян.',
      { status, retriable: true },
    )
  }
  if (status >= 500) {
    return new TranscriptionError(
      'server',
      `Сервис распознавания недоступен (${status}). Файл не потерян — попробуйте позже. ${tail}`,
      { status, retriable: true },
    )
  }
  if (status === 415) {
    return new TranscriptionError(
      'http',
      `Сервис распознавания не принимает такой формат (415). ${tail || 'Нужен звук в mp3, m4a, wav, ogg или webm.'}`,
      { status, retriable: false },
    )
  }
  return new TranscriptionError(
    'http',
    `Распознавание отклонено (${status}): ${tail || 'без пояснений'}`,
    { status, retriable: false },
  )
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

/** Любое исключение превращаем в понятную ошибку вырезания звука. */
function asExtractionError(error: unknown): TranscriptionError {
  if (error instanceof TranscriptionError) return error
  const message = error instanceof Error ? error.message : String(error)
  if (/AbortError|aborted|was aborted/i.test(message)) return abortedError()
  if (/out of memory|OOM|Cannot enlarge memory|allocation failed|memory access/i.test(message)) {
    return new TranscriptionError(
      'extract_failed',
      'Браузеру не хватило памяти, чтобы вырезать звук. Закройте лишние вкладки и попробуйте ещё раз — оригинал не тронут.',
      { retriable: true, cause: error },
    )
  }
  return new TranscriptionError(
    'extract_failed',
    'Не удалось вырезать звук из файла (ffmpeg). Оригинал не тронут: попробуйте ещё раз или отправьте голосовую заметку.',
    { retriable: true, cause: error },
  )
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

/** Что приходит в колбэк скачивания `toBlobURL` (тип из `@ffmpeg/util` не экспортируется). */
interface DownloadProgressEvent {
  total: number
  received: number
}

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

/** Скачивает однопоточное ядро и создаёт воркер (только при первом вырезании). */
async function createAudioCore(report: Reporter2, signal?: AbortSignal): Promise<FFmpeg> {
  const { FFmpeg: FFmpegClass } = await import('@ffmpeg/ffmpeg')
  const { toBlobURL } = await import('@ffmpeg/util')
  const module = new FFmpegClass()
  let coreURL: string | null = null
  let wasmURL: string | null = null
  const download =
    (from: number, to: number) =>
    (event: DownloadProgressEvent): void => {
      const ratio = event.total > 0 ? Math.min(1, event.received / event.total) : null
      report(
        ratio === null ? null : from + (to - from) * ratio,
        `Готовим ffmpeg… ${formatBytes(event.received)}`,
      )
    }
  try {
    coreURL = await toBlobURL(
      `${VIDEO_CORE_BASE_URL}/${VIDEO_CORE_SCRIPT}`,
      'text/javascript',
      true,
      download(0, 0.5),
    )
    wasmURL = await toBlobURL(
      `${VIDEO_CORE_BASE_URL}/${VIDEO_CORE_WASM}`,
      'application/wasm',
      true,
      download(0.5, 1),
    )
    await module.load({ coreURL, wasmURL }, { signal })
    return module
  } catch (error) {
    module.terminate()
    throw asExtractionError(error)
  } finally {
    // Ядро уже собрано в воркере — blob-адреса больше не нужны.
    if (coreURL) URL.revokeObjectURL(coreURL)
    if (wasmURL) URL.revokeObjectURL(wasmURL)
  }
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
 * Пишем копию во внутреннюю файловую систему, кодируем только звук (AAC,
 * моно, 16 кГц), читаем результат и удаляем временные файлы. Оригинал
 * не изменяется и никуда не отправляется.
 */
async function extractAudioWithFfmpeg(job: AudioExtractionJob): Promise<TranscriptionAudio> {
  const settings = job.settings
  const report: Reporter2 = job.onProgress ?? (() => {})
  if (job.signal?.aborted) throw abortedError()

  const ffmpeg = await ensureAudioCore(report, job.signal, settings.extractTimeoutMs)
  const { fetchFile } = await import('@ffmpeg/util')
  const inputName = inputFileNameFor(job.source)
  const outputName = settings.audioFileName
  let encodedSec: number | null = null

  const onLog = (event: LogEvent): void => {
    for (const line of splitLogLines(event.message)) {
      const seconds = parseEncodedSeconds(line)
      if (seconds === null) continue
      encodedSec = seconds
      const total = positiveNumber(job.source.durationSec)
      report(
        total === null ? null : 0.5 + 0.5 * Math.min(1, seconds / total),
        total === null
          ? `Вырезаем звук… ${formatSeconds(seconds)}`
          : `Вырезаем звук… ${formatSeconds(seconds)} из ${formatSeconds(total)}`,
      )
    }
  }

  ffmpeg.on('log', onLog)
  try {
    report(0.5, 'Готовим файл для вырезания звука…')
    await ffmpeg.writeFile(inputName, await fetchFile(job.source.blob))
    if (job.signal?.aborted) throw abortedError()

    const exitCode = await withTimeout(
      ffmpeg.exec(buildExtractAudioArgs(inputName, outputName, settings), -1, {
        signal: job.signal,
      }),
      settings.extractTimeoutMs,
      () =>
        new TranscriptionError(
          'extract_failed',
          'Вырезание звука не уложилось в отведённое время. Попробуйте запись покороче — ' +
            'оригинал не тронут.',
          { retriable: true },
        ),
    )
    if (job.signal?.aborted) throw abortedError()
    if (exitCode !== 0) {
      throw new TranscriptionError(
        'extract_failed',
        `ffmpeg не смог вырезать звук (код ${exitCode}). Оригинал не тронут.`,
        { retriable: true },
      )
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
    const failure = asExtractionError(error)
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
    await safeDelete(ffmpeg, inputName)
    await safeDelete(ffmpeg, outputName)
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
}

/** Что нужно, чтобы собрать сервис. */
export interface TranscriptionServiceOptions {
  /** Правки параметров расшифровки поверх значений по умолчанию. */
  settings?: Partial<TranscriptionSettings>
  /** Подмена сети и вырезания звука. */
  deps?: TranscriptionServiceDeps
}

/** Минимум того, что мы читаем из ответа распознавания. */
interface TranscribePayload {
  text?: unknown
  duration?: unknown
  segments?: Array<{ end?: unknown }>
  usage?: { durationSeconds?: unknown }
  error?: unknown
  id?: unknown
  status?: unknown
}

/** Длительность: ответ провайдера, затем оценка вызывающего кода, затем 0. */
function readDuration(payload: TranscribePayload, fallbackSec: number | null): number {
  const direct = positiveNumber(payload.duration)
  if (direct !== null) return direct
  const usage = positiveNumber(payload.usage?.durationSeconds)
  if (usage !== null) return usage
  const segments = payload.segments
  if (Array.isArray(segments) && segments.length > 0) {
    const last = positiveNumber(segments[segments.length - 1]?.end)
    if (last !== null) return last
  }
  return positiveNumber(fallbackSec) ?? 0
}

/**
 * Расшифровка речи. Один экземпляр на приложение — он помнит, что ядро
 * ffmpeg уже загружено, и не скачивает его заново.
 */
export class TranscriptionService {
  readonly #config: LlmConfig
  readonly #settings: TranscriptionSettings
  readonly #fetchImpl: typeof fetch
  readonly #extractAudio: AudioExtractor

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
  }

  /** Модель расшифровки, с которой работает сервис (из конфига, не из кода вызова). */
  get model(): string {
    return this.#config.transcribeModel
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
    // Файл больше лимита — сначала вырезаем звук, и только его отправляем.
    if (shouldExtractAudio(payload.blob.size, this.#settings)) {
      const extracted = await this.#extract(payload, job, report)
      if (!extracted.ok) return { ok: false, error: extracted.error }
      payload = extracted.payload
      const tooBig = this.#ensureFits(payload)
      if (tooBig) return { ok: false, error: tooBig }
    }

    const first = await this.#send(payload, report, job.signal)
    if (first.ok) return first

    // Сервис мог отказать из-за размера или формата (например, mp4 в списке
    // форматов не значится). Один раз пробуем звук: вырезать и отправить снова.
    if (!payload.extracted && isFileRejection(first.error)) {
      const extracted = await this.#extract(payload, job, report)
      if (!extracted.ok) return { ok: false, error: extracted.error }
      const tooBig = this.#ensureFits(extracted.payload)
      if (tooBig) return { ok: false, error: tooBig }
      const second = await this.#send(extracted.payload, report, job.signal)
      if (second.ok) return second
      return { ok: false, error: this.#secondFailure(second.error) }
    }

    return first
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
          durationSec: positiveNumber(audio.durationSec) ?? payload.durationSec,
          extracted: true,
        },
      }
    } catch (error) {
      return { ok: false, error: asExtractionError(error) }
    }
  }

  /** Один сетевой запрос: multipart, ключ, таймаут, отмена, разбор ответа. */
  async #send(
    payload: UploadPayload,
    report: Reporter,
    signal?: AbortSignal,
  ): Promise<TranscriptionOutcome> {
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
      form.set('model', this.#config.transcribeModel)
      form.set('language', this.#settings.language)
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
          `Сервис распознавания вернул ошибку: ${errorMessageOf(data.error) || 'без пояснений'}`,
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
              'асинхронно, и такой режим пока не поддержан. Выберите модель Whisper.',
            { retriable: false },
          ),
        }
      }
      return {
        ok: false,
        error: new TranscriptionError(
          'empty_response',
          'Сервис распознавания не нашёл речи: текст пустой. Если в записи есть голос, ' +
            'попробуйте ещё раз — файл не потерян.',
          { retriable: false },
        ),
      }
    }

    const durationSec = readDuration(data, payload.durationSec)
    report('finish', 1, 'Расшифровка готова')
    return {
      ok: true,
      result: {
        text,
        durationSec,
        costRub: costOfTranscription(durationSec, this.#config.transcribePricing),
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
