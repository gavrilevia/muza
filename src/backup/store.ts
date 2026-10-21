/**
 * Работа блока копии с хранилищем: дата последней копии в `meta` и оценка
 * размера архива до его сборки.
 *
 * Схему данных не трогаем: `meta` — существующее хранилище, и настройки ИИ
 * уже живут в нём (см. `src/ai/config.ts`). Дате копии там же и место:
 * localStorage для данных приложения не используется.
 */

import { getAll, req, withTx } from '../data'
import type { Material, MetaRecord } from '../data'
import { BACKUP_META_KEY, readBackupMoment } from './logic'

/** Дата последней сохранённой копии; `null` — копию ещё не сохраняли. */
export async function readLastBackupAt(): Promise<Date | null> {
  const record = await withTx('meta', 'readonly', (tx) =>
    req<MetaRecord | undefined>(tx.objectStore('meta').get(BACKUP_META_KEY)),
  )
  const moment = readBackupMoment(record?.value)
  return moment === null ? null : new Date(moment)
}

/** Запоминает, когда копию сохранили. Значение — ISO-строка, как везде. */
export async function writeLastBackupAt(at: Date): Promise<void> {
  const record: MetaRecord = {
    key: BACKUP_META_KEY,
    value: at.toISOString(),
    updated_at: new Date().toISOString(),
  }
  await withTx('meta', 'readwrite', (tx) => {
    tx.objectStore('meta').put(record)
  })
}

/**
 * Оценка размера будущего архива до начала сборки.
 *
 * Файлы материалов едут в zip сырыми байтами (без сжатия), JSON почти
 * невесом, поэтому сумма размеров вложений — честная нижняя оценка.
 * Её хватает, чтобы предупредить о большом архиве заранее; предупреждение
 * ничего не блокирует (`archiveSizeWarning` из data/backup.ts).
 */
export async function estimateArchiveBytes(): Promise<number> {
  const materials = await getAll<Material>('materials')
  let bytes = 0
  for (const material of materials) {
    if (material.blob) bytes += material.blob.size
  }
  return bytes
}
