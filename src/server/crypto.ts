/**
 * Шифрование файлов на устройстве — до того, как они уйдут на сервер.
 *
 * ЗАЧЕМ. Сервер хранит файлы в S3 и по замыслу не читает их. Но «не читает»
 * без шифрования — это обещание, а не свойство: у кого есть доступ к серверу,
 * тот прочитает. Здесь файл шифруется НА УСТРОЙСТВЕ, а на сервер уходят
 * нечитаемые байты. Ключ живёт у человека и на сервер не попадает никогда.
 *
 * ПОЧЕМУ ЧАСТЯМИ, А НЕ ЦЕЛИКОМ. `crypto.subtle` умеет шифровать только
 * буфер целиком: файл на 231 МБ потребовал бы столько же памяти на шифр
 * и ещё столько на результат. Телефон этого не переживёт. Поэтому файл
 * режется на куски по 4 МБ, каждый шифруется своим одноразовым ключом-
 * номером (nonce), и результат складывается в ОДИН контейнер.
 *
 * ЧТО ЗАЩИЩЕНО. AES-GCM даёт и тайну, и целостность: подмена байта
 * обнаруживается при расшифровке. К каждому куску дополнительно
 * привязывается ЗАГОЛОВОК, НОМЕР КУСКА и признак «последний» — иначе
 * куски можно было бы переставить местами или отрезать хвост, и файл
 * расшифровался бы «успешно», но не тот.
 *
 * ЧЕГО ЗДЕСЬ НЕТ. Экрана ввода пароля и хранения соли — это «вход»,
 * отдельная задача. Здесь только криптография и формат контейнера.
 */

/** Версия формата: растёт, если меняется раскладка контейнера. */
export const CRYPTO_VERSION = 1

/** Размер куска открытого текста. Меньше части сервера (8 МБ) намеренно. */
export const CHUNK_SIZE = 4 * 1024 * 1024

/** Метка контейнера: «это наш шифрованный файл», а не случайные байты. */
const MAGIC = new Uint8Array([0x4d, 0x55, 0x5a, 0x41]) // MUZA
/** Метка проверки пароля. */
const KEYCHECK_MAGIC = new Uint8Array([0x4d, 0x55, 0x5a, 0x41, 0x4b, 0x45, 0x59, 0x31]) // MUZAKEY1
/** Что шифруем для проверки пароля: 32 байта, ничего секретного. */
const KEYCHECK_PLAIN = new Uint8Array(32).fill(7)

/** Длина заголовка контейнера: метка, версия, флаги, размер куска, размер файла. */
export const HEADER_SIZE = 20
/** Длина одноразового номера AES-GCM. */
const IV_SIZE = 12
/** Длина метки целостности AES-GCM. */
const TAG_SIZE = 16
/** Сколько итераций PBKDF2 по умолчанию: медленно для подбора, терпимо для входа. */
export const PBKDF2_ITERATIONS = 600_000
/** Длина соли. */
export const SALT_SIZE = 16

/** Ключ вместе с солью: соль не секрет, но без неё ключ не восстановить. */
export interface DerivedKey {
  key: CryptoKey
  salt: Uint8Array
  iterations: number
}

/** Отказ шифрования или расшифровки с понятной причиной. */
export type CryptoErrorCode =
  | 'bad_passphrase'
  | 'not_encrypted'
  | 'damaged'
  | 'unsupported'
  | 'empty'

export class CryptoError extends Error {
  readonly code: CryptoErrorCode

  constructor(code: CryptoErrorCode, message: string) {
    super(message)
    this.name = 'CryptoError'
    this.code = code
  }
}

/** Запись числа в LE-порядке — одинаково на любой платформе. */
function writeUint32(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xff
  target[offset + 1] = (value >>> 8) & 0xff
  target[offset + 2] = (value >>> 16) & 0xff
  target[offset + 3] = (value >>> 24) & 0xff
}

function readUint32(source: Uint8Array, offset: number): number {
  return (
    (source[offset]! |
      (source[offset + 1]! << 8) |
      (source[offset + 2]! << 16) |
      (source[offset + 3]! << 24)) >>>
    0
  )
}

/** Размер файла до 8 байт: 2^53 хватит на любой файл, который бывает у человека. */
function writeUint64(target: Uint8Array, offset: number, value: number): void {
  let rest = Math.max(0, Math.floor(value))
  for (let i = 0; i < 8; i += 1) {
    target[offset + i] = rest % 256
    rest = Math.floor(rest / 256)
  }
}

