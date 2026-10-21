/**
 * ULID своими силами, без зависимостей.
 *
 * Формат: 26 символов Crockford base32 (алфавит без I, L, O, U — чтобы буквы
 * не путались с цифрами).
 *   - первые 10 символов — время в миллисекундах (48 бит), поэтому строки
 *     сортируются лексикографически ровно так же, как по времени;
 *   - последние 16 символов — 80 бит случайности из crypto.getRandomValues.
 *
 * Монотонность: если за одну миллисекунду запросили несколько идентификаторов,
 * время не меняется, а случайная часть инкрементируется как 80-битное число.
 * Тогда `ulid(t1) < ulid(t2)` при `t1 <= t2`, и ключи не сталкиваются даже
 * при пакетной записи тысячи идей. Если случайная часть переполнилась
 * (практически невозможно при 80 битах), берём следующую миллисекунду.
 * Если часы устройства ушли назад, время не откатывается: монотонность
 * важнее точного совпадения с системными часами.
 */

/** Алфавит Crockford base32: 32 символа, без I, L, O, U. */
export const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** Длина ULID в символах. */
export const ULID_LENGTH = 26

/** Сколько символов занимает время. */
const TIME_CHARS = 10

/** Сколько символов занимает случайная часть. */
const RANDOM_CHARS = 16

/** Максимальное время, представимое 48 битами: 10889 год. */
const MAX_TIME = 281474976710655

/** Регулярное выражение для проверки ULID (26 символов алфавита Crockford). */
const ULID_RE = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/

/** Последнее выданное время — для монотонности. */
let lastTime = -1

/** Последняя выданная случайная часть — инкрементируется в пределах миллисекунды. */
let lastRandom: Uint8Array | null = null

/** Кодирует миллисекунды в 10 символов Crockford base32 (старшие разряды впереди). */
function encodeTime(time: number): string {
  let rest = Math.floor(time)
  const out = new Array<string>(TIME_CHARS)
  for (let i = TIME_CHARS - 1; i >= 0; i--) {
    out[i] = CROCKFORD[rest % 32]
    rest = Math.floor(rest / 32)
  }
  return out.join('')
}

/**
 * Кодирует байты в символы Crockford base32, читая поток битов слева направо.
 * 10 байт = 80 бит = ровно 16 символов по 5 бит.
 */
function encodeBytes(bytes: Uint8Array): string {
  let value = 0
  let bits = 0
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i]
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += CROCKFORD[(value >>> bits) & 31]
      value &= (1 << bits) - 1
    }
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31]
  return out
}

/** Новые 80 бит случайности. */
function randomBytes(): Uint8Array {
  const bytes = new Uint8Array(10)
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes)
    return bytes
  }
  // Запасной путь: crypto нет (очень старый браузер или урезанное окружение).
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  return bytes
}

/**
 * Инкрементирует 80-битное число (байты от старшего к младшему) на единицу.
 * Возвращает false при переполнении.
 */
function increment(bytes: Uint8Array): boolean {
  for (let i = bytes.length - 1; i >= 0; i--) {
    if (bytes[i] < 0xff) {
      bytes[i]++
      return true
    }
    bytes[i] = 0
  }
  return false
}

/**
 * Возвращает новый ULID. Всегда уникален, всегда монотонен
 * (следующий больше предыдущего).
 *
 * @param now время в миллисекундах; параметр нужен для тестов
 */
export function ulid(now: number = Date.now()): string {
  let time = Math.floor(now)
  if (!Number.isFinite(time) || time < 0) time = 0
  if (time > MAX_TIME) time = MAX_TIME

  let random: Uint8Array

  if (time === lastTime && lastRandom) {
    // Та же миллисекунда: продолжаем нумерацию, а не бросаем новые кости.
    random = lastRandom
    if (!increment(random)) {
      // 80 бит randomness исчерпаны — уходим на следующую миллисекунду.
      time = Math.min(lastTime + 1, MAX_TIME)
      random = randomBytes()
    }
  } else if (time < lastTime && lastRandom) {
    // Часы ушли назад: держим монотонность, инкрементируя прежнее значение.
    time = lastTime
    random = lastRandom
    if (!increment(random)) {
      time = Math.min(lastTime + 1, MAX_TIME)
      random = randomBytes()
    }
  } else {
    random = randomBytes()
  }

  lastTime = time
  lastRandom = random

  return encodeTime(time) + encodeBytes(random)
}

/** Проверяет, что строка похожа на ULID (26 символов алфавита Crockford). */
export function isUlid(value: unknown): value is string {
  return typeof value === 'string' && ULID_RE.test(value)
}

/** Достаёт время (миллисекунды) из ULID. Бросает ошибку, если строка не ULID. */
export function ulidTime(value: string): number {
  if (!isUlid(value)) throw new Error(`Не ULID: ${value}`)
  let time = 0
  for (let i = 0; i < TIME_CHARS; i++) {
    time = time * 32 + CROCKFORD.indexOf(value[i])
  }
  return time
}

/** Текущее время последнего выданного ULID — для отладки и тестов. */
export function ulidLastTime(): number {
  return lastTime
}

/**
 * Сбрасывает внутреннее состояние генератора.
 * Нужно только тестам и повторной инициализации.
 */
export function ulidReset(): void {
  lastTime = -1
  lastRandom = null
}