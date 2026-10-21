/**
 * Чистые решения блока «Копия идей»: напоминание, разбор ошибок, итог импорта.
 *
 * Здесь нет ни DOM, ни IndexedDB — поэтому всё это проверяется Node-тестом.
 * Работа с хранилищем `meta` и оценка размера архива живут в `store.ts`,
 * кнопки и сообщения — в `BackupPanel.svelte`.
 *
 * Формат и разбор копии уже написаны в `src/data` (backup.ts, ExportService.ts)
 * и здесь не переписываются: мы только решаем, что показать человеку.
 */

import { BackupParseError, describeImport } from '../data'
import type { ImportReport } from '../data'

/** Ключ в хранилище `meta`: когда копию сохраняли в последний раз. */
export const BACKUP_META_KEY = 'backup.last_saved_at'

/** Через сколько дней без копии о ней уместно напомнить. */
export const BACKUP_REMINDER_DAYS = 30

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Момент последней копии из значения `meta`.
 *
 * Принимает ISO-строку (мы пишем именно её), число и `Date` — так решение
 * о напоминании не зависит от того, что именно ему передали. `null` —
 * значения нет или оно непонятно, и это такой же повод напомнить, как
 * отсутствие копии.
 */
export function readBackupMoment(value: unknown): number | null {
  if (value instanceof Date) {
    const time = value.getTime()
    return Number.isFinite(time) ? time : null
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/**
 * Пора ли тихо напомнить о копии.
 *
 * Правило продукта: напоминание не создаёт чувства долга и не ставит задач.
 * Поэтому это только решение «показать спокойную строку», без срочности:
 * копии не было ни разу — да; прошло больше 30 дней — да; иначе — нет.
 * Дата из будущего (часы перевели) напоминанием не считается.
 */
export function shouldSuggestBackup(lastSavedAt: unknown, now: Date = new Date()): boolean {
  const moment = readBackupMoment(lastSavedAt)
  if (moment === null) return true
  const age = now.getTime() - moment
  if (age < 0) return false
  return age > BACKUP_REMINDER_DAYS * DAY_MS
}

/**
 * Человеческий текст ошибки импорта вместо исключения.
 *
 * `BackupParseError` уже несёт понятную русскую фразу (чужой файл, битый
 * архив, более новая схема) — её и показываем. Остальное заворачиваем
 * в спокойную формулировку, не теряя причину.
 */
export function describeBackupError(error: unknown): string {
  if (error instanceof BackupParseError) return error.message

  const name =
    error && typeof error === 'object' ? (error as { name?: unknown }).name : undefined
  if (name === 'QuotaExceededError') {
    return 'В хранилище не хватило места для восстановления. Освободите место и попробуйте снова.'
  }
  if (error instanceof Error && error.message.trim() !== '') {
    return `Не удалось восстановить копию: ${error.message}`
  }
  return 'Не удалось восстановить копию: файл повреждён или это не копия «Музы».'
}

/**
 * Итог импорта для экрана: сначала своими словами — сколько добавилось и
 * сколько осталось без изменений, затем подробная сводка `describeImport`.
 */
export function describeBackupResult(report: ImportReport): string {
  const { added, unchanged } = report.ideas
  const head =
    added === 0
      ? 'Копия уже была в базе — новых идей не появилось.'
      : `Копия восстановлена. Новых идей: ${added}.`
  return `${head} Без изменений: ${unchanged}. ${describeImport(report)}`
}
