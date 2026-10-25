/**
 * VideoCompressor — интерфейс сжатия видео и браузерная реализация.
 *
 * ## Интерфейс, а не монолит
 *
 * `VideoCompressor` описывает только то, что нужно вызывающему коду: осмотреть
 * файл, решить «надо ли», сжать, вернуть НОВЫЕ байты. Про ffmpeg здесь не
 * знает никто, кроме одной реализации: серверная (прокси всё равно понадобится
 * для расшифровки речи) встанет рядом без правок вызывающего кода — как
 * `OcrService` из РЕШЕНИЯ.md, вопрос 2.
 *
 * ## Что реализация гарантирует
 *
 * - **ffmpeg подключается динамически** (`await import(...)`) и только в момент
 *   первого сжатия. В основной бандл библиотека не попадает.
 * - **Ядро — однопоточное** (`@ffmpeg/core`, не `core-mt`): на GitHub Pages нет
 *   заголовков COOP/COEP, а без них `SharedArrayBuffer` недоступен. Подробнее
 *   в шапке `config.ts`.
 * - **Оригинал не трогается.** Наружу уходят новые байты (`blob`), решение
 *   «заменить оригинал или хранить оба» принимает вызывающий код.
 * - **Прогресс отдаётся** (`onProgress`, 0..1) и **экран не морозится**: вся
 *   работа идёт в Web Worker, который создаёт ffmpeg.wasm.
 * - **Ошибки понятные**: наружу приходит `VideoCompressionError` с кодом и
 *   фразой для человека; исключений модуль не бросает.
 */

import {
  DEFAULT_VIDEO_COMPRESSION_SETTINGS,
  VIDEO_CORE_MIRRORS,
  VIDEO_OUTPUT_MIME,
  VIDEO_OUTPUT_NAME,
  coreDownloadRatio,
  coreFileUrls,
  describeCoreMirrorFailures,
  downloadCoreToBlobURL,
  loadCoreFromMirrors,
  mirrorName,
  resolveCompressionSettings,
  type CoreDownloadProgress,
} from './config'
import {
  buildCompressArgs,
  buildPlan,
  classifyFfmpegFailure,
  detectRuntimeEnv,
  formatBytes,
  formatSeconds,
  inputFileNameFor,
  mergeMediaInfo,
  missingRuntimeFeatures,
  parseEncodedSeconds,
  probeFromLines,
  progressAt,
  savingsOf,
  splitLogLines,
  targetDimensions,
  type PartialMediaInfo,
} from './logic'
import { readElementMetadata } from './metadata'
import {
  VideoCompressionError,
  type VideoCompressionJob,
  type VideoCompressionOutcome,
  type VideoCompressionSettings,
  type VideoCompressionStage,
  type VideoInspectionOutcome,
  type VideoMediaInfo,
  type VideoPreloadOutcome,
  type VideoSource,
} from './types'
import type { FFmpeg, LogEvent } from '@ffmpeg/ffmpeg'

/**
 * Сжатие видео. Одна реализация — браузерная; серверная появится позже
 * и подменит её без изменения вызывающего кода.
 */
export interface VideoCompressor {
  /** Метка реализации: `browser-ffmpeg` сейчас, `server` потом. */
  readonly kind: string
  /** Загружена ли тяжёлая часть (ядро ffmpeg). */
  isReady(): boolean
  /**
   * Загрузить ядро заранее — необязательно: `compress` загрузит его сам.
   * Нужно там, где человек уже согласился на сжатие и ждёт.
   */
  preload(options?: { onProgress?: ProgressSink; signal?: AbortSignal }): Promise<VideoPreloadOutcome>
  /**
   * Осмотр без ffmpeg: что за файл и надо ли его вообще сжимать.
   * Тяжёлая часть здесь не загружается — это важно, чтобы отказываться
   * от ненужной работы до скачивания десятков мегабайт.
   */
  inspect(
    source: VideoSource,
    settings?: Partial<VideoCompressionSettings>,
  ): Promise<VideoInspectionOutcome>
  /** Сжатие. Возвращает новые байты; оригинал не изменяется. */
  compress(job: VideoCompressionJob): Promise<VideoCompressionOutcome>
  /** Освободить память. `false` — идёт сжатие, отпускать нельзя. */
  release(): boolean
}

