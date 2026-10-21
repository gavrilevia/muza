/**
 * Резервная копия: zip-архив с читаемыми JSON и сырыми файлами.
 *
 * Решение автора: один JSON больше не годится — 30 фото, 20 голосовых и
 * 5 коротких видео дают около 240 МБ, а в base64 это ~320 МБ. Поэтому копия
 * едет zip-архивом, где содержимое материалов лежит отдельными файлами
 * `blobs/<material_id>` **без base64**, ровно теми байтами, что и в базе.
 *
 * Структура архива:
 *
 *   backup.zip
 *   ├── manifest.json      { format, schema_version, exported_at, counts }
 *   ├── ideas.json
 *   ├── directions.json
 *   ├── history.json
 *   ├── materials.json     ← записи материалов, без поля `blob`
 *   ├── meta.json
 *   └── blobs/<material_id>
 *
 * `materials.json` добавлен к перечню из задания: сами записи материалов
 * (к какому файлу относится `blobs/<id>`, тип, размер, извлечённый текст)
 * тоже надо где-то хранить, а в `manifest.json` им места нет.
 *
 * Здесь только чистые функции: сборка архива, разбор архива, сериализация.
 * Запись в базу и скачивание — в ExportService.
 *
 * Совместимость: файл со `schema_version` больше текущей не разбираем
 * (мы не знаем, что в нём), меньшей — разбираем, нормализуя записи.
 * Старый JSON-формат по-прежнему принимается: `parseBackup`.
 */

import { strFromU8, strToU8, unzip, zip } from 'fflate'
import type { AsyncZippable, Unzipped } from 'fflate'
import {
  dedupeById,
  normalizeDirection,
  normalizeHistoryEntry,
  normalizeIdea,
  normalizeMaterial,
  normalizeMetaRecord,
  sortHistory,
} from './records'
import type { Direction, HistoryEntry, Idea, Material, MetaRecord } from './types'

/** Метка формата: защищает от импорта чужого архива. */
export const BACKUP_FORMAT = 'muza-backup'

/** Версия схемы выгрузки. Растёт, когда меняется состав полей. */
export const SCHEMA_VERSION = 1

/** Имена файлов внутри архива. */
export const ARCHIVE_MANIFEST = 'manifest.json'
export const ARCHIVE_IDEAS = 'ideas.json'
export const ARCHIVE_DIRECTIONS = 'directions.json'
export const ARCHIVE_HISTORY = 'history.json'
export const ARCHIVE_MATERIALS = 'materials.json'
export const ARCHIVE_META = 'meta.json'
/** Папка с сырыми байтами файлов: `blobs/<material_id>`. */
export const ARCHIVE_BLOBS = 'blobs/'

/** Сколько чего в копии — для быстрой проверки файла глазами. */
export interface BackupCounts {
  ideas: number
  directions: number
  history: number
  materials: number
}

/** Что лежит в архиве, кроме самих записей: читается без исходного кода. */
export interface ArchiveManifest {
  format: typeof BACKUP_FORMAT
  schema_version: number
  /** Когда архив собран. */
  exported_at: string
  /** Сколько чего внутри; `blobs` — сколько файлов лежит в `blobs/`. */
  counts: BackupCounts & { blobs: number }
}

/** Байты архива. fflate отдаёт массив на обычном ArrayBuffer — его принимает Blob. */
export type ArchiveBytes = Uint8Array<ArrayBuffer>

/** Что лежит в файле резервной копии. */
export interface BackupFile {
  format: typeof BACKUP_FORMAT
  schema_version: number
  /** Когда файл собран. */
  exported_at: string
  /** Сколько чего внутри — для быстрой проверки файла глазами. */
  counts: BackupCounts
  ideas: Idea[]
  directions: Direction[]
  history: HistoryEntry[]
  materials: Material[]
  meta: MetaRecord[]
}

/** Данные, из которых собирается файл. */
export interface BackupData {
  ideas: readonly Idea[]
  directions: readonly Direction[]
  history: readonly HistoryEntry[]
  materials?: readonly Material[]
  meta?: readonly MetaRecord[]
}