function readUint64(source: Uint8Array, offset: number): number {
  let value = 0
  for (let i = 7; i >= 0; i -= 1) value = value * 256 + source[offset + i]!
  return value
}

/** Сколько всего байт займёт контейнер с таким файлом. */
export function containerSize(plaintextSize: number, chunkSize: number = CHUNK_SIZE): number {
  if (plaintextSize <= 0) return HEADER_SIZE
  const chunks = Math.ceil(plaintextSize / chunkSize)
  return HEADER_SIZE + plaintextSize + chunks * (IV_SIZE + TAG_SIZE)
}

/** Похоже ли на наш контейнер: метка и известная версия. */
export function isEncrypted(bytes: Uint8Array): boolean {
  if (bytes.length < HEADER_SIZE) return false
  for (let i = 0; i < MAGIC.length; i += 1) if (bytes[i] !== MAGIC[i]) return false
  return bytes[4] === CRYPTO_VERSION
}

/** Собирает заголовок контейнера. */
function buildHeader(plaintextSize: number, chunkSize: number): Uint8Array {
  const header = new Uint8Array(HEADER_SIZE)
  header.set(MAGIC, 0)
  header[4] = CRYPTO_VERSION
  header[5] = 0
  writeUint32(header, 6, chunkSize)
  writeUint64(header, 10, plaintextSize)
  return header
}

/**
 * Дополнительные данные куска: заголовок и НОМЕР куска.
 *
 * Номер обязателен: без него куски можно переставить местами, и файл
 * расшифруется «успешно», но не тот. Заголовок в тех же данных не даёт
 * подменить размер файла. Признак «последний» не нужен: обрезанный файл
 * ловится сверкой длины контейнера, а перестановка — номером.
 */
function chunkAad(header: Uint8Array, index: number): Uint8Array {
  const aad = new Uint8Array(header.length + 4)
  aad.set(header, 0)
  writeUint32(aad, header.length, index)
  return aad
}

/**
 * Ключ из пароля.
 *
 * PBKDF2 намеренно медленный: пароль человека короткий, и только цена
 * перебора защищает файлы. Соль хранится рядом с данными — она не секрет,
 * её задача в том, чтобы одинаковые пароли давали разные ключи.
 */
export async function deriveKey(
  passphrase: string,
  salt?: Uint8Array,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<DerivedKey> {
  if (passphrase.trim() === '') {
    throw new CryptoError('empty', 'Пустой пароль не защищает ничего.')
  }
  const usedSalt = salt ?? crypto.getRandomValues(new Uint8Array(SALT_SIZE))
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: usedSalt as BufferSource, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
  return { key, salt: usedSalt, iterations }
}

/** Шифрует один кусок. */
async function encryptChunk(
  key: CryptoKey,
  bytes: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_SIZE))
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as BufferSource, additionalData: aad as BufferSource },
      key,
      bytes as BufferSource,
    ),
  )
  const out = new Uint8Array(IV_SIZE + cipher.length)
  out.set(iv, 0)
  out.set(cipher, IV_SIZE)
  return out
}

/** Расшифровывает один кусок. Подмена или перестановка видна здесь. */
async function decryptChunk(
  key: CryptoKey,
  bytes: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  const iv = bytes.subarray(0, IV_SIZE)
  const body = bytes.subarray(IV_SIZE)
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv as BufferSource, additionalData: aad as BufferSource },
        key,
        body as BufferSource,
      ),
    )
  } catch {
    throw new CryptoError(
      'damaged',
      'Файл повреждён или пароль не тот: расшифровать не удалось.',
    )
  }
}

/** Настройки шифрования: размер куска и отчёт о ходе. */
export interface EncryptOptions {
  chunkSize?: number
  onProgress?: (done: number, total: number) => void
}

/**
 * Шифрует файл целиком, кусок за куском.
 *
 * Читаем по куску из исходного Blob и складываем шифрованные куски в новый
 * Blob: в памяти живёт один кусок, а не весь файл. Браузер держит большой
 * Blob на диске, поэтому 231 МБ проходят.
 */
