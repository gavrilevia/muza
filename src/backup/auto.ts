/**
 * Автоматическая копия идей на сервер — зашифрованная.
 *
 * ЗАЧЕМ. Обещание «идея не теряется» пока держится на одном телефоне:
 * браузер может вытеснить IndexedDB, телефон — потеряться. Ручной zip
 * в «Ещё» есть, но о нём забывают. Эта копия делается сама, раз в сутки.
 *
 * ЧТО ИМЕННО УХОДИТ. Не файлы (они и так на сервере после переноса),
 * а вся база идей: идеи, направления, журнал, настройки, материалы
 * с распознанным текстом. Байты файлов в копию НЕ попадают: даже 240 МБ
 * в zip роняли вкладку на телефоне, а 3,8 ГБ — тем более.
 *
 * ПОЧЕМУ ШИФРУЕТСЯ. Копия — самый полный слепок жизни человека: идеи,
 * названия групп, история. Сервер не должен читать и её. Ключ тот же,
 * что у файлов, и на сервер не уходит.
 *
 * ЕСЛИ ВХОД ЗАКРЫТ ИЛИ НЕТ ПАРОЛЯ СЕРВЕРА — копия не делается. Это не
 * ошибка: значит, человек ещё не включил сервер. Ручная выгрузка работает.
 */

import { collectBackupData, importBackupBytes } from '../data/ExportService'
import { buildBackup, serializeBackup } from '../data/backup'
import type { ImportReport } from '../data'
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

  // Копия БЕЗ ФАЙЛОВ. Zip со всем медиа собирается в памяти: на телефоне
  // с 3,8 ГБ это падение вкладки (и именно оно вешало запуск). Идеи,
  // направления, история и настройки весят килобайты; сами файлы уже на
  // сервере, в материале остаётся `remote_id`.
  let archive: Blob
  try {
    const text = serializeBackup(buildBackup(data, now.toISOString()))
    archive = new Blob([new TextEncoder().encode(text)], { type: 'application/json' })
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


/** Итог восстановления из автоматической копии. */
export interface RestoreReport {
  ok: boolean
  reason: 'done' | 'none' | 'locked' | 'no_token' | 'download' | 'decrypt'
  /** Что именно восстановилось: идеи, история, направления. */
  report: ImportReport | null
}

/**
 * Скачивает последнюю автокопию, расшифровывает и вливает в базу.
 *
 * Вливание — существующий импорт zip: он умеет обновлять, не затирая
 * более новое. Поэтому восстановление не разрушает текущие данные.
 */
export async function restoreAutoBackup(
  options: {
    files?: ServerFiles
    key?: CryptoKey | null
    config?: { baseUrl: string; token: string }
  } = {},
): Promise<RestoreReport> {
  const key = options.key === undefined ? currentKey() : options.key
  if (!key) return { ok: false, reason: 'locked', report: null }

  const config = options.config ?? (await readServerConfig().catch(() => null))
  if (!config || config.token === '') return { ok: false, reason: 'no_token', report: null }

  const state = await readAutoBackupState()
  if (!state.remoteId) return { ok: false, reason: 'none', report: null }

  const files = options.files ?? new ServerFiles(config.baseUrl, config.token)
  let plain: Blob
  try {
    const encrypted = await files.download(state.remoteId)
    plain = await decryptBlob(encrypted, key)
  } catch {
    return { ok: false, reason: 'decrypt', report: null }
  }

  try {
    const bytes = new Uint8Array(await plain.arrayBuffer())
    const report = await importBackupBytes(bytes)
    return { ok: true, reason: 'done', report }
  } catch {
    return { ok: false, reason: 'decrypt', report: null }
  }
}