/** Как реализация сообщает о ходе дела. */
export type ProgressSink = (
  stage: VideoCompressionStage,
  stageProgress: number | null,
  encodedSec: number | null,
  message: string,
) => void

// --- Вспомогательное ---------------------------------------------------------

/** Ошибка отмены — одна и та же на все случаи. */
function abortedError(): VideoCompressionError {
  return new VideoCompressionError('aborted', 'Сжатие отменено — оригинал не тронут.')
}

/** Любое исключение превращаем в понятную ошибку: наружу летит только она. */
function asCompressionError(error: unknown): VideoCompressionError {
  if (error instanceof VideoCompressionError) return error
  const message = error instanceof Error ? error.message : String(error)
  if (/AbortError|aborted|was aborted/i.test(message)) return abortedError()
  const classified = classifyFfmpegFailure(message)
  return new VideoCompressionError(classified.code, classified.message, {
    retriable: classified.retriable,
    cause: error,
  })
}

/** Обещание с ограничением по времени: зависшая загрузка не должна висеть вечно. */
function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => VideoCompressionError): Promise<T> {
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

/**
 * Метаданные через `<video>` живут в `metadata.ts`: то же чтение нужно
 * расшифровке для расчёта стоимости, и две копии здесь разошлись бы.
 */

/** Удаление файла из внутренней ФС: ошибка удаления не важнее самого задания. */
async function safeDelete(ffmpeg: FFmpeg, path: string): Promise<void> {
  try {
    await ffmpeg.deleteFile(path)
  } catch {
    /* файла могло не быть — это не повод падать */
  }
}

/**
 * Байты результата — как `BlobPart`, по возможности без второго копирования:
 * результат бывает в сотни мегабайт, и лишняя копия на телефоне заметна.
 * Копируем только если ffmpeg вернул не весь буфер, а его часть.
 */
function blobPartOf(data: Uint8Array): ArrayBuffer {
  if (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength) {
    return data.buffer as ArrayBuffer
  }
  return data.slice().buffer as ArrayBuffer
}

// --- Браузерная реализация ---------------------------------------------------

export class BrowserVideoCompressor implements VideoCompressor {
  readonly kind = 'browser-ffmpeg'

  #settings: VideoCompressionSettings
  #ffmpeg: FFmpeg | null = null
  #loading: Promise<void> | null = null
  #busy = false
  /**
   * Номер «поколения» ядра: `release()` его увеличивает. Загрузка, начатая
   * до освобождения памяти, после завершения себя же и выключит — иначе
   * ядро вернулось бы в память сразу после того, как её освободили.
   */
  #generation = 0

  constructor(settings: Partial<VideoCompressionSettings> = {}) {
    this.#settings = resolveCompressionSettings(DEFAULT_VIDEO_COMPRESSION_SETTINGS, settings)
  }

  /** Параметры, с которыми работает сервис (по умолчанию 720p / 2500 кбит/с). */
  get settings(): VideoCompressionSettings {
    return this.#settings
  }

  isReady(): boolean {
    return this.#ffmpeg?.loaded === true
  }

  release(): boolean {
    if (this.#busy) return false
    this.#terminateCore()
    return true
  }

  /** Ядро отпускаем принудительно: после сбоя доверять ему нельзя. */
  #terminateCore(): void {
    try {
      this.#ffmpeg?.terminate()
    } catch {
      /* уже мёртв — и хорошо */
    }
    this.#ffmpeg = null
    this.#loading = null
    this.#generation += 1
  }

  async preload(
    options: { onProgress?: ProgressSink; signal?: AbortSignal } = {},
  ): Promise<VideoPreloadOutcome> {
    try {
      await this.#ensureCore(this.#settings, options.onProgress ?? (() => {}), options.signal)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: asCompressionError(error) }
    }
  }

  async inspect(
    source: VideoSource,
    settings: Partial<VideoCompressionSettings> = {},
  ): Promise<VideoInspectionOutcome> {
    const merged = resolveCompressionSettings(this.#settings, settings)
    const sizeBytes = source.blob?.size ?? 0
    if (sizeBytes <= 0) {
      return {
        ok: false,
        error: new VideoCompressionError('invalid_file', 'Файл пустой — сжимать нечего.'),
      }
    }
    if (sizeBytes > merged.maxInputBytes) {
      return { ok: false, error: tooLargeError(sizeBytes, merged) }
    }
    const fromElement = await readElementMetadata(source.blob, merged.metadataTimeoutMs)
    const info = mergeMediaInfo(sizeBytes, fromElement, null)
    return { ok: true, plan: buildPlan(info, merged) }
  }

  async compress(job: VideoCompressionJob): Promise<VideoCompressionOutcome> {
    const settings = resolveCompressionSettings(this.#settings, job.settings ?? {})
    const startedAt = Date.now()

    if (this.#busy) {
      return {
        ok: false,
        error: new VideoCompressionError(
          'busy',
          'Уже идёт сжатие другого видео — дождитесь окончания, пожалуйста.',
          { retriable: true },
        ),
      }
    }
    const missing = missingRuntimeFeatures(detectRuntimeEnv())
    if (missing.length > 0) {
      return {
        ok: false,
        error: new VideoCompressionError(
          'unsupported',
          `Сжатие в браузере недоступно: нет ${missing.join(', ')}.`,
        ),
      }
    }

    const sizeBytes = job.source.blob?.size ?? 0
    if (sizeBytes <= 0) {
      return {
        ok: false,
        error: new VideoCompressionError('invalid_file', 'Файл пустой — сжимать нечего.'),
      }
    }
    if (sizeBytes > settings.maxInputBytes) {
      return { ok: false, error: tooLargeError(sizeBytes, settings) }
    }

    this.#busy = true
    const needDownload = !this.isReady()
    let lastProgress = 0
    const report: ProgressSink = (stage, stageProgress, encodedSec, message) => {
      if (!job.onProgress) return
      // Полоса не должна идти назад: этапы идут по возрастанию, но события
      // из воркера могут прийти с опозданием.
      const progress = Math.max(lastProgress, progressAt(stage, stageProgress, needDownload))
      lastProgress = progress
      job.onProgress({ progress, stage, stageProgress, encodedSec, message })
    }

    try {
      if (job.signal?.aborted) throw abortedError()
      report('check', 0, null, 'Читаем параметры видео…')
      const fromElement = await readElementMetadata(job.source.blob, settings.metadataTimeoutMs)
      const initialInfo = mergeMediaInfo(sizeBytes, fromElement, null)
      const initialPlan = buildPlan(initialInfo, settings)
      // Уверенный отказ — до ffmpeg: не тратим ни мегабайты, ни минуты.
      if (!initialPlan.needed) {
        return {
          ok: false,
          error: new VideoCompressionError('not_needed', initialPlan.message),
          info: initialInfo,
        }
      }

      const ffmpeg = await this.#ensureCore(settings, report, job.signal)
      return await this.#encode(job, settings, ffmpeg, fromElement, sizeBytes, startedAt, report)
    } catch (error) {
      const failure = asCompressionError(error)
      // После сбоя памяти, таймаута или отмены воркер и его ФС не в порядке:
      // честнее отпустить ядро, чем получить загадочную ошибку в следующий раз.
      if (failure.code === 'out_of_memory' || failure.code === 'timeout' || failure.code === 'aborted') {
        this.#terminateCore()
      }
      return { ok: false, error: failure }
    } finally {
      this.#busy = false
    }
  }

  /** Загрузка ядра: только здесь и только один раз за жизнь сервиса. */
  async #ensureCore(
    settings: VideoCompressionSettings,
    report: ProgressSink,
    signal?: AbortSignal,
  ): Promise<FFmpeg> {
    if (this.#ffmpeg?.loaded) return this.#ffmpeg
    // Одновременные вызовы (preload и compress) ждут одну и ту же загрузку.
    if (!this.#loading) this.#loading = this.#createCore(settings, report, signal)
    try {
      await this.#loading
    } finally {
      this.#loading = null
    }
    if (!this.#ffmpeg) {
      throw new VideoCompressionError(
        'core_load_failed',
        'Ядро сжатия не загрузилось. Проверьте соединение и попробуйте ещё раз.',
        { retriable: true },
      )
    }
    return this.#ffmpeg
  }

  /**
   * Скачивает однопоточное ядро и создаёт воркер.
   *
   * Адреса отдаются воркеру как blob-URL: так не мешают ни редиректы CDN,
   * ни CORS, а главное — видно прогресс скачивания (31 МБ).
   * `workerURL` не передаём: он нужен только многопоточной сборке.
   *
   * Ядро берётся с первого доступного зеркала из `VIDEO_CORE_MIRRORS`. Каждому
   * зеркалу даётся полный бюджет загрузки (`coreLoadTimeoutMs`), поэтому
   * медленное, но живое первое зеркало работает ровно как раньше, а мёртвое —
   * обрывается по таймауту и уступает второму. JS и wasm всегда с одной базы.
   */
  async #createCore(
    settings: VideoCompressionSettings,
    report: ProgressSink,
    signal?: AbortSignal,
  ): Promise<void> {
    const generation = this.#generation

    const downloadReport =
      (from: number, to: number) =>
      (event: CoreDownloadProgress): void => {
        const ratio = coreDownloadRatio(event)
        const total = event.total > 0 ? ` из ${formatBytes(event.total)}` : ''
        report(
          'download',
          ratio === null ? null : from + (to - from) * ratio,
          null,
          `Загружаем ядро сжатия… ${formatBytes(event.received)}${total}`,
        )
      }

    const outcome = await loadCoreFromMirrors<FFmpeg>({
      mirrors: VIDEO_CORE_MIRRORS,
      signal,
      timeoutMs: settings.coreLoadTimeoutMs,
      onMirrorFailed: (failure, nextMirror) => {
        // Этапы и полоса остаются прежними: сообщение объясняет, почему
        // скачивание началось заново, и не даёт прогрессу «прыгнуть назад».
        report(
          'download',
          null,
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
        try {
          // Своё скачивание вместо `toBlobURL` с прогрессом: у той ошибка
          // «body stream already read» на jsdelivr (подробно — в config.ts).
          coreURL = await downloadCoreToBlobURL(urls.script, 'text/javascript', {
            signal: attemptSignal,
            onProgress: downloadReport(0, 0.4),
          })
          wasmURL = await downloadCoreToBlobURL(urls.wasm, 'application/wasm', {
            signal: attemptSignal,
            onProgress: downloadReport(0.4, 1),
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

    if (outcome.ok) {
      // Пока ядро грузилось, могли освободить память: тогда ядро не нужно.
      if (generation !== this.#generation) {
        outcome.core.terminate()
        return
      }
      this.#ffmpeg = outcome.core
      return
    }

    if (outcome.aborted) throw abortedError()
    throw new VideoCompressionError(
      'core_load_failed',
      'Ядро сжатия (ffmpeg) не скачалось ни с одного зеркала — для первого сжатия нужна сеть. ' +
        'Оригинал не тронут: попробуйте ещё раз, когда появится соединение.' +
        `\nПричины: ${describeCoreMirrorFailures(outcome.failures)}`,
      { retriable: true },
    )
  }

  /**
   * Разбор, кодирование и чтение результата.
   *
   * Здесь же уточняются метаданные: `<video>` мог не знать кодек, а ffmpeg
   * разбирает контейнер сам. Если после разбора окажется, что сжатие не нужно
   * (файл уже 720p и не жирнее цели) — выходим без кодирования.
   */
  async #encode(
    job: VideoCompressionJob,
    settings: VideoCompressionSettings,
    ffmpeg: FFmpeg,
    fromElement: PartialMediaInfo | null,
    sizeBytes: number,
    startedAt: number,
    report: ProgressSink,
  ): Promise<VideoCompressionOutcome> {
    const inputName = inputFileNameFor(job.source)
    let stage: 'probe' | 'encode' = 'probe'
    const probeLines: string[] = []
    let info: VideoMediaInfo = mergeMediaInfo(sizeBytes, fromElement, null)

    const onLog = (event: LogEvent): void => {
      for (const line of splitLogLines(event.message)) {
        job.onLog?.(line)
        if (stage === 'probe') {
          probeLines.push(line)
          continue
        }
        const seconds = parseEncodedSeconds(line)
        if (seconds === null) continue
        // Длительность неизвестна — прогресс честно «неопределённый», но
        // сколько уже закодировано, всё равно видно.
        if (info.durationSec === null) {
          report('encode', null, seconds, `Кодируем видео… ${formatSeconds(seconds)}`)
          continue
        }
        report(
          'encode',
          seconds / info.durationSec,
          seconds,
          `Кодируем видео… ${formatSeconds(seconds)} из ${formatSeconds(info.durationSec)}`,
        )
      }
    }

    ffmpeg.on('log', onLog)
    try {
      report('probe', 0.1, null, 'Готовим файл…')
      const { fetchFile } = await import('@ffmpeg/util')
      await ffmpeg.writeFile(inputName, await fetchFile(job.source.blob))
      if (job.signal?.aborted) throw abortedError()

      report('probe', 0.5, null, 'Разбираем контейнер…')
      // «ffmpeg -i файл» без выхода отвечает ошибкой — это нормально: нужен
      // только разбор. Код возврата здесь не проверяем намеренно.
      await ffmpeg.exec(['-hide_banner', '-i', inputName], -1, { signal: job.signal })
      info = mergeMediaInfo(sizeBytes, fromElement, probeFromLines(probeLines))
      const plan = buildPlan(info, settings)
      if (!plan.needed) {
        return {
          ok: false,
          error: new VideoCompressionError('not_needed', plan.message),
          info,
        }
      }
      if (info.width === null || info.height === null) {
        throw new VideoCompressionError(
          'invalid_file',
          'В файле не нашлось видеодорожки с понятным размером кадра. Оригинал не тронут.',
        )
      }

      stage = 'encode'
      report('encode', 0, 0, 'Начинаем сжатие…')
      const args = buildCompressArgs(inputName, VIDEO_OUTPUT_NAME, settings, plan.target)
      const exitCode = await withTimeout(
        ffmpeg.exec(args, -1, { signal: job.signal }),
        settings.encodeTimeoutMs,
        () =>
          new VideoCompressionError(
            'timeout',
            'Сжатие не уложилось в отведённое время. Попробуйте файл покороче ' +
              'или сожмите его на компьютере. Оригинал не тронут.',
            { retriable: true },
          ),
      )
      if (job.signal?.aborted) throw abortedError()
      if (exitCode !== 0) {
        throw new VideoCompressionError(
          'encode_failed',
          `ffmpeg не смог сжать это видео (код ${exitCode}). Оригинал не тронут.`,
          { retriable: true },
        )
      }

      report('finish', 0.5, null, 'Читаем результат…')
      const data = await ffmpeg.readFile(VIDEO_OUTPUT_NAME)
      if (!(data instanceof Uint8Array)) {
        throw new VideoCompressionError(
          'read_failed',
          'Не удалось прочитать сжатый файл. Оригинал не тронут.',
          { retriable: true },
        )
      }

      const blob = new Blob([blobPartOf(data)], { type: VIDEO_OUTPUT_MIME })
      const dimensions = targetDimensions(info, settings)
      const savings = savingsOf(sizeBytes, blob.size)
      report('finish', 1, null, 'Готово')
      return {
        ok: true,
        result: {
          blob,
          bytesBefore: sizeBytes,
          bytesAfter: blob.size,
          // Разбор до кодирования гарантировал размеры кадра; 0 здесь — уже
          // не «неизвестно», а признак того, что мы этого не допустили.
          width: dimensions.width ?? 0,
          height: dimensions.height ?? 0,
          durationSec: info.durationSec ?? 0,
          savedBytes: savings.savedBytes,
          savedRatio: savings.savedRatio,
          elapsedMs: Date.now() - startedAt,
          settings,
        },
      }
    } finally {
      ffmpeg.off('log', onLog)
      await safeDelete(ffmpeg, inputName)
      await safeDelete(ffmpeg, VIDEO_OUTPUT_NAME)
    }
  }
}

/** Отказ для файла, который больше, чем браузер может принять в память. */
function tooLargeError(sizeBytes: number, settings: VideoCompressionSettings): VideoCompressionError {
  return new VideoCompressionError(
    'too_large',
    `Файл ${formatBytes(sizeBytes)} — больше, чем браузер может обработать ` +
      `(предел ${formatBytes(settings.maxInputBytes)}). ` +
      'Такой файл нужно сжимать на сервере; оригинал не тронут.',
  )
}

/** Готовый экземпляр для приложения: ядро загрузится при первом сжатии. */
export const videoCompressor = new BrowserVideoCompressor()

/** Свой экземпляр — для нестандартных параметров или для тестов. */
export function createVideoCompressor(
  settings: Partial<VideoCompressionSettings> = {},
): VideoCompressor {
  return new BrowserVideoCompressor(settings)
}