/** Собирает файл резервной копии в устойчивом (детерминированном) порядке. */
export function buildBackup(data: BackupData, exportedAt: string): BackupFile {
  const ideas = [...data.ideas].sort((a, b) =>
    a.captured_at === b.captured_at ? compareIds(a.id, b.id) : a.captured_at < b.captured_at ? -1 : 1,
  )
  const directions = [...data.directions].sort((a, b) =>
    a.order === b.order ? (a.name < b.name ? -1 : 1) : a.order - b.order,
  )
  const history = sortHistory(data.history)
  const materials = [...(data.materials ?? [])].sort((a, b) =>
    a.added_at === b.added_at ? compareIds(a.id, b.id) : a.added_at < b.added_at ? -1 : 1,
  )
  const meta = [...(data.meta ?? [])].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))

  return {
    format: BACKUP_FORMAT,
    schema_version: SCHEMA_VERSION,
    exported_at: exportedAt,
    counts: {
      ideas: ideas.length,
      directions: directions.length,
      history: history.length,
      materials: materials.length,
    },
    ideas,
    directions,
    history,
    materials,
    meta,
  }
}

/** Строка для `id` при равных датах: порядок должен быть устойчивым. */
function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Запись материала без содержимого: байты едут отдельным файлом архива. */
function withoutBlob(material: Material): Material {
  if (!material.blob) return material
  const copy = { ...material }
  delete copy.blob
  return copy
}

/**
 * Сериализация с отступами: файл должен читаться человеком.
 *
 * Содержимое файлов в JSON не помещается (Blob превратился бы в `{}`),
 * поэтому поле `blob` здесь отбрасывается: JSON-формат остался только для
 * совместимости со старыми копиями и для чтения глазами.
 */
export function serializeBackup(file: BackupFile): string {
  const clean: BackupFile = { ...file, materials: file.materials.map(withoutBlob) }
  return `${JSON.stringify(clean, null, 2)}\n`
}

// --- Zip --------------------------------------------------------------------

/** Обещание поверх callback-API fflate: у него нет промисовых перегрузок в типах. */
function zipAsync(entries: AsyncZippable): Promise<ArchiveBytes> {
  return new Promise((resolve, reject) => {
    zip(entries, (error, data) => {
      if (error) reject(error)
      else resolve(data)
    })
  })
}

/** Обещание поверх callback-API fflate для разбора архива. */
function unzipAsync(bytes: Uint8Array): Promise<Unzipped> {
  return new Promise((resolve, reject) => {
    unzip(bytes, (error, data) => {
      if (error) reject(error)
      else resolve(data)
    })
  })
}

/** JSON внутри архива: с отступами и переводом строки на конце. */
function jsonEntry(value: unknown): Uint8Array {
  return strToU8(`${JSON.stringify(value, null, 2)}\n`)
}

/** Сколько материалов действительно несут содержимое. */
function countBlobs(materials: readonly Material[]): number {
  let total = 0
  for (const material of materials) if (material.blob) total += 1
  return total
}

/**
 * Собирает zip-архив резервной копии.
 *
 * Асинхронный `zip` из fflate не морозит интерфейс на больших архивах.
 * Байты файлов кладём без сжатия (`level: 0`): фото, видео и голос уже
 * сжаты, а повторный deflate только тратит время. JSON жмём обычным уровнем.
 */
export async function buildBackupZip(
  data: BackupData,
  exportedAt: string,
): Promise<ArchiveBytes> {
  const file = buildBackup(data, exportedAt)

  const manifest: ArchiveManifest = {
    format: BACKUP_FORMAT,
    schema_version: SCHEMA_VERSION,
    exported_at: exportedAt,
    counts: { ...file.counts, blobs: countBlobs(file.materials) },
  }

  const entries: AsyncZippable = {
    [ARCHIVE_MANIFEST]: jsonEntry(manifest),
    [ARCHIVE_IDEAS]: jsonEntry(file.ideas),
    [ARCHIVE_DIRECTIONS]: jsonEntry(file.directions),
    [ARCHIVE_HISTORY]: jsonEntry(file.history),
    [ARCHIVE_MATERIALS]: jsonEntry(file.materials.map(withoutBlob)),
    [ARCHIVE_META]: jsonEntry(file.meta),
  }

  for (const material of file.materials) {
    const blob = material.blob
    if (!blob) continue
    const bytes = new Uint8Array(await blob.arrayBuffer())
    entries[`${ARCHIVE_BLOBS}${material.id}`] = [bytes, { level: 0 }]
  }

  return zipAsync(entries)
}

