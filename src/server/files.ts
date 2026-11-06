/**
 * Файлы на сервере: загрузка ЧАСТЯМИ, докачка, выдача обратно.
 *
 * Зачем это вообще. Файл на 231 МБ одним куском не уедет: оборвётся связь,
 * упрётся лимит прокси — и загрузка начнётся заново. Поэтому сервер
 * принимает файл частями (встроенная многoчастная загрузка S3), а клиент
 * умеет продолжить с того места, где оборвалось.
 *
 * ЧТО ЗДЕСЬ ЕСТЬ И ЧЕГО НЕТ.
 *   - есть транспорт: начать, отправить части, спросить принятое, завершить,
 *     отменить, скачать;
 *   - нет шифрования: `prepare` — шов для него. Пока файл уходит как есть,
 *     и это осознанно не подключено к захвату, чтобы не отправить личное
 *     на сервер раньше, чем появится шифрование;
 *   - нет UI: экран сервера — отдельная задача.
 *
 * ПОЧЕМУ ОТДЕЛЬНЫЙ КЛАСС, А НЕ ФУНКЦИЯ. Нужны повторные попытки, прогресс
 * и отмена — это состояние, а не один вызов. Сеть подменяется через `deps`,
 * поэтому весь путь проверяется в Node без сервера и без денег.
 */

/**
 * Адрес сервера файлов. На dev — свой домен (и свой бакет), иначе
 * разработка писала бы файлы в прод-хранилище.
 */
export function serverBaseFor(hostname: string, origin: string): string {
  return hostname === 'dev.mymuza.pro' ? origin : 'https://mymuza.pro'
}

/** Адрес сервера в этой сборке. В Node (проверки) — прод. */
export const SERVER_BASE_URL =
  typeof location === 'undefined' ? 'https://mymuza.pro' : serverBaseFor(location.hostname, location.origin)

/** Сколько раз повторяем одну часть при сетевом сбое. */
const DEFAULT_RETRIES = 3
/** Пауза перед повтором: растёт с каждой попыткой. */
const DEFAULT_RETRY_DELAY_MS = 500

/** Что нужно клиенту: сеть и терпение. */
export interface ServerFileDeps {
  fetch?: typeof fetch
  retries?: number
  retryDelayMs?: number
}

/** Итог загрузки: id файла на сервере и сколько частей ушло. */
export interface UploadResult {
  id: string
  size: number
  parts: number
}

/** Что сервер уже принял. */
export interface UploadStatus {
  accepted: number[]
  size: number
}

/** Настройки одной загрузки. */
export interface UploadOptions {
  /** Сколько байт уже отправлено из сколько всего. */
  onProgress?: (sent: number, total: number) => void
  /** Отмена: проверяется перед каждой частью и передаётся в сеть. */
  signal?: AbortSignal
  /**
   * Преобразование файла перед отправкой — шов для шифрования.
   *
   * Применяется ко ВСЕМУ файлу сразу, а не к части: иначе размер частей
   * и общий размер разъедутся, и сервер не сможет проверить целостность.
   */
  prepare?: (blob: Blob) => Promise<Blob>
}

/** Коды отказа: по ним интерфейс говорит разное, а не «ошибка». */
export type ServerFileErrorCode =
  | 'network'
  | 'unauthorized'
  | 'not_found'
  | 'too_large'
  | 'incomplete'
  | 'bad_response'
  | 'aborted'

/** Отказ сервера или сети с понятной причиной. */
export class ServerFileError extends Error {
  readonly code: ServerFileErrorCode
  /** Что сервер успел принять — для докачки после отказа. */
  readonly accepted: number[]

  constructor(code: ServerFileErrorCode, message: string, accepted: number[] = []) {
    super(message)
    this.name = 'ServerFileError'
    this.code = code
    this.accepted = accepted
  }
}

/** Сколько частей нужно на файл такого размера. */
export function partCount(size: number, partSize: number): number {
  if (!Number.isFinite(size) || size <= 0) return 0
  if (!Number.isFinite(partSize) || partSize <= 0) return 0
  return Math.ceil(size / partSize)
}

