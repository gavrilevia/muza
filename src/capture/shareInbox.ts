/**
 * Приём того, чем с приложением поделились (Web Share Target, Android).
 *
 * Почему через Cache API: `share_target` по спецификации отправляет POST, а
 * статический хостинг POST не принимает. Поэтому POST перехватывает Service
 * Worker (см. `public/sw.js`): он раскладывает поля и файлы в кэш-«входящие»
 * и перенаправляет приложение на `?share=1`. Здесь страница забирает
 * входящие и превращает их в обычный запрос захвата.
 *
 * Входящие не удаляются до успешного сохранения: если запись не удалась,
 * они останутся и попробуются снова при следующем открытии. Так «Поделиться»
 * не теряет то, чем поделились.
 */

import { asCaptureFile, shareReturnState, splitSharedFields } from './logic'
import type { SharedFields } from './logic'
import type { CaptureFile } from './types'

/** Имя кэша-«входящих»; то же значение продублировано в public/sw.js. */
export const SHARE_CACHE = 'muza-share-v1'
/** Ключ с описанием того, чем поделились. Путь относительный — тот же, что в sw.js. */
const PAYLOAD_KEY = './__share__/payload'

/** Разобранные входящие: поля и файлы. */
export interface ShareHandoff extends SharedFields {
  files: CaptureFile[]
}

interface SharePayloadFile {
  key: string
  name: string
  type: string
  size: number
}

interface SharePayload {
  fields?: Record<string, unknown>
  files?: SharePayloadFile[]
}

/** Кэш-«входящие», если браузер вообще умеет Cache API. */
async function openShareCache(): Promise<Cache | null> {
  if (typeof caches === 'undefined') return null
  try {
    return await caches.open(SHARE_CACHE)
  } catch {
    return null
  }
}

/**
 * Разобранные входящие этого сеанса.
 *
 * Ответ из кэша можно прочитать один раз: тело у него одноразовое. Поэтому
 * держим разобранное в памяти и повторный вызов отдаёт то же самое, а не
 * пытается читать тело второй раз (иначе входящие показались бы пустыми).
 */
let handoffRead = false
let handoffCache: ShareHandoff | null = null

/**
 * Читает входящие, не удаляя их.
 * `null` — делиться никто не пытался (или входящие повреждены).
 */
export async function peekSharedHandoff(): Promise<ShareHandoff | null> {
  if (handoffRead) return handoffCache

  const cache = await openShareCache()
  if (!cache) return null

  let payload: SharePayload
  try {
    const response = await cache.match(PAYLOAD_KEY)
    if (!response) return null
    payload = JSON.parse(await response.text()) as SharePayload
  } catch {
    // Не прочиталось — входящие НЕ удаляем: пусть попробуются в следующий раз.
    return null
  }

  const files: CaptureFile[] = []
  for (const meta of payload.files ?? []) {
    try {
      const response = await cache.match(meta.key)
      if (!response) continue
      const blob = await response.blob()
      files.push(asCaptureFile(blob, meta.name, meta.type || blob.type))
    } catch {
      /* один файл не прочитался — остальные всё равно берём */
    }
  }

  const fields = splitSharedFields(payload.fields ?? {})
  handoffRead = true
  handoffCache = { ...fields, files }
  return handoffCache
}

/** Есть ли что принимать (в том числе после перезагрузки страницы). */
export async function hasSharedHandoff(): Promise<boolean> {
  if (handoffRead) return handoffCache !== null
  const cache = await openShareCache()
  if (!cache) return false
  try {
    return (await cache.match(PAYLOAD_KEY)) !== undefined
  } catch {
    return false
  }
}

/** Убирает входящие: вызывается только после успешного сохранения. */
export async function clearSharedHandoff(): Promise<void> {
  handoffRead = true
  handoffCache = null
  const cache = await openShareCache()
  if (!cache) return
  try {
    const keys = await cache.keys()
    await Promise.all(keys.map((key) => cache.delete(key)))
  } catch {
    /* не удалилось — не страшно: перезапишется при следующем «Поделиться» */
  }
}

/**
 * Нужно ли вообще смотреть входящие: SW вернул `?share=1`, либо в кэше
 * что-то лежит с прошлого раза (например, сохранение тогда не удалось).
 */
export async function shouldAcceptShare(search: string): Promise<boolean> {
  if (shareReturnState(search) !== 'none') return true
  return hasSharedHandoff()
}