/**
 * Архив ли это. Определяем по сигнатуре zip (`PK`), а не по имени файла:
 * пользователь мог переименовать копию как угодно.
 */
export function looksLikeZip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b
}

/** Достаёт JSON-файл архива; отсутствие — не ошибка, а пустая коллекция. */
function readJson(entries: Unzipped, name: string): unknown {
  const raw = entries[name]
  if (!raw) return undefined
  try {
    return JSON.parse(strFromU8(raw))
  } catch {
    throw new BackupParseError(`Файл ${name} внутри архива повреждён: это не JSON.`)
  }
}

/** Ошибка разбора файла резервной копии с понятным текстом. */
export class BackupParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BackupParseError'
  }
}

/** Приводит значение к массиву объектов; всё остальное — пустой массив. */
function asArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
}

/** Нормализованные коллекции копии. */
interface Collections {
  ideas: Idea[]
  directions: Direction[]
  history: HistoryEntry[]
  materials: Material[]
  meta: MetaRecord[]
}

/** Нормализация всех коллекций: и для zip, и для старого JSON. */
function normalizeCollections(source: Record<string, unknown>): Collections {
  const ideas = dedupeById(asArray(source.ideas).map((item) => normalizeIdea(item as Partial<Idea>)))
  const directions = dedupeById(
    asArray(source.directions).map((item) => normalizeDirection(item as Partial<Direction>)),
  )
  const history = dedupeById(
    asArray(source.history).map((item) => normalizeHistoryEntry(item as Partial<HistoryEntry>)),
  )
  const materials = dedupeById(
    asArray(source.materials).map((item) => normalizeMaterial(item as Partial<Material>)),
  )
  const meta = asArray(source.meta)
    .map((item) => normalizeMetaRecord(item as Partial<MetaRecord>))
    .filter((item) => item.key !== '')

  return {
    ideas: ideas.items,
    directions: directions.items,
    history: history.items,
    materials: materials.items,
    meta,
  }
}

/** Проверяет метку формата и версию схемы; бросает с русским текстом. */
function checkManifest(source: Record<string, unknown>, fromArchive: boolean): number {
  if (source.format !== BACKUP_FORMAT) {
    throw new BackupParseError(
      fromArchive
        ? 'Это не архив «Музы»: в manifest.json нет метки формата. Проверьте, тот ли файл выбран.'
        : 'Это не файл «Музы»: нет метки формата. Проверьте, тот ли файл выбран.',
    )
  }
  const version = typeof source.schema_version === 'number' ? source.schema_version : 0
  if (version > SCHEMA_VERSION) {
    throw new BackupParseError(
      `Файл создан более новой версией «Музы» (схема ${version}, поддерживается ${SCHEMA_VERSION}). ` +
        'Обновите приложение и повторите импорт.',
    )
  }
  return version
}

/** Собирает `BackupFile` из уже нормализованных коллекций. */
function toBackupFile(
  version: number,
  exportedAt: string,
  collections: Collections,
): BackupFile {
  return {
    format: BACKUP_FORMAT,
    schema_version: version,
    exported_at: exportedAt,
    counts: {
      ideas: collections.ideas.length,
      directions: collections.directions.length,
      history: collections.history.length,
      materials: collections.materials.length,
    },
    ideas: collections.ideas,
    directions: collections.directions,
    history: collections.history,
    materials: collections.materials,
    meta: collections.meta,
  }
}