/** Границы части: `index` считается с единицы, как у S3. */
export function partRange(
  index: number,
  partSize: number,
  size: number,
): { start: number; end: number } {
  const start = (index - 1) * partSize
  return { start, end: Math.min(start + partSize, size) }
}

/** Каких частей не хватает: 1…total без уже принятых. */
export function missingParts(accepted: readonly number[], total: number): number[] {
  const have = new Set(accepted)
  const missing: number[] = []
  for (let number = 1; number <= total; number += 1) {
    if (!have.has(number)) missing.push(number)
  }
  return missing
}

/** Сколько байт уже принято — по номерам частей и их размеру. */
export function acceptedBytes(
  accepted: readonly number[],
  partSize: number,
  size: number,
): number {
  let sent = 0
  for (const number of accepted) {
    const { start, end } = partRange(number, partSize, size)
    sent += Math.max(0, end - start)
  }
  return sent
}

/** Пауза, которую можно прервать отменой. */
function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ServerFileError('aborted', 'Загрузка отменена.'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new ServerFileError('aborted', 'Загрузка отменена.'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Клиент файлового хранилища. */
export class ServerFiles {
  readonly #baseUrl: string
  readonly #token: string
  readonly #fetch: typeof fetch
  readonly #retries: number
  readonly #retryDelayMs: number

  constructor(baseUrl: string, token: string, deps: ServerFileDeps = {}) {
    this.#baseUrl = baseUrl.replace(/\/+$/, '')
    this.#token = token.trim()
    this.#fetch = deps.fetch ?? ((...args) => fetch(...args))
    this.#retries = Math.max(0, deps.retries ?? DEFAULT_RETRIES)
    this.#retryDelayMs = Math.max(0, deps.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS)
  }

  /** Заголовки: пароль сервера, если он задан. */
  #headers(extra: Record<string, string> = {}): Record<string, string> {
    return this.#token === ''
      ? extra
      : { ...extra, Authorization: `Bearer ${this.#token}` }
  }

  /** Один запрос с разбором ответа. Сеть не повторяет — это делают части. */
  async #request(path: string, init: RequestInit = {}): Promise<Response> {
    let response: Response
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        ...init,
        headers: this.#headers((init.headers as Record<string, string>) ?? {}),
      })
    } catch (e) {
      if (e instanceof ServerFileError) throw e
      throw new ServerFileError('network', 'Сервер недоступен: проверьте связь.')
    }
    if (response.status === 401 || response.status === 403) {
      throw new ServerFileError('unauthorized', 'Сервер не принял пароль.')
    }
    if (response.status === 404) {
      throw new ServerFileError('not_found', 'Такой загрузки на сервере нет.')
    }
    return response
  }

  /** Начинает загрузку: сервер говорит id, размер части и сколько их. */
  async begin(size: number): Promise<{ id: string; partSize: number; parts: number }> {
    const response = await this.#request('/file/begin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ size }),
    })
    if (response.status === 400) {
      throw new ServerFileError('too_large', 'Файл слишком большой для сервера.')
    }
    if (!response.ok) {
      throw new ServerFileError('bad_response', `Сервер ответил ${response.status}.`)
    }
    const data = (await response.json()) as {
      id?: unknown
      partSize?: unknown
      parts?: unknown
    }
    if (typeof data.id !== 'string' || typeof data.partSize !== 'number') {
      throw new ServerFileError('bad_response', 'Сервер не сказал, как загружать файл.')
    }
    return {
      id: data.id,
      partSize: data.partSize,
      parts: typeof data.parts === 'number' ? data.parts : partCount(size, data.partSize),
    }
  }

  /** Что уже принято: по этому клиент продолжает после обрыва. */
  async status(id: string): Promise<UploadStatus> {
    const response = await this.#request(`/file/status/${id}`)
    if (!response.ok) {
      throw new ServerFileError('bad_response', `Сервер ответил ${response.status}.`)
    }
    const data = (await response.json()) as { accepted?: unknown; size?: unknown }
    const accepted = Array.isArray(data.accepted)
      ? data.accepted.filter((value): value is number => typeof value === 'number')
      : []
    return { accepted, size: typeof data.size === 'number' ? data.size : 0 }
  }

  /** Отправляет одну часть. Повторяет при сетевом сбое и 5xx. */
  async #putPart(
    id: string,
    number: number,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<void> {
    let lastError: ServerFileError | null = null
    for (let attempt = 0; attempt <= this.#retries; attempt += 1) {
      if (signal?.aborted) throw new ServerFileError('aborted', 'Загрузка отменена.')
      if (attempt > 0) await wait(this.#retryDelayMs * attempt, signal)
      try {
        const response = await this.#request(`/file/part/${id}/${number}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/octet-stream' },
          // Буфер ровно этого размера: часть нарезана из файла, лишнего нет.
          body: bytes.buffer as ArrayBuffer,
          signal,
        })
        if (response.ok) return
        // 4xx — наша ошибка, повторять бессмысленно.
        if (response.status < 500) {
          throw new ServerFileError(
            'bad_response',
            `Сервер не принял часть ${number}: ${response.status}.`,
          )
        }
        lastError = new ServerFileError('network', `Сервер ответил ${response.status}.`)
      } catch (e) {
        if (e instanceof ServerFileError) {
          if (e.code === 'aborted' || e.code === 'unauthorized' || e.code === 'not_found') throw e
          if (e.code === 'bad_response') throw e
          lastError = e
        } else {
          lastError = new ServerFileError('network', 'Связь оборвалась при отправке части.')
        }
      }
    }
    throw lastError ?? new ServerFileError('network', 'Не удалось отправить часть.')
  }

  /**
   * Загружает файл целиком: начать, дослать недостающее, завершить.
   *
   * Докачка встроена: перед отправкой спрашиваем, что сервер уже принял.
   * Поэтому повторный вызов после обрыва не начинает с нуля.
   */
  async upload(blob: Blob, options: UploadOptions = {}): Promise<UploadResult> {
    const prepared = options.prepare ? await options.prepare(blob) : blob
    const size = prepared.size
    if (size <= 0) throw new ServerFileError('bad_response', 'Пустой файл отправлять нечего.')

    const { id, partSize, parts } = await this.begin(size)
    const status = await this.status(id)
    const missing = missingParts(status.accepted, parts)
    let sent = acceptedBytes(status.accepted, partSize, size)
    options.onProgress?.(sent, size)

    for (const number of missing) {
      if (options.signal?.aborted) {
        await this.abort(id).catch(() => {})
        throw new ServerFileError('aborted', 'Загрузка отменена.')
      }
      const { start, end } = partRange(number, partSize, size)
      const bytes = new Uint8Array(await prepared.slice(start, end).arrayBuffer())
      await this.#putPart(id, number, bytes, options.signal)
      sent += end - start
      options.onProgress?.(sent, size)
    }

    const response = await this.#request(`/file/complete/${id}`, { method: 'POST' })
    if (response.status === 409) {
      const data = (await response.json().catch(() => ({}))) as { accepted?: unknown }
      const accepted = Array.isArray(data.accepted)
        ? data.accepted.filter((value): value is number => typeof value === 'number')
        : []
      throw new ServerFileError(
        'incomplete',
        'Сервер принял не все части — файл не собран.',
        accepted,
      )
    }
    if (!response.ok) {
      throw new ServerFileError('bad_response', `Сервер ответил ${response.status}.`)
    }
    return { id, size, parts }
  }

  /** Скачивает файл обратно. */
  async download(id: string): Promise<Blob> {
    const response = await this.#request(`/file/${id}`)
    if (!response.ok) {
      throw new ServerFileError('not_found', 'Файла на сервере нет.')
    }
    return response.blob()
  }

  /** Отменяет незаконченную загрузку: сервер освобождает место. */
  async abort(id: string): Promise<void> {
    await this.#request(`/file/abort/${id}`, { method: 'POST' })
  }
}
