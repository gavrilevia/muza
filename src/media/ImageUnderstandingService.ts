/**
 * Сервис «понять картинку»: читает текст на изображении и коротко описывает
 * его ОДНИМ ответом модели.
 *
 * Зачем один ответ: человеку нужны обе вещи, но платит он за один взгляд
 * модели. Текст идёт в `extracted_text` материала — по нему работает поиск
 * и разбор направлений (оба читают одно и то же поле). Описание помогает
 * направлениям понять смысл, когда текста на картинке почти нет.
 *
 * Что важно вызывающему коду:
 * - сервис НЕ трогает базу и НЕ запускается сам: только по нажатию кнопки;
 * - оригинал не изменяется — читается `blob` и возвращается текст;
 * - при любой ошибке приходит `ok: false` с понятной причиной, а материал
 *   и идея остаются у вызывающего кода;
 * - стоимость считается клиентом ИИ по токенам провайдера и лежит
 *   в `result.costRub` (или в `error.costRub`, если попытка уже была).
 *
 * Собирается в момент нажатия: ключ, добавленный после открытия экрана,
 * должен быть виден (та же причина, что у расшифровки).
 */

import {
  loadLlmConfig,
  LlmClient,
  LlmError,
  type LlmClientDeps,
  type LlmConfig,
  type MetaStore,
} from '../ai'
import { prepareImageForModel, type ImagePreparer } from './image'
import { buildImageUnderstandingMessages } from './prompt'
import {
  ImageUnderstandingError,
  type ImageUnderstandingErrorCode,
  type ImageUnderstandingJob,
  type ImageUnderstandingOutcome,
  type ImageUnderstandingResult,
  type ImageUnderstandingStage,
  type PreparedImage,
} from './types'

/** Внешние зависимости: сеть, приёмник расхода и подготовка картинки. */
export interface ImageUnderstandingDeps extends LlmClientDeps {
  /**
   * Подмена подготовки изображения — для тестов. В браузере по умолчанию
   * используется canvas и `createImageBitmap` (см. `image.ts`).
   */
  prepareImage?: ImagePreparer
}

/** Что нужно, чтобы собрать сервис: хранилище настроек и необязательные правки. */
export interface CreateImageUnderstandingServiceOptions {
  /** Хранилище `meta` из IndexedDB: ключ и настройки модели. */
  store?: MetaStore
  /** Явные переопределения конфига — сильнее значений из хранилища. */
  config?: Partial<LlmConfig>
  /** Подмена сети, подготовки картинки и приёмник расхода. */
  deps?: ImageUnderstandingDeps
}

/** Метка задачи в журнале расходов. */
export const IMAGE_UNDERSTANDING_TASK = 'image_understanding'

/**
 * Предел длины ответа для «понять картинку».
 *
 * Больше общего (2048), потому что рассуждающая модель тратит токены на
 * размышление до ответа, а на изображении их больше. Подробнее — у вызова
 * `chat` ниже.
 */
export const IMAGE_UNDERSTANDING_MAX_TOKENS = 8192

/** Код ошибки клиента ИИ → код ошибки сервиса. */
function mapLlmCode(error: LlmError): ImageUnderstandingErrorCode {
  switch (error.code) {
    case 'no_key':
      return 'no_key'
    case 'network':
      return 'network'
    case 'timeout':
      return 'timeout'
    case 'aborted':
      return 'aborted'
    case 'rate_limit':
      return 'rate_limit'
    case 'budget':
      return 'budget'
    case 'http':
      if (error.status === 401 || error.status === 403) return 'auth'
      if (error.status === 402) return 'budget'
      if (error.status === 413) return 'too_large'
      if (error.status !== undefined && error.status >= 500) return 'server'
      return 'http'
    // Пустой ответ клиент тоже помечает как `invalid_json` (см. LlmClient):
    // для человека это «модель не дала текст», а не поломка JSON.
    case 'invalid_json':
    case 'invalid_schema':
    case 'empty_input':
      return 'invalid_response'
  }
}

/** Ошибка клиента ИИ → понятная ошибка сервиса, с уже потраченной суммой. */
function fromLlmError(error: LlmError, costRub: number): ImageUnderstandingError {
  const code = mapLlmCode(error)
  let message = error.message
  if (code === 'too_large') {
    message = `Картинка не прошла по размеру даже после уменьшения (413). ${error.message}`
  }
  return new ImageUnderstandingError(code, message, {
    retriable: error.retriable,
    status: error.status ?? null,
    costRub,
    cause: error,
  })
}

/** Любая ошибка подготовки → ошибка сервиса. Ничего не глотаем. */
function fromPrepareError(error: unknown): ImageUnderstandingError {
  if (error instanceof ImageUnderstandingError) return error
  const message = error instanceof Error ? error.message : String(error)
  return new ImageUnderstandingError(
    'prepare_failed',
    `Не удалось подготовить картинку: ${message || 'неизвестная причина'}. Файл не отправлен.`,
    { cause: error },
  )
}

export class ImageUnderstandingService {
  private readonly settings: LlmConfig
  private readonly client: LlmClient
  private readonly prepareImage: ImagePreparer

