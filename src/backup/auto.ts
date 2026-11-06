/**
 * Автоматическая копия идей на сервер — зашифрованная.
 *
 * ЗАЧЕМ. Обещание «идея не теряется» пока держится на одном телефоне:
 * браузер может вытеснить IndexedDB, телефон — потеряться. Ручной zip
 * в «Ещё» есть, но о нём забывают. Эта копия делается сама, раз в сутки.
 *
 * ЧТО ИМЕННО УХОДИТ. Не файлы (они и так на сервере после переноса),
 * а вся база идей: идеи, направления, журнал, настройки, материалы
 * с распознанным текстом. Файлы, которые ещё лежат на телефоне, попадают
 * в zip как обычно — то есть копия самодостаточна, пока перенос не сделан.
 *
 * ПОЧЕМУ ШИФРУЕТСЯ. Копия — самый полный слепок жизни человека: идеи,
 * названия групп, история. Сервер не должен читать и её. Ключ тот же,
 * что у файлов, и на сервер не уходит.
 *
 * ЕСЛИ ВХОД ЗАКРЫТ ИЛИ НЕТ ПАРОЛЯ СЕРВЕРА — копия не делается. Это не
 * ошибка: значит, человек ещё не включил сервер. Ручная выгрузка работает.
 */

import { collectBackupData } from '../data/ExportService'
import { buildBackupZip } from '../data/backup'
import { readMetaValue, writeMetaValue } from '../directions/meta'
import { decryptBlob, encryptBlob } from '../server/crypto'
import { readServerConfig, sameBytes } from '../server/offload'
import { ServerFiles } from '../server/files'
import { currentKey } from '../server/vault'

/** Как часто делаем автоматическую копию. */
export const AUTO_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000

/** Ключи состояния в `meta`. */
export const AUTO_BACKUP_KEYS = {
  lastAt: 'backup.auto.last_at',
  remoteId: 'backup.auto.remote_id',
  size: 'backup.auto.size',
} as const

/** Что знаем про последнюю автоматическую копию. */
export interface AutoBackupState {
  lastAt: string | null
  remoteId: string | null
  size: number | null
}

/** Читает состояние копии. Битое значение — «копии не было». */
export async function readAutoBackupState(): Promise<AutoBackupState> {
  const [lastAt, remoteId, size] = await Promise.all([
    readMetaValue(AUTO_BACKUP_KEYS.lastAt).catch(() => undefined),
    readMetaValue(AUTO_BACKUP_KEYS.remoteId).catch(() => undefined),
    readMetaValue(AUTO_BACKUP_KEYS.size).catch(() => undefined),
  ])
  return {
    lastAt: typeof lastAt === 'string' ? lastAt : null,
    remoteId: typeof remoteId === 'string' ? remoteId : null,
    size: typeof size === 'number' && Number.isFinite(size) ? size : null,
  }
}

/** Чем закончилась попытка. */
export type AutoBackupReason =
  | 'done'
  | 'too_soon'
  | 'locked'
  | 'no_token'
  | 'empty'
  | 'upload'
  | 'verify'
  | 'storage'

/** Итог: код, ссылка и размер. */
export interface AutoBackupReport {
  ran: boolean
  reason: AutoBackupReason
  remoteId: string | null
  size: number | null
  /** Сколько идей попало в копию (для журнала и проверок). */
  ideas: number
}

/** Настройки одной попытки: всё подменяемо. */
export interface AutoBackupOptions {
  now?: Date
  files?: ServerFiles
  key?: CryptoKey | null
  config?: { baseUrl: string; token: string }
  /** Сколько идей минимум считать содержимым (0 — копируем и пустую базу). */
  minIdeas?: number
}

/**
 * Одна попытка автоматической копии.
 *
 * Никогда не бросает: сбой копии не должен ломать открытие приложения.
 * Дату успеха пишем только после проверки — иначе «копия сделана» была бы
 * ложью, и следующий запуск пропустил бы сутки.
 */
let inFlight: Promise<AutoBackupReport> | null = null

/**
 * Одна попытка, но не две одновременно.
 *
 * Копия запускается и при открытии, и сразу после разблокировки — без
 * этой защиты два запуска могли бы собрать и загрузить архив дважды.
 */
export function runAutoBackup(options: AutoBackupOptions = {}): Promise<AutoBackupReport> {
  if (inFlight) return inFlight
  const run = runAutoBackupOnce(options).finally(() => {
    inFlight = null
  })
  inFlight = run
  return run
}

async function runAutoBackupOnce(options: AutoBackupOptions = {}): Promise<AutoBackupReport> {
  const now = options.now ?? new Date()
  const fail = (reason: AutoBackupReason): AutoBackupReport => ({
    ran: false,
    reason,
    remoteId: null,
    size: null,
    ideas: 0,
  })

  const key = options.key === undefined ? currentKey() : options.key
  if (!key) return fail('locked')

  const config = options.config ?? (await readServerConfig().catch(() => null))
  if (!config || config.token === '') return fail('no_token')

  const state = await readAutoBackupState()
  if (state.lastAt) {
    const last = new Date(state.lastAt).getTime()
    if (Number.isFinite(last) && now.getTime() - last < AUTO_BACKUP_INTERVAL_MS) {
      return fail('too_soon')
    }
  }

  // Собираем копию: данные → zip → шифр.
  let data
  try {
    data = await collectBackupData()
  } catch {
    return fail('storage')
  }
  if (data.ideas.length === 0 && (options.minIdeas ?? 0) > 0) return fail('empty')

  let archive: Blob
  try {
    const bytes = await buildBackupZip(data, now.toISOString())
    archive = new Blob([bytes], { type: 'application/zip' })
  } catch {
    return fail('storage')
  }

  const files = options.files ?? new ServerFiles(config.baseUrl, config.token)

  let encrypted: Blob
  try {
    encrypted = await encryptBlob(archive, key)
  } catch {
    return fail('storage')
  }

  let uploaded: { id: string; size: number }
  try {
    uploaded = await files.upload(encrypted)
  } catch {
    return fail('upload')
  }

  // ПРОВЕРКА: скачиваем и расшифровываем обратно. Копия, которую нельзя
  // открыть, — хуже отсутствия копии: она создаёт ложную уверенность.
  try {
    const downloaded = await files.download(uploaded.id)
    const decrypted = await decryptBlob(downloaded, key)
    if (!(await sameBytes(archive, decrypted))) {
      await files.abort(uploaded.id).catch(() => {})
      return fail('verify')
    }
  } catch {
    await files.abort(uploaded.id).catch(() => {})
    return fail('verify')
  }

  await writeMetaValue(AUTO_BACKUP_KEYS.lastAt, now.toISOString())
  await writeMetaValue(AUTO_BACKUP_KEYS.remoteId, uploaded.id)
  await writeMetaValue(AUTO_BACKUP_KEYS.size, uploaded.size)

  return {
    ran: true,
    reason: 'done',
    remoteId: uploaded.id,
    size: uploaded.size,
    ideas: data.ideas.length,
  }
}
