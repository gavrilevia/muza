/**
 * Перенос файла на сервер: зашифровать → загрузить частями → ПРОВЕРИТЬ →
 * только потом удалить локальную копию.
 *
 * ПОЧЕМУ ПРОВЕРКА ИМЕННО ТАК. Пользователь согласился: «после загрузки
 * скачать контейнер обратно и сверить». Сверяем не хешем, а расшифровкой
 * и побайтным сравнением — это строже: хеш доказывает, что байты те же,
 * а расшифровка ещё и что файл действительно откроется нашим ключом.
 * Память при этом не растёт: и шифрование, и сверка идут кусками.
 *
 * ЕСЛИ ЧТО-ТО НЕ ТАК, ЛОКАЛЬНАЯ КОПИЯ ОСТАЁТСЯ. Файл никогда не удаляется
 * «на всякий случай»: только после доказанной проверки.
 *
 * ЧЕГО ЗДЕСЬ НЕТ: пароля сервера в интерфейсе (поле в `VaultPanel`) и
 * показа файла с сервера в просмотрщике — это следующие шаги.
 */

import { materialRepository, type Material } from '../data'
import { readMetaValue, writeMetaValue } from '../directions/meta'
import { decryptBlob, encryptBlob } from './crypto'
import { SERVER_BASE_URL, ServerFileError, ServerFiles } from './files'
import { currentKey } from './vault'

/** Ключи настроек сервера. */
export const SERVER_KEYS = {
  url: 'server.url',
  token: 'server.token',
} as const

/** Куда и с каким паролем ходить. */
export interface ServerConfig {
  baseUrl: string
  /** Пароль приложения (`MUZA_TOKEN`). Пустая строка — сервер его не требует. */
  token: string
}

/** Настройки сервера из хранилища; адрес по умолчанию — прод. */
export async function readServerConfig(): Promise<ServerConfig> {
  const [url, token] = await Promise.all([
    readMetaValue(SERVER_KEYS.url).catch(() => undefined),
    readMetaValue(SERVER_KEYS.token).catch(() => undefined),
  ])
  return {
    baseUrl: typeof url === 'string' && url.trim() !== '' ? url.trim() : SERVER_BASE_URL,
    token: typeof token === 'string' ? token.trim() : '',
  }
}

/** Сохраняет настройки. `undefined` — не трогать поле. */
export async function writeServerConfig(patch: Partial<ServerConfig>): Promise<ServerConfig> {
  if (patch.baseUrl !== undefined) {
    const clean = patch.baseUrl.trim()
    if (clean === '') await writeMetaValue(SERVER_KEYS.url, null)
    else await writeMetaValue(SERVER_KEYS.url, clean)
  }
  if (patch.token !== undefined) {
    await writeMetaValue(SERVER_KEYS.token, patch.token.trim())
  }
  return readServerConfig()
}

/** Чем закончился перенос одного файла. */
export type OffloadCode =
  | 'ok'
  | 'no_blob'
  | 'locked'
  | 'no_token'
  | 'too_big'
  | 'upload'
  | 'verify'
  | 'storage'

/** Итог переноса: код и фраза для человека. */
export interface OffloadOutcome {
  ok: boolean
  materialId: string
  code: OffloadCode
  reason: string
  /** Ссылка на сервере, если получилось. */
  remoteId: string | null
  /** Материал после обновления (локальной копии уже нет). */
  material: Material | null
}

/** Настройки одного переноса: всё подменяемо для проверок. */
export interface OffloadOptions {
  files?: ServerFiles
  /** Ключ шифрования. `null` — вход закрыт. */
  key?: CryptoKey | null
  config?: ServerConfig
  now?: Date
  /** Обновлять запись в базе (в проверках можно выключить). */
  persist?: boolean
}

/** Сколько читаем за раз при сверке: столько же, сколько кусок шифра. */
const COMPARE_STEP = 4 * 1024 * 1024

/**
 * Совпадают ли два файла побайтно, кусками.
 *
 * Не `arrayBuffer()` целиком: файл на 231 МБ не должен занимать столько же
 * памяти ещё раз.
 */
export async function sameBytes(left: Blob, right: Blob): Promise<boolean> {
  if (left.size !== right.size) return false
  for (let offset = 0; offset < left.size; offset += COMPARE_STEP) {
    const a = new Uint8Array(await left.slice(offset, offset + COMPARE_STEP).arrayBuffer())
    const b = new Uint8Array(await right.slice(offset, offset + COMPARE_STEP).arrayBuffer())
    if (a.length !== b.length) return false
    for (let index = 0; index < a.length; index += 1) {
      if (a[index] !== b[index]) return false
    }
  }
  return true
}

