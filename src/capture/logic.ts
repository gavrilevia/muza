/**
 * Решения канала захвата — чистые функции без DOM и без IndexedDB.
 *
 * Всё, что можно решить «на бумаге», решается здесь: каким путём мысль
 * попала в систему (`captured_via`), какого типа материал, как назвать идею,
 * что написать в `body`, как объяснить ошибку человеку. Поэтому этот файл
 * целиком проверяется в Node — без браузера, — а браузерные
 * части — recorder.ts, shareInbox.ts, CaptureChannels.svelte — остаются
 * тонкими: добыть данные и отдать сюда.
 *
 * Договорённость про `captured_via`: это не «что нажал пользователь», а
 * «каким путём мысль попала в систему». Значения перечислены в
 * СХЕМА-ДАННЫХ.md. Там, где точного значения нет, берём ближайшее и
 * объясняем выбор комментарием.
 */

import type { CapturedVia, MaterialKind, MaterialOrigin } from '../data'
import type { CaptureChannel, CaptureFile, FileLike } from './types'

// --- Мелкие проверки типа файла ---------------------------------------------

export function isImage(file: FileLike): boolean {
  return file.type.startsWith('image/')
}

export function isAudio(file: FileLike): boolean {
  return file.type.startsWith('audio/')
}

export function isVideo(file: FileLike): boolean {
  return file.type.startsWith('video/')
}

export function isPdf(file: FileLike): boolean {
  return file.type === 'application/pdf'
}

/** Текст, который уже можно искать: txt, md, csv, json и подобное. */
export function isPlainText(file: FileLike): boolean {
  return file.type.startsWith('text/') || file.type === 'application/json'
}

/**
 * Приводит Blob (или File) к виду, с которым работает захват.
 * Имя и тип можно задать явно — так рождаются снимки из буфера и записи голоса.
 */
export function asCaptureFile(blob: Blob, name?: string, type?: string): CaptureFile {
  const named = blob as Blob & { name?: string }
  const fileName = (name ?? named.name ?? '').trim() || 'файл'
  return {
    blob,
    name: fileName,
    // Пустой тип — обычное дело для файлов из буфера; даём честный «неизвестно».
    type: (type ?? blob.type ?? '') || 'application/octet-stream',
    size: typeof blob.size === 'number' ? blob.size : 0,
  }
}

// --- captured_via -----------------------------------------------------------

/**
 * Файл из галереи или из файлового менеджера.
 *
 * Различить их можно только по типу: и то и другое приходит одним
 * `<input type="file">`. Если выбраны одни картинки — это почти наверняка
 * галерея (`gallery_import`), если среди них есть что-то ещё — файлы
 * (`files_save`).
 */
export function capturedViaForFiles(files: readonly FileLike[]): CapturedVia {
  if (files.length === 0) return 'files_save'
  return files.every(isImage) ? 'gallery_import' : 'files_save'
}

/** Один предмет поделили — `share_sheet`, несколько — `share_multiple`. */
export function capturedViaForShare(files: readonly FileLike[]): CapturedVia {
  return files.length > 1 ? 'share_multiple' : 'share_sheet'
}

/**
 * Перевод внутреннего канала в значение схемы.
 *
 * «Набрал в приложении на телефоне» и «набрал на десктопе» — один и тот же
 * путь `typed`: набор текста не привязан к устройству. Отдельное значение
 * для «картинка из буфера» есть — `clipboard`.
 */
export function capturedViaFor(
  channel: CaptureChannel,
  files: readonly FileLike[] = [],
): CapturedVia {
  switch (channel) {
    case 'text':
      return 'typed'
    case 'share':
      return capturedViaForShare(files)
    case 'camera':
      return 'camera'
    case 'file':
      return capturedViaForFiles(files)
    case 'voice':
      return 'voice'
    case 'clipboard':
      return 'clipboard'
  }
}

/**
 * Откуда пришёл материал.
 * `shared` — поделились из другого приложения, `imported` — выбрали файл,
 * `user` — сняли, записали или вставили сами.
 */
export function materialOriginFor(channel: CaptureChannel): MaterialOrigin {
  switch (channel) {
    case 'share':
      return 'shared'
    case 'file':
      return 'imported'
    default:
      return 'user'
  }
}

// --- Материал ---------------------------------------------------------------

/** Тип материала по типу файла. */
export function materialKindFor(file: FileLike): MaterialKind {
  if (isImage(file)) return 'image'
  if (isVideo(file)) return 'video'
  if (isAudio(file)) return 'audio'
  if (isPdf(file)) return 'pdf'
  // Своего «просто файл» в MaterialKind нет: ближайшее — текст.
  // Для незнакомых двоичных файлов извлечение всё равно помечается `skipped`.
  return 'text'
}

