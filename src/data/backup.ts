/**
 * Резервная копия: один читаемый JSON-файл.
 *
 * Решение автора: экспорт делаем в ОДИН JSON-файл, не в zip (zip отложен).
 * Файл содержит `ideas`, `directions`, `history` и `meta`, поле версии схемы
 * и человекочитаемые отступы — чтобы копию можно было открыть и прочитать
 * без приложения.
 *
 * Здесь только чистые функции: сборка файла, разбор файла, сериализация.
 * Запись в базу и скачивание — в ExportService.
 *
 * Совместимость: файл со `schema_version` больше текущей не разбираем
 * (мы не знаем, что в нём), меньшей — разбираем, нормализуя записи.
 */

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

/** Метка формата: защищает от импорта чужого JSON. */
export const BACKUP_FORMAT = 'muza-backup'

/** Версия схемы выгрузки. Растёт, когда меняется состав полей. */
export const SCHEMA_VERSION = 1

/** Что лежит в файле резервной копии. */
export interface BackupFile {
  format: typeof BACKUP_FORMAT
  schema_version: number
  /** Когда файл собран. */
  exported_at: string
  /** Сколько чего внутри — для быстрой проверки файла глазами. */
  counts: {
    ideas: number
    directions: number
    history: number
    materials: number
  }
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

/** Сериализация с отступами: файл должен читаться человеком. */
export function serializeBackup(file: BackupFile): string {
  return `${JSON.stringify(file, null, 2)}\n`
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

/**
 * Разбирает текст файла в `BackupFile`, нормализуя каждую запись.
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
  if (source.format !== BACKUP_FORMAT) {
    throw new BackupParseError(
      'Это не файл «Музы»: нет метки формата. Проверьте, тот ли файл выбран.',
    )
  }

  const version = typeof source.schema_version === 'number' ? source.schema_version : 0
  if (version > SCHEMA_VERSION) {
    throw new BackupParseError(
      `Файл создан более новой версией «Музы» (схема ${version}, поддерживается ${SCHEMA_VERSION}). ` +
        'Обновите приложение и повторите импорт.',
    )
  }

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
    format: BACKUP_FORMAT,
    schema_version: version,
    exported_at: typeof source.exported_at === 'string' ? source.exported_at : '',
    counts: {
      ideas: ideas.items.length,
      directions: directions.items.length,
      history: history.items.length,
      materials: materials.items.length,
    },
    ideas: ideas.items,
    directions: directions.items,
    history: history.items,
    materials: materials.items,
    meta,
  }
}

/**
 * Имя файла выгрузки: `muza-backup-2026-10-21.json`.
 * Только латиница, цифры и дефисы — правило имён из СХЕМА-ДАННЫХ.md.
 */
export function backupFileName(at: Date = new Date()): string {
  const date = `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}`
  const time = `${pad2(at.getHours())}${pad2(at.getMinutes())}`
  return `muza-backup-${date}-${time}.json`
}

/** Двузначное число с ведущим нулём. */
function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}