/**
 * Разбирает текст старого JSON-файла в `BackupFile`, нормализуя записи.
 *
 * Бросает `BackupParseError` с русским текстом, если файл не JSON,
 * не наш формат или новее поддерживаемой схемы.
 */
export function parseBackup(text: string): BackupFile {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new BackupParseError('Файл не является JSON. Похоже, это не резервная копия «Музы».')
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BackupParseError('В файле нет данных резервной копии.')
  }

  const source = raw as Record<string, unknown>
  const version = checkManifest(source, false)
  const exportedAt = typeof source.exported_at === 'string' ? source.exported_at : ''
  return toBackupFile(version, exportedAt, normalizeCollections(source))
}

/**
 * Разбирает zip-архив: JSON-файлы плюс сырые байты из `blobs/`, которые
 * привязываются к материалам по `id`.
 *
 * Файлов без содержимого (ссылки, текст) в `blobs/` нет — это нормально.
 * Материал, для которого файл не нашёлся, остаётся без `blob`.
 */
export async function parseBackupZip(bytes: Uint8Array): Promise<BackupFile> {
  let entries: Unzipped
  try {
    entries = await unzipAsync(bytes)
  } catch {
    throw new BackupParseError(
      'Не удалось прочитать zip-архив: он повреждён или это не резервная копия «Музы».',
    )
  }

  const manifestRaw = readJson(entries, ARCHIVE_MANIFEST)
  if (!manifestRaw || typeof manifestRaw !== 'object' || Array.isArray(manifestRaw)) {
    throw new BackupParseError('В архиве нет manifest.json — это не резервная копия «Музы».')
  }
  const manifest = manifestRaw as Record<string, unknown>
  const version = checkManifest(manifest, true)
  const exportedAt = typeof manifest.exported_at === 'string' ? manifest.exported_at : ''

  const source: Record<string, unknown> = {
    ideas: readJson(entries, ARCHIVE_IDEAS),
    directions: readJson(entries, ARCHIVE_DIRECTIONS),
    history: readJson(entries, ARCHIVE_HISTORY),
    materials: readJson(entries, ARCHIVE_MATERIALS),
    meta: readJson(entries, ARCHIVE_META),
  }
  const collections = normalizeCollections(source)

  // Содержимое файлов: ищем по id материала. Байты не кодируем — кладём как есть.
  collections.materials = collections.materials.map((material) => {
    const raw = entries[`${ARCHIVE_BLOBS}${material.id}`]
    if (!raw || typeof Blob === 'undefined') return material
    return { ...material, blob: new Blob([raw], { type: material.mime ?? '' }) }
  })

  return toBackupFile(version, exportedAt, collections)
}

/**
 * Имя файла выгрузки: `muza-backup-2026-10-21-2245.zip`.
 * Только латиница, цифры и дефисы — правило имён из СХЕМА-ДАННЫХ.md.
 */
export function backupFileName(at: Date = new Date()): string {
  const date = `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}`
  const time = `${pad2(at.getHours())}${pad2(at.getMinutes())}`
  return `muza-backup-${date}-${time}.zip`
}

/** Двузначное число с ведущим нулём. */
function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

/** Порог, с которого о размере архива стоит предупредить: 100 МБ. */
export const ARCHIVE_WARNING_BYTES = 100 * 1024 * 1024

/**
 * Предупреждение о большом архиве для интерфейса выгрузки.
 * `null` — размер обычный, выгрузку ничто не усложняет.
 * Выгрузка не блокируется: это подсказка, а не запрет.
 */
export function archiveSizeWarning(
  sizeBytes: number,
  limit = ARCHIVE_WARNING_BYTES,
): string | null {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= limit) return null
  return (
    `Архив получился большой — ${formatSize(sizeBytes)}. ` +
    'Сохраните его в надёжном месте: загрузка может занять время, а на устройстве понадобится место.'
  )
}

/** Размер по-человечески: мегабайты с одним знаком после запятой. */
function formatSize(bytes: number): string {
  const megabytes = bytes / (1024 * 1024)
  return `${megabytes.toFixed(1)} МБ`
}
