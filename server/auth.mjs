/**
 * Вход на dev-домен по cookie.
 *
 * ЗАЧЕМ. Basic auth не умеет «запомнить навсегда»: браузер на Android
 * переспрашивает после каждого перезапуска. Cookie решает это честно —
 * один раз ввели пароль, сервер выдал подписанную cookie на год.
 *
 * ЧТО ЗДЕСЬ ЕСТЬ И ЧЕГО НЕТ. Только подпись и проверка срока. Никаких
 * паролей в cookie: там `exp` и HMAC от него. Подделать без секрета
 * нельзя, продлить — тоже. Пароль сравнивается отдельно, за постоянное
 * время, чтобы по отклику нельзя было угадывать посимвольно.
 *
 * ЭТО НЕ ШИФРОВАНИЕ ИДЕЙ. Cookie открывает только dev-домен; хранилище
 * по-прежнему закрыто паролем, который никуда не уходит.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

/** Имя cookie. */
export const SESSION_COOKIE = 'muza_dev'

/** Сколько живёт вход: год. */
export const SESSION_TTL_SECONDS = 365 * 24 * 60 * 60

/**
 * Подписывает срок: `<exp>.<hmac>`.
 *
 * `exp` в секундах. Ничего секретного в значении нет — только срок,
 * поэтому cookie можно хранить в HttpOnly и не бояться, что её прочитают.
 */
export function signSession(expSeconds, secret) {
  const exp = Math.trunc(expSeconds)
  const signature = createHmac('sha256', secret).update(String(exp)).digest('hex')
  return `${exp}.${signature}`
}

/**
 * Проверяет подпись и срок.
 *
 * `nowSeconds` можно подставить в проверках; в бою — текущее время.
 */
export function verifySession(value, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!value || !secret) return false
  const dot = value.indexOf('.')
  if (dot <= 0) return false
  const expRaw = value.slice(0, dot)
  const signature = value.slice(dot + 1)
  const exp = Number(expRaw)
  if (!Number.isFinite(exp) || exp < nowSeconds) return false

  const expected = createHmac('sha256', secret).update(expRaw).digest('hex')
  if (signature.length !== expected.length) return false
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  } catch {
    return false
  }
}

/** Достаёт cookie по имени из заголовка `Cookie`. */
export function parseCookie(header, name) {
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() !== name) continue
    try {
      return decodeURIComponent(part.slice(eq + 1).trim())
    } catch {
      return null
    }
  }
  return null
}

/**
 * Сравнивает пароль с эталоном за постоянное время.
 *
 * Сравниваем ХЕШИ, а не строки: `timingSafeEqual` требует одинаковой длины,
 * а длина введённого пароля — подсказка для подбора.
 */
export function samePassword(input, expected) {
  const a = createHash('sha256').update(input).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}