  constructor(config: LlmConfig, deps: ImageUnderstandingDeps = {}) {
    const { prepareImage, ...clientDeps } = deps
    this.settings = config
    this.client = new LlmClient(config, clientDeps)
    this.prepareImage = prepareImage ?? prepareImageForModel
  }

  /** Модель, которая смотрит на картинку. */
  get model(): string {
    return this.settings.model
  }

  /** Сколько уже потрачено этим сервисом, ₽. */
  get spent(): number {
    return this.client.spent
  }

  /** Есть ли ключ: без него запрос не уходит и человек видит понятную причину. */
  hasKey(): boolean {
    return this.client.hasKey()
  }

  /**
   * Понимает картинку. Не бросает: любой сбой возвращается как `ok: false`.
   * Оригинал не изменяется, повторных фоновых попыток нет.
   */
  async understand(job: ImageUnderstandingJob): Promise<ImageUnderstandingOutcome> {
    const emit = (progress: number, stage: ImageUnderstandingStage, message: string): void => {
      try {
        job.onProgress?.({ progress, stage, stageProgress: null, message })
      } catch {
        // Индикатор прогресса не должен ломать платную операцию.
      }
    }

    if (!this.hasKey()) {
      return {
        ok: false,
        error: new ImageUnderstandingError(
          'no_key',
          'Не задан ключ API языковой модели. Добавьте его в настройках — картинка не отправлена.',
        ),
      }
    }
    if (job.signal?.aborted) {
      return {
        ok: false,
        error: new ImageUnderstandingError('aborted', 'Запрос отменён до отправки.'),
      }
    }
    if (!(job.source.blob instanceof Blob) || job.source.blob.size === 0) {
      return {
        ok: false,
        error: new ImageUnderstandingError('empty_file', 'Файл картинки пустой — смотреть нечего.'),
      }
    }

    emit(0.03, 'check', 'Читаю файл и проверяю формат…')

    let prepared: PreparedImage
    try {
      emit(0.18, 'resize', 'Готовлю картинку: уменьшаю, если она слишком большая…')
      prepared = await this.prepareImage({ blob: job.source.blob })
    } catch (error) {
      return { ok: false, error: fromPrepareError(error) }
    }

    if (job.signal?.aborted) {
      return {
        ok: false,
        error: new ImageUnderstandingError('aborted', 'Запрос отменён до отправки картинки модели.'),
      }
    }

    emit(
      0.4,
      'resize',
      prepared.resized
        ? `Картинка уменьшена: ${prepared.originalWidth}×${prepared.originalHeight} → ${prepared.width}×${prepared.height}.`
        : `Картинка готова: ${prepared.width}×${prepared.height}.`,
    )
    emit(0.55, 'request', 'Модель смотрит на картинку: читает текст и описывает её…')

    const result = await this.client.chat(buildImageUnderstandingMessages(prepared), {
      task: IMAGE_UNDERSTANDING_TASK,
      // Свой, увеличенный предел — и это не перестраховка.
      //
      // Модель рассуждающая (`default_effort: "high"`): она тратит токены на
      // внутреннее рассуждение ДО видимого ответа, и на изображении их больше,
      // чем на тексте. С общим пределом в 2048 ответ не успевал начаться —
      // приходило `finish_reason: "length"` и пустой текст. Живой случай:
      // «Прочитать и описать» на фото вернул ровно это.
      //
      // 8192 хватает на рассуждение ПЛЮС длинный текст с изображения
      // (скриншот рецепта или чека — это сотни слов). Счёт от предела НЕ
      // зависит: платим за фактические токены. Худший случай — 8192 токена
      // выхода, это 0,14 ₽; обычно выходит около 0,02 ₽.
      maxTokens: IMAGE_UNDERSTANDING_MAX_TOKENS,
      signal: job.signal,
    })

    if (!result.ok) {
      return { ok: false, error: fromLlmError(result.error, result.usage.costRub) }
    }

    const text = result.data.trim()
    if (text === '') {
      return {
        ok: false,
        error: new ImageUnderstandingError(
          'invalid_response',
          'Модель не вернула текст. Картинка не записана, попробуйте ещё раз.',
          { costRub: result.usage.costRub },
        ),
      }
    }

    emit(0.97, 'finish', 'Записываю текст и описание…')

    const understood: ImageUnderstandingResult = {
      text,
      mimeType: prepared.mimeType,
      width: prepared.width,
      height: prepared.height,
      bytes: prepared.bytes,
      resized: prepared.resized,
      originalWidth: prepared.originalWidth,
      originalHeight: prepared.originalHeight,
      costRub: result.usage.costRub,
      usage: result.usage,
      model: result.model,
      attempts: result.attempts,
    }
    emit(1, 'finish', 'Готово: текст с картинки и описание получены.')
    return { ok: true, result: understood }
  }
}

/**
 * Собирает сервис: читает ключ и настройки из хранилища (или из явного
 * конфига). Ключ в коде не хранится.
 */
export async function createImageUnderstandingService(
  options: CreateImageUnderstandingServiceOptions = {},
): Promise<ImageUnderstandingService> {
  const config = await loadLlmConfig(options.store, options.config ?? {})
  return new ImageUnderstandingService(config, options.deps)
}