/**
 * Есть ли смысл обрабатывать материал потом (OCR, транскрипт, чтение текста).
 * Захват сам ничего не обрабатывает — он только помечает, что обработка нужна.
 * Незнакомый двоичный файл (архив, таблица) помечаем `skipped`, чтобы очередь
 * не крутила задачу, которую не умеет решить.
 */
export function materialCanBeProcessed(file: FileLike): boolean {
  return isPlainText(file) || isImage(file) || isVideo(file) || isAudio(file) || isPdf(file)
}

/** Расширение для имени файла, которое мы придумываем сами. */
const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'video/webm': 'webm',
  'video/mp4': 'mp4',
  'application/pdf': 'pdf',
}

export function extensionForMime(mime: string): string {
  const base = mime.split(';')[0].trim().toLowerCase()
  const known = MIME_EXTENSIONS[base]
  if (known) return known
  if (base.startsWith('image/')) return base.slice('image/'.length)
  return 'bin'
}

/** Имя для файла, который мы создаём сами: `clipboard-20261021-224501.png`. */
export function stampedName(prefix: string, extension: string, at: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  const stamp =
    `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}` +
    `-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
  // Прощение на входе: сюда могут передать и расширение (`png`), и MIME
  // (`image/png`) — из второго сами достанем расширение.
  const raw = extension.includes('/') ? extensionForMime(extension) : extension
  const ext = raw.replace(/^\./, '').replace(/[^a-z0-9]+/gi, '') || 'bin'
  return `${prefix}-${stamp}.${ext}`
}

// --- Подписи: заголовок и текст идеи ----------------------------------------

/** Первая строка — заголовок; длинный заголовок обрезаем. */
export function firstLine(value: string, limit = 120): string {
  return value.split('\n')[0].trim().slice(0, limit)
}

export interface TitleInput {
  channel: CaptureChannel
  text?: string | null
  sourceTitle?: string | null
  files?: readonly FileLike[]
  url?: string | null
  durationSec?: number | null
}

/** Хост ссылки — понятнее, чем пустой заголовок у поделённой ссылки. */
export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname || null
  } catch {
    return null
  }
}

/**
 * Заголовок идеи. Своих слов пользователя всегда достаточно; если их нет —
 * берём заголовок источника, имя файла, а в крайнем случае — название канала.
 * Пустой заголовок допустим схемой, но пустая строка в списке выглядит
 * как сбой, поэтому запасной вариант есть всегда.
 */
export function suggestTitle(input: TitleInput): string {
  const files = input.files ?? []

  const typed = firstLine(input.text ?? '')
  if (typed) return typed

  const fromSource = firstLine(input.sourceTitle ?? '')
  if (fromSource) return fromSource

  if (files.length === 1) return firstLine(files[0].name)
  if (files.length > 1) {
    return `Файлы: ${firstLine(files[0].name)} и ещё ${files.length - 1}`
  }

  if (input.channel === 'voice') {
    const seconds = input.durationSec
    const tail = seconds && seconds > 0 ? `, ${formatDuration(seconds)}` : ''
    return `Голосовая заметка${tail}`
  }
  if (input.channel === 'camera') return 'Снимок с камеры'
  if (input.channel === 'clipboard') return 'Вставка из буфера'
  if (input.channel === 'share') {
    const host = input.url ? hostOf(input.url) : null
    return host ? `Ссылка: ${host}` : 'Идея из «Поделиться»'
  }
  return 'Идея'
}

export interface BodyInput {
  channel: CaptureChannel
  text?: string | null
  url?: string | null
}

/**
 * Текст идеи. Ссылку из «Поделиться» дописываем отдельной строкой, но только
 * если её ещё нет в тексте: Android часто присылает ссылку и внутри текста,
 * и отдельным полем — дублировать её в теле не нужно.
 */
export function suggestBody(input: BodyInput): string {
  const text = (input.text ?? '').trim()
  const url = (input.url ?? '').trim()
  if (input.channel !== 'share' || !url) return text
  if (text.includes(url)) return text
  return text ? `${text}\n\n${url}` : url
}

/** Секунды в `м:сс` — для подписи записи голоса. */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds))
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return `${minutes}:${String(rest).padStart(2, '0')}`
}

// --- «Поделиться» -----------------------------------------------------------

export interface SharedFields {
  title: string | null
  text: string | null
  url: string | null
}

/** Приводит поля от share sheet к чистым строкам: пустое — это `null`. */
export function splitSharedFields(fields: {
  title?: unknown
  text?: unknown
  url?: unknown
}): SharedFields {
  const clean = (value: unknown): string | null => {
    if (typeof value !== 'string') return null
    const trimmed = value.trim()
    return trimmed ? trimmed : null
  }
  return { title: clean(fields.title), text: clean(fields.text), url: clean(fields.url) }
}

/** Состояние возврата после «Поделиться»: SW ведёт на `?share=1` или `?share=error`. */
export function shareReturnState(search: string): 'none' | 'ready' | 'error' {
  const params = new URLSearchParams(search.startsWith('?') ? search : `?${search}`)
  const value = params.get('share')
  if (value === '1') return 'ready'
  if (value === 'error') return 'error'
  return 'none'
}

// --- Запись голоса ----------------------------------------------------------

/**
 * Порядок предпочтений записи. Opus в WebM понимают все, кроме Safari,
 * поэтому `audio/mp4` стоит до `audio/mpeg` (Safari пишет именно mp4).
 */
export const AUDIO_MIME_CANDIDATES: readonly string[] = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
  'audio/mpeg',
]

/** Первый поддерживаемый формат записи; `null` — браузер не сказал ничего. */
export function pickAudioMimeType(isSupported: (type: string) => boolean): string | null {
  for (const type of AUDIO_MIME_CANDIDATES) {
    try {
      if (isSupported(type)) return type
    } catch {
      /* браузер может бросить на незнакомом типе — просто идём дальше */
    }
  }
  return null
}

// --- Ошибки -----------------------------------------------------------------

/** Действие, о котором говорим в сообщении об ошибке. */
export type CaptureAction = 'voice' | 'camera' | 'files' | 'clipboard' | 'share' | 'save'

const ACTION_LABELS: Record<CaptureAction, string> = {
  voice: 'микрофон',
  camera: 'камеру',
  files: 'файлы',
  clipboard: 'буфер обмена',
  share: 'обмен',
  save: 'сохранение',
}

/**
 * Ошибка «так нельзя в этом браузере»: не сбой, а отсутствие возможности.
 * Отдельный класс нужен, чтобы интерфейс показал подсказку, а не «ошибку».
 */
export class CaptureUnsupportedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CaptureUnsupportedError'
  }
}

/** Понятное сообщение вместо технического. Текст идеи при этом не пропадает. */
export function describeCaptureError(error: unknown, action: CaptureAction): string {
  const label = ACTION_LABELS[action]
  if (error instanceof CaptureUnsupportedError) return error.message

  if (error instanceof Error) {
    const name = error.name
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
      return `Нет доступа к «${label}»: браузер не спросил разрешение или его запретили. Разрешите доступ и попробуйте снова.`
    }
    if (name === 'SecurityError') {
      return `Браузер запретил «${label}»: нужен HTTPS (или localhost). Введённый текст остался на месте.`
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      return `Не нашлось устройства для «${label}». Текст остался на месте.`
    }
    if (name === 'NotReadableError' || name === 'TrackStartError') {
      return `«${label}» занят другим приложением. Закройте его и попробуйте снова.`
    }
    if (name === 'AbortError') {
      return `Запись прервана. Попробуйте снова — текст остался на месте.`
    }
    if (error.message.trim()) return error.message
  }
  return `Не получилось: «${label}». Введённый текст остался в поле — попробуйте ещё раз.`
}

/** Подсказка, когда возможности нет вовсе (нет MediaRecorder, нет буфера и т.п.). */
export function unsupportedMessage(action: CaptureAction): string {
  const label = ACTION_LABELS[action]
  switch (action) {
    case 'voice':
      return 'Этот браузер не умеет записывать голос. Запишите диктофоном и приложите файлом — текст останется на месте.'
    case 'clipboard':
      return 'Браузер не даёт читать буфер обмена. Вставьте текст в поле (Ctrl+V) или приложите файл.'
    case 'share':
      return 'Браузер не поддерживает приём «Поделиться». На iPhone это ограничение iOS: воспользуйтесь кнопкой «+» или файлом.'
    default:
      return `Этот браузер не поддерживает «${label}».`
  }
}

/**
 * Канал → действие для сообщения об ошибке.
 * Канал «файл» в схеме называется `files_save`, а «+» — это про сохранение
 * идеи целиком; отсюда и разные слова в тексте ошибки.
 */
export function actionForChannel(channel: CaptureChannel): CaptureAction {
  switch (channel) {
    case 'file':
      return 'files'
    case 'text':
      return 'save'
    default:
      return channel
  }
}