export async function encryptBlob(
  blob: Blob,
  key: CryptoKey,
  options: EncryptOptions = {},
): Promise<Blob> {
  const chunkSize = options.chunkSize ?? CHUNK_SIZE
  const header = buildHeader(blob.size, chunkSize)
  const parts: BlobPart[] = [header as unknown as BlobPart]
  const total = Math.max(1, Math.ceil(blob.size / chunkSize))
  let done = 0

  for (let index = 0; index * chunkSize < blob.size; index += 1) {
    const start = index * chunkSize
    const end = Math.min(start + chunkSize, blob.size)
    const plain = new Uint8Array(await blob.slice(start, end).arrayBuffer())
    parts.push((await encryptChunk(key, plain, chunkAad(header, index))) as unknown as BlobPart)
    done += 1
    options.onProgress?.(done, total)
  }

  return new Blob(parts, { type: 'application/octet-stream' })
}

/**
 * Расшифровывает контейнер обратно в файл.
 *
 * Сначала проверяем заголовок и РАЗМЕР: если контейнер обрезан или к нему
 * дописано лишнее, дальше идти незачем — это ловит порчу раньше, чем
 * расшифровка.
 */
export async function decryptBlob(
  blob: Blob,
  key: CryptoKey,
  options: EncryptOptions = {},
): Promise<Blob> {
  if (blob.size < HEADER_SIZE) {
    throw new CryptoError('not_encrypted', 'Это не шифрованный файл «Музы».')
  }
  const header = new Uint8Array(await blob.slice(0, HEADER_SIZE).arrayBuffer())
  if (!isEncrypted(header)) {
    throw new CryptoError('not_encrypted', 'Это не шифрованный файл «Музы».')
  }
  const chunkSize = readUint32(header, 6)
  const plaintextSize = readUint64(header, 10)
  if (chunkSize <= 0 || plaintextSize < 0) {
    throw new CryptoError('unsupported', 'Заголовок файла непонятен.')
  }
  const expected = containerSize(plaintextSize, chunkSize)
  if (blob.size !== expected) {
    throw new CryptoError(
      'damaged',
      `Файл не той длины: ждали ${expected} байт, пришло ${blob.size}.`,
    )
  }

  const parts: BlobPart[] = []
  const total = Math.max(1, Math.ceil(plaintextSize / chunkSize))
  let offset = HEADER_SIZE
  let done = 0

  for (let index = 0; index * chunkSize < plaintextSize; index += 1) {
    const start = index * chunkSize
    const plainLength = Math.min(chunkSize, plaintextSize - start)
    const encryptedLength = IV_SIZE + plainLength + TAG_SIZE
    const bytes = new Uint8Array(await blob.slice(offset, offset + encryptedLength).arrayBuffer())
    parts.push((await decryptChunk(key, bytes, chunkAad(header, index))) as unknown as BlobPart)
    offset += encryptedLength
    done += 1
    options.onProgress?.(done, total)
  }

  return new Blob(parts, { type: 'application/octet-stream' })
}

/**
 * Проверка пароля: шифруем известные байты и кладём рядом.
 *
 * Нужна, чтобы «неверный пароль» говорить сразу при входе, а не после
 * попытки расшифровать первый файл. Секрета здесь нет: расшифровать
 * проверку можно только тем же ключом.
 */
export async function makeKeyCheck(key: CryptoKey): Promise<Uint8Array> {
  const aad = KEYCHECK_MAGIC
  const encrypted = await encryptChunk(key, KEYCHECK_PLAIN, aad)
  const out = new Uint8Array(KEYCHECK_MAGIC.length + encrypted.length)
  out.set(KEYCHECK_MAGIC, 0)
  out.set(encrypted, KEYCHECK_MAGIC.length)
  return out
}

/** Подходит ли ключ к сохранённой проверке. */
export async function checkKey(key: CryptoKey, check: Uint8Array): Promise<boolean> {
  if (check.length <= KEYCHECK_MAGIC.length) return false
  for (let i = 0; i < KEYCHECK_MAGIC.length; i += 1) {
    if (check[i] !== KEYCHECK_MAGIC[i]) return false
  }
  try {
    const plain = await decryptChunk(key, check.subarray(KEYCHECK_MAGIC.length), KEYCHECK_MAGIC)
    return plain.length === KEYCHECK_PLAIN.length && plain.every((byte) => byte === 7)
  } catch {
    return false
  }
}
