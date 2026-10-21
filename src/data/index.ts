/**
 * Точка входа слоя данных «Музы».
 *
 * Домен и интерфейс импортируют всё отсюда:
 *
 *   import { ideaRepository, historyStore } from './data'
 *
 * Что внутри:
 *   - `types`      — типы Idea, Direction, Material, HistoryEntry, QueueItem;
 *   - `ulid`       — генератор идентификаторов (без зависимостей);
 *   - `db`         — IndexedDB: хранилища, индексы, миграции;
 *   - репозитории  — IdeaRepository, DirectionStore, HistoryStore, QueueStore;
 *   - `ExportService` — выгрузка и импорт одним JSON-файлом;
 *   - `backup`, `records` — чистые функции формата и слияния (проверяются тестом).
 *
 * Домен не знает, где лежат данные: он работает через репозитории.
 */

export * from './types'

export { CROCKFORD, ULID_LENGTH, isUlid, ulid, ulidLastTime, ulidReset, ulidTime } from './ulid'

export {
  DB_NAME,
  DB_VERSION,
  SCHEMA_V1,
  STORES,
  StorageError,
  closeDb,
  countAll,
  countByIndex,
  deleteDb,
  getAll,
  getAllByIndex,
  iterateIndex,
  iterateStore,
  openDb,
  putMany,
  req,
  storageEstimate,
  txDone,
  withTx,
} from './db'
export type { StoreName, StoreSpec } from './db'

export {
  ACTORS,
  CAPTURED_VIA,
  HISTORY_TYPES,
  IDEA_KINDS,
  IDEA_STATUSES,
  MOMENT_RULES,
  dedupeById,
  deepEqual,
  mergeByKey,
  mergeById,
  mergeDirections,
  mergeHistory,
  mergeIdeas,
  mergeMeta,
  normalizeDirection,
  normalizeHistoryEntry,
  normalizeIdea,
  normalizeMaterial,
  normalizeMetaRecord,
  nowIso,
  preferIncomingDirection,
  preferIncomingIdea,
  sortHistory,
  toIso,
  toIsoOrNull,
  unionHistory,
} from './records'
export type { MergeOutcome } from './records'

export {
  BACKUP_FORMAT,
  BackupParseError,
  SCHEMA_VERSION,
  backupFileName,
  buildBackup,
  parseBackup,
  serializeBackup,
} from './backup'
export type { BackupData, BackupFile } from './backup'

export { IdeaRepository, ideaRepository } from './IdeaRepository'
export type { IdeaQuery, IdeaSortField } from './IdeaRepository'

export { DirectionStore, directionStore } from './DirectionStore'
export type { DirectionPatch, RemoveDirectionResult } from './DirectionStore'

export { HistoryStore, historyStore } from './HistoryStore'

export { QueueStore, RETRY_BASE_MS, RETRY_MAX_MS, queueStore, retryDelayMs } from './QueueStore'
export type { QueueQuery } from './QueueStore'

export {
  EXPORT_FORMAT,
  buildBackupFile,
  collectBackupData,
  describeImport,
  downloadBackup,
  exportBackup,
  exportBackupText,
  importBackupFile,
  importBackupText,
} from './ExportService'
export type { ImportReport } from './ExportService'