/**
 * ExportService — выгрузка и восстановление всей базы.
 *
 * Решение автора: экспорт — ОДИН читаемый JSON-файл, не zip (zip отложен).
 * Внутри лежат `ideas`, `directions`, `history`, `materials` и `meta`
 * (состав и правила формата — в backup.ts).
 *
 * Импорт — слияние ПО ID, идемпотентное: повторный импорт того же файла
 * не создаёт дубликатов и не меняет данные. Журнал истории при этом только
 * дополняется (см. HistoryStore).
 *
 * Что НЕ попадает в копию и почему:
 *   - `queue` — очередь обработки привязана к устройству и пересоздаётся;
 *   - `vectors` — пересчитываемый индекс, место в файле только раздувает;
 *   - `events` — локальная аналитика этого устройства.
 *
 * Импорт пишет всё одной транзакцией: либо файл применился целиком, либо
 * база осталась прежней. Половинчатого состояния не бывает.
 */

import { BACKUP_FORMAT, backupFileName, buildBackup, parseBackup, serializeBackup } from './backup'
import type { BackupData, BackupFile } from './backup'
import { req, withTx } from './db'
import {
  mergeById,
  mergeDirections,
  mergeHistory,
  mergeIdeas,
  mergeMeta,
} from './records'
import type { MergeOutcome } from './records'
import type { Direction, HistoryEntry, Idea, Material, MetaRecord } from './types'

/** Отчёт об импорте: что именно произошло с каждой коллекцией. */
export interface ImportReport {
  schema_version: number
  exported_at: string
  ideas: MergeOutcome<Idea>
  directions: MergeOutcome<Direction>
  history: MergeOutcome<HistoryEntry>
  materials: MergeOutcome<Material>
  meta: MergeOutcome<MetaRecord>
}

/** Собирает данные из базы одним согласованным чтением. */
export async function collectBackupData(): Promise<BackupData> {
  return withTx(['ideas', 'directions', 'history', 'materials', 'meta'], 'readonly', async (tx) => {
    const ideas = await req<Idea[]>(tx.objectStore('ideas').getAll())
    const directions = await req<Direction[]>(tx.objectStore('directions').getAll())
    const history = await req<HistoryEntry[]>(tx.objectStore('history').getAll())
    const materials = await req<Material[]>(tx.objectStore('materials').getAll())
    const meta = await req<MetaRecord[]>(tx.objectStore('meta').getAll())
    return { ideas, directions, history, materials, meta }
  })
}

/** Собирает файл резервной копии (без скачивания) — удобно для проверок. */
export async function buildBackupFile(at: Date = new Date()): Promise<BackupFile> {
  const data = await collectBackupData()
  return buildBackup(data, at.toISOString())
}

/** Собирает файл и отдаёт его текстом. */
export async function exportBackupText(at: Date = new Date()): Promise<string> {
  return serializeBackup(await buildBackupFile(at))
}

/**
 * Отдаёт файл пользователю: браузер скачивает его как обычный файл.
 * Сеть не используется — файл собирается и сохраняется на устройстве.
 */
export function downloadBackup(file: BackupFile, at: Date = new Date()): void {
  const text = serializeBackup(file)
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = backupFileName(at)
  link.rel = 'noopener'
  link.style.display = 'none'
  document.body.appendChild(link)
  link.click()
  link.remove()
  // Ссылку освобождаем не сразу: Safari успевает прочитать blob только
  // после того, как отработает клик.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** Собирает копию и сразу скачивает её. */
export async function exportBackup(at: Date = new Date()): Promise<BackupFile> {
  const file = await buildBackupFile(at)
  downloadBackup(file, at)
  return file
}

/**
 * Импортирует копию из текста.
 * Слияние по id, всё одной транзакцией, отчёт — в возвращаемом значении.
 */
export async function importBackupText(text: string): Promise<ImportReport> {
  const file = parseBackup(text)

  const report = await withTx(
    ['ideas', 'directions', 'history', 'materials', 'meta'],
    'readwrite',
    async (tx) => {
      const ideaStore = tx.objectStore('ideas')
      const directionStore = tx.objectStore('directions')
      const historyStore = tx.objectStore('history')
      const materialStore = tx.objectStore('materials')
      const metaStore = tx.objectStore('meta')

      const ideas = mergeIdeas(await req<Idea[]>(ideaStore.getAll()), file.ideas)
      const directions = mergeDirections(
        await req<Direction[]>(directionStore.getAll()),
        file.directions,
      )
      // Журнал: только дополняется, существующие записи не перетираются.
      const history = mergeHistory(await req<HistoryEntry[]>(historyStore.getAll()), file.history)
      const materials = mergeById(
        await req<Material[]>(materialStore.getAll()),
        file.materials,
        () => false,
      )
      // Настройки устройства импортом не перетираем: чужие пороги не нужны.
      const meta = mergeMeta(await req<MetaRecord[]>(metaStore.getAll()), file.meta)

      // Записываем итоговые наборы. Повторная запись тех же значений
      // безопасна: ключ — id, дубликат невозможен.
      for (const idea of ideas.items) ideaStore.put(idea)
      for (const direction of directions.items) directionStore.put(direction)
      for (const entry of history.items) historyStore.put(entry)
      for (const material of materials.items) materialStore.put(material)
      for (const record of meta.items) metaStore.put(record)

      return {
        schema_version: file.schema_version,
        exported_at: file.exported_at,
        ideas,
        directions,
        history,
        materials,
        meta,
      } satisfies ImportReport
    },
  )

  return report
}

/**
 * Импортирует копию из выбранного файла.
 * Разбор JSON идёт ДО транзакции: ждать чтение файла внутри транзакции нельзя.
 */
export async function importBackupFile(file: Blob): Promise<ImportReport> {
  const text = await file.text()
  return importBackupText(text)
}

/** Короткая сводка отчёта — для сообщения пользователю. */
export function describeImport(report: ImportReport): string {
  const parts = [
    `идеи: +${report.ideas.added}, обновлено ${report.ideas.updated}, без изменений ${report.ideas.unchanged}`,
    `история: +${report.history.added}, без изменений ${report.history.unchanged}`,
    `направления: +${report.directions.added}, без изменений ${report.directions.unchanged}`,
  ]
  return parts.join('; ')
}

/** Имя и метка формата — для проверок в интерфейсе. */
export const EXPORT_FORMAT = BACKUP_FORMAT