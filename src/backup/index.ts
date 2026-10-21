/**
 * Точка входа блока «Копия идей».
 *
 * Интерфейс (App.svelte) знает только это:
 *   import { BackupPanel } from './backup'
 *
 * Разделение внутри:
 *   - `logic` — чистые решения (проверяются тестом в Node);
 *   - `store` — дата копии в `meta` и оценка размера архива;
 *   - `BackupPanel.svelte` — кнопки, выбор файла и сообщения.
 */

export { default as BackupPanel } from './BackupPanel.svelte'

export {
  BACKUP_META_KEY,
  BACKUP_REMINDER_DAYS,
  describeBackupError,
  describeBackupResult,
  readBackupMoment,
  shouldSuggestBackup,
} from './logic'

export { estimateArchiveBytes, readLastBackupAt, writeLastBackupAt } from './store'