/**
 * Переносит один материал на сервер.
 *
 * Никогда не бросает: любой сбой — это исход с кодом. Локальная копия
 * удаляется ТОЛЬКО после успешной сверки.
 */
export async function offloadMaterial(
  material: Material,
  options: OffloadOptions = {},
): Promise<OffloadOutcome> {
  const fail = (code: OffloadCode, reason: string): OffloadOutcome => ({
    ok: false,
    materialId: material.id,
    code,
    reason,
    remoteId: null,
    material: null,
  })

  if (material.remote_id) {
    return {
      ok: true,
      materialId: material.id,
      code: 'ok',
      reason: 'Файл уже на сервере.',
      remoteId: material.remote_id,
      material,
    }
  }
  if (!material.blob) return fail('no_blob', 'Локальной копии нет — переносить нечего.')

  const key = options.key === undefined ? currentKey() : options.key
  if (!key) {
    return fail('locked', 'Вход закрыт: откройте его в «Ещё», чтобы отправить файл на сервер.')
  }

  const config = options.config ?? (await readServerConfig().catch(() => null))
  if (!config) return fail('storage', 'Настройки сервера не прочитались.')
  if (config.token === '') {
    return fail('no_token', 'Не задан пароль сервера — файл остался на телефоне.')
  }

  const files = options.files ?? new ServerFiles(config.baseUrl, config.token)
  const now = options.now ?? new Date()

  let encrypted: Blob
  try {
    encrypted = await encryptBlob(material.blob, key)
  } catch (e) {
    return fail('verify', `Не удалось зашифровать: ${describe(e)}`)
  }

  let uploaded: { id: string; size: number }
  try {
    uploaded = await files.upload(encrypted)
  } catch (e) {
    return fail('upload', uploadReason(e))
  }

  // ПРОВЕРКА: скачиваем обратно, расшифровываем и сравниваем побайтно.
  try {
    const downloaded = await files.download(uploaded.id)
    const decrypted = await decryptBlob(downloaded, key)
    if (!(await sameBytes(material.blob, decrypted))) {
      await files.abort(uploaded.id).catch(() => {})
      return fail('verify', 'Скачанный файл не совпал с оригиналом — копия на телефоне оставлена.')
    }
  } catch (e) {
    await files.abort(uploaded.id).catch(() => {})
    return fail('verify', `Проверка не прошла: ${describe(e)}`)
  }

  if (options.persist === false) {
    return {
      ok: true,
      materialId: material.id,
      code: 'ok',
      reason: 'Загружено и проверено.',
      remoteId: uploaded.id,
      material: null,
    }
  }

  try {
    const updated = await materialRepository.update(material.id, {
      remote_id: uploaded.id,
      remote_size: uploaded.size,
      remote_at: now.toISOString(),
      // Локальную копию убираем ТОЛЬКО сейчас, после проверки.
      blob: null,
    })
    return {
      ok: true,
      materialId: material.id,
      code: 'ok',
      reason: 'Файл на сервере, проверен; копия на телефоне убрана.',
      remoteId: uploaded.id,
      material: updated,
    }
  } catch (e) {
    return fail('storage', `Не удалось записать ссылку: ${describe(e)}`)
  }
}

/**
 * Переносит все подходящие материалы пачки.
 *
 * Идём по одному: сервер и телефон не любят десять загрузок разом.
 */
export async function offloadMaterials(
  materials: readonly Material[],
  options: OffloadOptions = {},
): Promise<OffloadOutcome[]> {
  const outcomes: OffloadOutcome[] = []
  for (const material of materials) {
    outcomes.push(await offloadMaterial(material, options))
  }
  return outcomes
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Пояснение к отказу загрузки: по коду видно, что делать человеку. */
function uploadReason(error: unknown): string {
  if (error instanceof ServerFileError) {
    if (error.code === 'unauthorized') return 'Сервер не принял пароль — проверьте его в настройках.'
    if (error.code === 'too_large') return 'Файл слишком большой для сервера.'
    if (error.code === 'network') return 'Связь с сервером оборвалась — копия осталась на телефоне.'
    return error.message
  }
  return `Загрузка не удалась: ${describe(error)}`
}
