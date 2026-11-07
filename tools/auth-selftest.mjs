/**
 * Проверка входа на dev по cookie: чистая логика и живой сервер.
 *
 * Живой сервер запускается на свободном порту с фиктивными ключами S3:
 * нам нужны только ручки /login, /auth/login, /auth/check. Настоящий S3
 * не трогается — ни один запрос до него не доходит.
 */

import { spawn } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  parseCookie,
  samePassword,
  signSession,
  verifySession,
} from '../server/auth.mjs'

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass += 1
    console.log(`  ✔ ${name}${extra ? ' — ' + extra : ''}`)
  } else {
    fail += 1
    console.log(`  ✘ ${name}${extra ? ' — ' + extra : ''}`)
  }
}

const SECRET = 'секрет-подписи-не-пароль'
const now = Math.floor(Date.now() / 1000)

// --- Чистая логика ---------------------------------------------------------

{
  const cookie = signSession(now + 100, SECRET)
  ok('подпись принимается', verifySession(cookie, SECRET, now))
  ok('просроченная не принимается', !verifySession(cookie, SECRET, now + 200))
  ok('чужой секрет не подходит', !verifySession(cookie, 'другой', now))
  ok('подделанный срок не проходит', !verifySession(cookie.replace(/^\d+/, String(now + 999)), SECRET, now))
  ok('мусор не проходит', !verifySession('привет', SECRET, now))
  ok('пусто не проходит', !verifySession('', SECRET, now))

  const parsed = parseCookie(`a=1; ${SESSION_COOKIE}=${cookie}; b=2`, SESSION_COOKIE)
  ok('cookie находится по имени', parsed === cookie)
  ok('чужое имя не путается', parseCookie('a=1; b=2', SESSION_COOKIE) === null)

  ok('пароль совпадает', samePassword('пароль-123', 'пароль-123'))
  ok('пароль не совпадает', !samePassword('пароль-124', 'пароль-123'))
  ok('пустой пароль не проходит', !samePassword('', 'пароль-123'))
  ok('срок входа — год', SESSION_TTL_SECONDS === 365 * 24 * 60 * 60)
}

// --- Живой сервер ----------------------------------------------------------

const PORT = 3911
const STATE = join(process.cwd(), 'node_modules/.tmp/auth-selftest-state')
await mkdir(STATE, { recursive: true })

const child = spawn(process.execPath, ['server/server.mjs'], {
  env: {
    ...process.env,
    PORT: String(PORT),
    STATE_DIR: STATE,
    MUZA_TOKEN: 'token-dlya-proverki',
    DEV_AUTH_PASSWORD: 'пароль-123',
    DEV_AUTH_SECRET: SECRET,
    S3_BUCKET: 'test',
    S3_ENDPOINT: 'http://127.0.0.1:1',
    S3_KEY: 'x',
    S3_SECRET: 'y',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let serverLog = ''
child.stdout.on('data', (chunk) => {
  serverLog += String(chunk)
})
child.stderr.on('data', (chunk) => {
  serverLog += String(chunk)
})

const base = `http://127.0.0.1:${PORT}`

/** Ждём, пока сервер ответит на /health. */
async function waitReady() {
  for (let i = 0; i < 50; i += 1) {
    try {
      const res = await fetch(`${base}/health`)
      if (res.ok) return true
    } catch {
      /* ещё не поднялся */
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}

try {
  const ready = await waitReady()
  ok('сервер поднялся', ready, ready ? '' : serverLog.slice(-300))

  if (ready) {
    // Страница входа без пароля.
    const login = await fetch(`${base}/login`, { redirect: 'manual' })
    const loginText = await login.text()
    ok('страница входа отдаётся', login.status === 200 && loginText.includes('Войти'))

    const bad = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: 'неверный' }),
      redirect: 'manual',
    })
    ok('неверный пароль — назад на вход', bad.status === 303, `status ${bad.status}`)
    ok('адрес с ошибкой', bad.headers.get('location') === '/login?error=1')
    ok('cookie при отказе не ставится', !bad.headers.get('set-cookie'))

    const good = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: 'пароль-123' }),
      redirect: 'manual',
    })
    const setCookie = good.headers.get('set-cookie') ?? ''
    ok('верный пароль — на главную', good.status === 303, `status ${good.status}`)
    ok('cookie поставлена', setCookie.includes(`${SESSION_COOKIE}=`), setCookie.slice(0, 40))
    ok('cookie HttpOnly', /HttpOnly/i.test(setCookie))
    ok('cookie Secure', /Secure/i.test(setCookie))
    ok('cookie на год', /Max-Age=31536000/.test(setCookie))

    const cookieValue = setCookie.split(';')[0]

    const checkOk = await fetch(`${base}/auth/check`, {
      headers: { cookie: cookieValue },
      redirect: 'manual',
    })
    ok('с cookie пускает', checkOk.status === 200)

    const checkNo = await fetch(`${base}/auth/check`, { redirect: 'manual' })
    ok('без cookie — на вход', checkNo.status === 302, `status ${checkNo.status}`)
    ok('адрес входа', checkNo.headers.get('location') === '/login')

    const forged = await fetch(`${base}/auth/check`, {
      headers: { cookie: `${SESSION_COOKIE}=9999999999.deadbeef` },
      redirect: 'manual',
    })
    ok('подделка не проходит', forged.status === 302)

    // API по-прежнему закрыт паролем сервера: вход на dev его не отменяет.
    const api = await fetch(`${base}/file/begin`, { method: 'POST', body: '{}' })
    ok('API без токена закрыт', api.status === 401)

    // Метрики — только с паролем сервера.
    const metricsNo = await fetch(`${base}/metrics/summary`)
    ok('метрики без токена закрыты', metricsNo.status === 401)
    const metricsOk = await fetch(`${base}/metrics/summary?days=7`, {
      headers: { authorization: 'Bearer token-dlya-proverki' },
    })
    const metricsBody = await metricsOk.json()
    ok('метрики с токеном отдаются', metricsOk.status === 200 && metricsBody.days === 7)
    ok('в сводке есть итоги', Boolean(metricsBody.totals))
  }
} finally {
  child.kill('SIGTERM')
  await new Promise((resolve) => setTimeout(resolve, 200))
  await rm(STATE, { recursive: true, force: true })
}

console.log('--------------------------------------------')
console.log(`Пройдено: ${pass}   Провалено: ${fail}`)
process.exit(fail > 0 ? 1 : 0)
