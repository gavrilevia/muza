/**
 * Вход: пароль человека превращается в ключ, которым шифруются файлы.
 *
 * ЧТО ХРАНИТСЯ, А ЧТО НЕТ.
 *   - хранится: соль, число итераций и «проверка пароля» — по ним ключ
 *     восстанавливается из пароля при следующем входе;
 *   - НЕ хранится: сам пароль и сам ключ. Ключ живёт только в памяти
 *     вкладки: перезагрузил страницу — вводи пароль снова. Это неудобно,
 *     но это единственный способ, при котором «ключ у человека» — правда,
 *     а не обещание.
 *
 * ПОЧЕМУ ПРОВЕРКА ОТДЕЛЬНО. Без неё неверный пароль выяснялся бы только
 * при попытке открыть первый файл — то есть после загрузки и расшифровки.
 * Проверка — это те же байты, зашифрованные ключом: расшифровать их может
 * только правильный пароль.
 *
 * ЧТО БУДЕТ, ЕСЛИ ПАРОЛЬ ЗАБЫТ. Ничего хорошего: файлы на сервере останутся
 * зашифрованными навсегда. Поэтому «забыть пароль» — отдельное действие
 * с предупреждением, а не тихая кнопка.
 */

import { deleteMetaValue, readMetaValue, writeMetaValue } from '../directions/meta'
import { PBKDF2_ITERATIONS, checkKey, deriveKey, makeKeyCheck } from './crypto'

/** Ключи настроек в `meta`. Пароля среди них нет и быть не должно. */
export const VAULT_KEYS = {
  salt: 'server.salt',
  iterations: 'server.iterations',
  check: 'server.keycheck',
} as const

/** Состояние входа: ещё не настроен, настроен но закрыт, открыт в этой вкладке. */
export type VaultState = 'none' | 'locked' | 'unlocked'

/** Ключ этой вкладки. `null` — закрыто. */
let sessionKey: CryptoKey | null = null

/** Байты в base64: в `meta` удобнее строка, чем массив чисел. */
function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** Ключ текущей вкладки или `null`. */
export function currentKey(): CryptoKey | null {
  return sessionKey
}

/** Закрывает вход: ключ стирается из памяти. */
export function lockVault(): void {
  sessionKey = null
}

/** Настроен ли вход вообще (есть соль и проверка). */
export async function hasVault(): Promise<boolean> {
  const salt = await readMetaValue(VAULT_KEYS.salt)
  const check = await readMetaValue(VAULT_KEYS.check)
  return typeof salt === 'string' && salt !== '' && typeof check === 'string' && check !== ''
}

/** Что сейчас: не настроен, закрыт или открыт. */
export async function vaultState(): Promise<VaultState> {
  if (sessionKey) return 'unlocked'
  return (await hasVault()) ? 'locked' : 'none'
}

/**
 * Первый вход: создаёт соль и проверку, ключ оставляет в памяти.
 *
 * `iterations` можно задать только в проверках: в жизни всегда значение
 * по умолчанию, иначе защита от подбора слабеет молча.
 */
export async function createVault(
  passphrase: string,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<void> {
  const derived = await deriveKey(passphrase, undefined, iterations)
  const check = await makeKeyCheck(derived.key)
  await writeMetaValue(VAULT_KEYS.salt, toBase64(derived.salt))
  await writeMetaValue(VAULT_KEYS.iterations, iterations)
  await writeMetaValue(VAULT_KEYS.check, toBase64(check))
  sessionKey = derived.key
}

/**
 * Вход по паролю. `false` — пароль не тот (или вход не настроен).
 *
 * Число итераций берём СОХРАНЁННОЕ: если однажды его поднимут, старые
 * файлы должны открываться старым ключом, а не «новым по умолчанию».
 */
export async function unlockVault(passphrase: string): Promise<boolean> {
  const saltRaw = await readMetaValue(VAULT_KEYS.salt)
  const checkRaw = await readMetaValue(VAULT_KEYS.check)
  if (typeof saltRaw !== 'string' || typeof checkRaw !== 'string') return false
  const iterationsRaw = await readMetaValue(VAULT_KEYS.iterations)
  const iterations =
    typeof iterationsRaw === 'number' && Number.isFinite(iterationsRaw) && iterationsRaw > 0
      ? iterationsRaw
      : PBKDF2_ITERATIONS

  const derived = await deriveKey(passphrase, fromBase64(saltRaw), iterations)
  const ok = await checkKey(derived.key, fromBase64(checkRaw))
  if (!ok) return false
  sessionKey = derived.key
  return true
}

/**
 * Забыть пароль: стирает соль и проверку.
 *
 * После этого вход настраивается заново, но СТАРЫЕ файлы на сервере уже
 * не открыть — ключа от них не осталось нигде. Поэтому вызывать только
 * после явного согласия человека.
 */
export async function forgetVault(): Promise<void> {
  sessionKey = null
  await deleteMetaValue(VAULT_KEYS.salt)
  await deleteMetaValue(VAULT_KEYS.iterations)
  await deleteMetaValue(VAULT_KEYS.check)
}
