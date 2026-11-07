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
import {
  CryptoError,
  PBKDF2_ITERATIONS,
  checkKey,
  deriveKey,
  exportKeyBytes,
  importKeyBytes,
  makeKeyCheck,
  unwrapKeyBytes,
  wrapKeyBytes,
} from './crypto'

/** Ключи настроек в `meta`. Пароля среди них нет и быть не должно. */
export const VAULT_KEYS = {
  salt: 'server.salt',
  iterations: 'server.iterations',
  check: 'server.keycheck',
  recovery: 'server.recovery',
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
  // Извлекаемый ключ: его надо уметь обернуть кодом восстановления.
  const derived = await deriveKey(passphrase, undefined, iterations, true)
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

  const derived = await deriveKey(passphrase, fromBase64(saltRaw), iterations, true)
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
  await deleteMetaValue(VAULT_KEYS.recovery)
}

// --- Код восстановления -----------------------------------------------------
//
// ЗАЧЕМ. Забытый пароль сейчас означает «файлы на сервере навсегда».
// Код — вторая обёртка того же ключа: пароль и код открывают одно и то же,
// но хранятся по-разному. Код никуда не уходит; его человек сохраняет
// в менеджере паролей (iCloud Keychain, Google Password Manager) или на
// бумаге. Потерял и пароль, и код — данные не вернуть, это честно.
//
// ПОЧЕМУ 24 СИМВОЛА. Алфавит Crockford: 32 знака без похожих I/L/O/U,
// 24 знака = 120 бит. Перебирать бессмысленно, а вводить и копировать
// можно. Дефисы — только для чтения, в вычислениях их нет.

const RECOVERY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const RECOVERY_LENGTH = 24

/** Новый код: 24 знака без дефисов. */
export function generateRecoveryCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(RECOVERY_LENGTH))
  let code = ''
  for (const byte of bytes) code += RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length]
  return code
}

/** Для показа: группы по четыре через дефис. */
export function formatRecovery(code: string): string {
  const clean = normalizeRecovery(code)
  return clean.match(/.{1,4}/g)?.join('-') ?? clean
}

/**
 * Приводит ввод к каноническому виду.
 *
 * Люди путают O/0 и I/L/1 — Crockford это предусматривает. Регистр и
 * дефисы тоже не должны мешать.
 */
export function normalizeRecovery(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
}

/** Похоже ли на код: длина и алфавит. */
export function isRecoveryCode(input: string): boolean {
  const clean = normalizeRecovery(input)
  if (clean.length !== RECOVERY_LENGTH) return false
  for (const char of clean) {
    if (!RECOVERY_ALPHABET.includes(char)) return false
  }
  return true
}

/** Есть ли сохранённая обёртка ключа. */
export async function hasRecovery(): Promise<boolean> {
  const raw = await readMetaValue(VAULT_KEYS.recovery)
  if (typeof raw !== 'string') return false
  try {
    const record = JSON.parse(raw) as Record<string, unknown>
    return typeof record.wrapped === 'string' && record.wrapped !== ''
  } catch {
    return false
  }
}

/**
 * Создаёт код восстановления для ОТКРЫТОГО входа и возвращает его.
 *
 * Код показывается один раз. В `meta` лежит только обёртка ключа —
 * без кода её не открыть.
 */
export async function createRecovery(): Promise<string> {
  // Ключ запоминаем сразу: пока считаем PBKDF2, человек может нажать
  // «Закрыть», и sessionKey станет null.
  const key = sessionKey
  if (!key) {
    throw new CryptoError('locked', 'Сначала откройте вход — кода ещё нет.')
  }
  const code = generateRecoveryCode()
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const kek = (await deriveKey(code, salt, PBKDF2_ITERATIONS)).key
  const wrapped = await wrapKeyBytes(kek, await exportKeyBytes(key))
  await writeMetaValue(
    VAULT_KEYS.recovery,
    JSON.stringify({
      v: 1,
      salt: toBase64(salt),
      iterations: PBKDF2_ITERATIONS,
      wrapped: toBase64(wrapped),
    }),
  )
  return code
}

/**
 * Вход по коду. `false` — код не тот, вход не настроен или обёртка битая.
 *
 * Ключ после успеха живёт в памяти вкладки, как и после пароля.
 */
export async function unlockWithRecovery(input: string): Promise<boolean> {
  const raw = await readMetaValue(VAULT_KEYS.recovery)
  if (typeof raw !== 'string') return false

  const code = normalizeRecovery(input)
  if (!isRecoveryCode(code)) return false

  let record: Record<string, unknown>
  try {
    record = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return false
  }
  if (
    typeof record.salt !== 'string' ||
    typeof record.wrapped !== 'string' ||
    typeof record.iterations !== 'number'
  ) {
    return false
  }

  try {
    const kek = (await deriveKey(code, fromBase64(record.salt), record.iterations)).key
    const rawKey = await unwrapKeyBytes(kek, fromBase64(record.wrapped))
    const key = await importKeyBytes(rawKey)

    const checkRaw = await readMetaValue(VAULT_KEYS.check)
    if (typeof checkRaw !== 'string') return false
    if (!(await checkKey(key, fromBase64(checkRaw)))) return false

    sessionKey = key
    return true
  } catch {
    return false
  }
}

/** Забыть код (пароль остаётся). */
export async function forgetRecovery(): Promise<void> {
  await deleteMetaValue(VAULT_KEYS.recovery)
}
