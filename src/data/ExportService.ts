/**
 * ExportService — выгрузка и восстановление всей базы.
 *
 * Выгрузка — ОДИН zip-архив: читаемые JSON внутри плюс сырые файлы
 * `blobs/<material_id>` (состав и правила формата — в backup.ts).
 * Так копия переживает 240 МБ фото, голоса и видео, которые в base64
 * раздулись бы до ~320 МБ. Содержимое материалов не кодируется: байты
 * кладутся как есть.
 *
 * Импорт — слияние ПО ID, идемпотентное: повторный импорт того же архива
 * не создаёт дубликатов и не меняет данные. Журнал истории при этом только
 * дополняется (см. HistoryStore), а файл материала привязывается к записи
 * по `id` и не перетирает уже лежащий файл.
 *
 * Старый JSON-формат по-прежнему принимается: формат определяется по
 * содержимому файла (сигнатура zip), а не по расширению.
 *
 * Что НЕ попадает в копию и почему:
 *   - `queue` — очередь обработки привязана к устройству и пересоздаётся;
 *   - `vectors` — пересчитываемый индекс, место в файле только раздувает;
 *   - `events` — локальная аналитика этого устройства.
 *
 * Импорт пишет всё одной транзакцией: либо файл применился целиком, либо
 * база осталась прежней. Половинчатого состояния не бывает.
 */

import {
  BACKUP_FORMAT,
  backupFileName,
  buildBackup,
  buildBackupZip,
  looksLikeZip,
  parseBackup,
  parseBackupZip,
  serializeBackup,
} from './backup'
import type { ArchiveBytes, BackupData, BackupFile } from './backup'
import { req, withTx } from './db'
import {
  mergeDirections,
  mergeHistory,
  mergeIdeas,
  mergeMaterials,
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

/** Собирает файл резервной копии в памяти (без упаковки) — удобно для проверок. */
export async function buildBackupFile(at: Date = new Date()): Promise<BackupFile> {
  const data = await collectBackupData()
  return buildBackup(data, at.toISOString())
}

/**
 * Собирает zip-архив из базы. Асинхронная упаковка fflate не морозит
 * интерфейс, пока 240 МБ файлов складываются в архив.
 */
export async function buildBackupArchive(at: Date = new Date()): Promise<ArchiveBytes> {
  const data = await collectBackupData()
  return buildBackupZip(data, at.toISOString())
}

/** Собирает старый JSON-файл и отдаёт его текстом (файлы в него не попадают). */
export async function exportBackupText(at: Date = new Date()): Promise<string> {
  return serializeBackup(await buildBackupFile(at))
}

/**
 * Отдаёт готовый архив пользователю: браузер скачивает его как обычный файл.
 * Сеть не используется — файл собирается и сохраняется на устройстве.
 */
export function downloadBackup(bytes: ArchiveBytes, at: Date = new Date()): void {
  const blob = new Blob([bytes], { type: 'application/zip' })
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

/**
 * Собирает архив и сразу скачивает его. Возвращает байты архива: интерфейс
 * может показать размер и предупредить, если архив большой
 * (`archiveSizeWarning` из backup.ts).
 */
export async function exportBackup(at: Date = new Date()): Promise<ArchiveBytes> {
  const bytes = await buildBackupArchive(at)
  downloadBackup(bytes, at)
  return bytes
}

/**
 * Применяет разобранную копию к базе: слияние по id одной транзакцией.
 * Разбор файла идёт ДО транзакции: ждать чтение файла внутри транзакции нельзя.
 */
async function applyBackup(file: BackupFile): Promise<ImportReport> {
  return withTx(
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
      // Материалы: файл привязывается по id и заполняет пустое место,
      // уже лежащее содержимое не перетирается (см. preferIncomingMaterial).
      const materials = mergeMaterials(
        await req<Material[]>(materialStore.getAll()),
        file.materials,
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
}

/** Импортирует копию из байтов; формат (zip или старый JSON) — по содержимому. */
export async function importBackupBytes(bytes: Uint8Array): Promise<ImportReport> {
  const file = looksLikeZip(bytes)
    ? await parseBackupZip(bytes)
    : parseBackup(new TextDecoder().decode(bytes))
  return applyBackup(file)
}

/**
 * Импортирует старый JSON-файл по-прежнему: уже выгруженные копии
 * не должны пропасть. Файлы внутри JSON не переносились ещё до перехода
 * на zip, поэтому материал останется без содержимого.
 */
export async function importBackupText(text: string): Promise<ImportReport> {
  return applyBackup(parseBackup(text))
}

/** Импортирует копию из выбранного файла: zip или старый JSON. */
export async function importBackupFile(file: Blob): Promise<ImportReport> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  return importBackupBytes(bytes)
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
