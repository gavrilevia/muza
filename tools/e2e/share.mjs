/**
 * Сквозная проверка «Поделиться в Музу» — от POST до идеи в базе.
 *
 * ЗАЧЕМ ОТДЕЛЬНО ОТ data-selftest. Там проверяются чистые решения (какие
 * поля, какой канал, какая ссылка станет материалом). Здесь — НАСТОЯЩИЙ
 * путь, который в Node не воспроизвести: системное меню шлёт POST на
 * `share-target`, его перехватывает Service Worker, кладёт входящие в Cache
 * API, перенаправляет на `?share=1`, страница забирает и сохраняет.
 *
 * Этот путь уже ломался молча: адреса каркаса в SW считались от корня
 * домена, и на GitHub Pages (`/muza/`) кэш оставался пустым — без сети
 * человек видел «Нет сети» вместо приложения. Поэтому проверка идёт на
 * ПОДПУТИ и включает офлайн.
 *
 * Запуск (нужен playwright; в репозитории его нет):
 *   PLAYWRIGHT_BROWSERS_PATH=<путь к браузерам> \
 *     node tools/e2e/share.mjs dist /muza/
 *
 * Второй аргумент — префикс, под которым лежит приложение: `/` или `/muza/`.
 * Проверяется: POST перехвачен, идея и файл в базе, байты не искажены,
 * входящие очищены, офлайн открывается каркас, «Поделиться» без сети
 * не теряется.
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
// Playwright в зависимостях проекта нет: браузерная проверка нужна редко,
// а весит он много. Если его нет — говорим, что поставить, а не падаем стеком.
let chromium
try {
  ;({ chromium } = await import('playwright'))
} catch {
  console.error('Нужен playwright: npm i -D playwright && npx playwright install chromium')
  process.exit(2)
}

const DIST = process.argv[2]
const PREFIX = process.argv[3] || '/'
const T = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
}
const server = createServer(async (q, r) => {
  try {
    let p = decodeURIComponent((q.url || '/').split('?')[0])
    if (!p.startsWith(PREFIX)) throw new Error('вне подпути')
    p = p.slice(PREFIX.length - 1)
    if (p === '/' || p.endsWith('/')) p += 'index.html'
    const f = join(DIST, normalize(p).replace(/^(\.\.[/\\])+/g, ''))
    const body = await readFile(f)
    r.writeHead(200, { 'Content-Type': T[extname(f)] ?? 'application/octet-stream' })
    r.end(body)
  } catch {
    r.writeHead(404).end('nf')
  }
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`
const app = origin + PREFIX

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✔ ${name}${extra ? ' — ' + extra : ''}`) }
  else { fail += 1; console.log(`  ✖ ${name}${extra ? ' — ' + extra : ''}`) }
}

const b = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
const ctx = await b.newContext({ locale: 'ru-RU' })
// Никакой внешней сети: имя хоста из «Поделиться» не должно делать тест плавающим.
await ctx.route('**/*', (route) => {
  const u = route.request().url()
  if (u.startsWith(origin)) route.continue()
  else route.abort()
})
const pg = await ctx.newPage()
const errs = []
pg.on('pageerror', (e) => errs.push(String(e).slice(0, 200)))

console.log('== 1. Приложение и Service Worker ==')
await pg.goto(app, { waitUntil: 'load' })
await pg.waitForTimeout(1200)
const swState = await pg.evaluate(async () => {
  const reg = await navigator.serviceWorker.ready
  const deadline = Date.now() + 8000
  while (!navigator.serviceWorker.controller && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100))
  }
  return { scope: reg.scope, active: reg.active?.state ?? null, controlled: !!navigator.serviceWorker.controller }
})
ok('Service Worker активен', swState.active === 'activated', String(swState.active))
ok('страница под контролем SW', swState.controlled)

console.log('== 2. POST «Поделиться» перехвачен SW ==')
const body = [137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4, 5, 6, 7, 8]
const post = await pg.evaluate(async ({ body, base }) => {
  const bytes = new Uint8Array(body)
  const fd = new FormData()
  fd.set('title', 'Аэрогриль на 5 литров')
  fd.set('text', 'Посмотреть в Леруа, сравнить с Xiaomi')
  fd.set('url', 'https://www.leroymerlin.ru/product/123')
  fd.set('files', new File([bytes], 'фото-аэрогриля.png', { type: 'image/png' }))
  const res = await fetch(base + 'share-target', { method: 'POST', body: fd })
  return { status: res.status, redirected: res.redirected, url: res.url, type: res.type }
}, { body, base: app })
console.log('   ответ:', JSON.stringify(post))
ok('SW перенаправил в приложение', post.url.includes('share=1') || post.redirected, JSON.stringify(post))
ok('перенаправление ведёт на ?share=1', post.url.includes('share=1'), post.url)

console.log('== 3. Страница принимает входящие ==')
await pg.goto(app + '?share=1', { waitUntil: 'load' })
const stored = await pg.evaluate(async () => {
  const open = () =>
    new Promise((res, rej) => {
      const r = indexedDB.open('muza')
      r.onsuccess = () => res(r.result)
      r.onerror = () => rej(r.error)
    })
  const deadline = Date.now() + 10000
  let ideas = []
  while (Date.now() < deadline) {
    const db = await open()
    ideas = await new Promise((res) => {
      const r = db.transaction('ideas').objectStore('ideas').getAll()
      r.onsuccess = () => res(r.result)
    })
    if (ideas.length > 0) break
    await new Promise((r) => setTimeout(r, 150))
  }
  const db = await open()
  const materials = await new Promise((res) => {
    const r = db.transaction('materials').objectStore('materials').getAll()
    r.onsuccess = () => res(r.result)
  })
  const mat = materials[0]
  const bytes = mat?.blob ? Array.from(new Uint8Array(await mat.blob.arrayBuffer())) : []
  const cached = await caches.open('muza-share-v1')
  const leftover = (await cached.keys()).length
  return { ideas: ideas.map((i) => ({ id: i.id, title: i.title, body: i.body, via: i.captured_via })), materials: materials.map((m) => ({ id: m.id, kind: m.kind, mime: m.mime, name: m.title, bytes })), leftover }
})
console.log('   в базе:', JSON.stringify(stored, null, 1).slice(0, 900))
ok('создана ровно одна идея', stored.ideas.length === 1, String(stored.ideas.length))
const idea = stored.ideas[0]
ok('текст из «Поделиться» сохранён', idea && /Посмотреть в Леруа/.test(idea.body), idea?.body)
ok('ссылка сохранена', idea && /leroymerlin/.test(idea.body), idea?.body)
ok('канал захвата — share_sheet', idea?.via === 'share_sheet', idea?.via)
ok('файл и ссылка стали материалами', stored.materials.length === 2, String(stored.materials.length))
ok('имя и тип файла сохранены', stored.materials[0]?.name === 'фото-аэрогриля.png' && stored.materials[0]?.mime === 'image/png', JSON.stringify(stored.materials[0]))
ok('байты файла не искажены', JSON.stringify(stored.materials[0]?.bytes) === JSON.stringify(body), JSON.stringify(stored.materials[0]?.bytes))
ok('входящие очищены после сохранения', stored.leftover === 0, String(stored.leftover))
ok('в адресе не осталось ?share=1', !pg.url().includes('share='), pg.url())

console.log('== 4. Только текст, без файлов ==')
await pg.evaluate(async ({ base }) => {
  const fd = new FormData()
  fd.set('text', 'Идея без картинки: купить корм коту')
  await fetch(base + 'share-target', { method: 'POST', body: fd })
}, { base: app })
await pg.goto(app + '?share=1', { waitUntil: 'load' })
const second = await pg.evaluate(async () => {
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('muza')
    r.onsuccess = () => res(r.result)
    r.onerror = () => rej(r.error)
  })
  const deadline = Date.now() + 10000
  let ideas = []
  while (Date.now() < deadline) {
    ideas = await new Promise((res) => {
      const r = db.transaction('ideas').objectStore('ideas').getAll()
      r.onsuccess = () => res(r.result)
    })
    if (ideas.length >= 2) break
    await new Promise((r) => setTimeout(r, 150))
  }
  const materials = await new Promise((res) => {
    const r = db.transaction('materials').objectStore('materials').getAll()
    r.onsuccess = () => res(r.result)
  })
  return { ideas: ideas.map((i) => ({ body: i.body, title: i.title })), materials: materials.length }
})
ok('текстовая идея тоже принята', second.ideas.length === 2, String(second.ideas.length))
ok('лишних материалов не появилось', second.materials === 2, String(second.materials))
ok('нет ошибок JS', errs.length === 0, errs.slice(0, 2).join(' | ') || 'чисто')

console.log('== 5. Офлайн: приложение открывается без сети ==')
await ctx.setOffline(true)
// СТРОГО: reload заставляет SW ответить сам, а не взять HTML из кэша браузера.
// Упавший reload оставил бы старый DOM, и тест «увидел» бы приложение.
const offlineResp = await pg.reload({ waitUntil: 'load' }).catch(() => null)
await pg.waitForTimeout(1200)
const offlineText = await pg.locator('body').innerText().catch(() => '')
ok(
  'офлайн: ответ — приложение, а не 503',
  Boolean(offlineResp) && offlineResp.status() === 200,
  offlineResp ? String(offlineResp.status()) : 'нет ответа',
)
ok(
  'офлайн показан каркас, а не «Нет сети»',
  /Муза/.test(offlineText) && !/Нет сети/.test(offlineText),
  offlineText.slice(0, 70).replace(/\n/g, ' '),
)

console.log('== 6. «Поделиться» БЕЗ СЕТИ: входящие не теряются ==')
const beforeOffline = await pg.evaluate(async () => {
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('muza')
    r.onsuccess = () => res(r.result)
    r.onerror = () => rej(r.error)
  })
  return new Promise((res) => {
    const r = db.transaction('ideas').objectStore('ideas').count()
    r.onsuccess = () => res(r.result)
  })
})
await pg.evaluate(async (base) => {
  const fd = new FormData()
  fd.set('text', 'Офлайн-идея: посмотреть цену на аэрогриль завтра')
  await fetch(base + 'share-target', { method: 'POST', body: fd, redirect: 'manual' })
}, app)
await pg.goto(app + '?share=1', { waitUntil: 'load' }).catch(() => {})
await pg.waitForTimeout(1500)
const afterOffline = await pg.evaluate(async () => {
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('muza')
    r.onsuccess = () => res(r.result)
    r.onerror = () => rej(r.error)
  })
  const deadline = Date.now() + 8000
  let ideas = []
  while (Date.now() < deadline) {
    ideas = await new Promise((res) => {
      const r = db.transaction('ideas').objectStore('ideas').getAll()
      r.onsuccess = () => res(r.result)
    })
    if (ideas.some((i) => /Офлайн-идея/.test(i.body))) break
    await new Promise((r) => setTimeout(r, 150))
  }
  return { count: ideas.length, found: ideas.some((i) => /Офлайн-идея/.test(i.body)) }
})
ok('идея из офлайн-входящих сохранена', afterOffline.found, JSON.stringify(afterOffline))
ok('лишних идей не появилось', afterOffline.count === beforeOffline + 1, `${beforeOffline} -> ${afterOffline.count}`)
await ctx.setOffline(false)

console.log('== 7. Свежая установка: один заход, потом офлайн ==')
// Самая честная проверка обещания «открывается всегда»: новое хранилище,
// ОДИН заход (как у нового человека), затем сеть выключена. Если каркас
// кэшируется не от scope, здесь будет «Нет сети».
const freshCtx = await b.newContext({ locale: 'ru-RU' })
await freshCtx.route('**/*', (route) => {
  const u = route.request().url()
  if (u.startsWith(origin)) route.continue()
  else route.abort()
})
const fresh = await freshCtx.newPage()
await fresh.goto(app, { waitUntil: 'load' })
await fresh.waitForTimeout(2000)
const shellKeys = await fresh.evaluate(async () => {
  const names = await caches.keys()
  const out = {}
  for (const name of names) {
    const c = await caches.open(name)
    out[name] = (await c.keys()).map((r) => r.url)
  }
  return out
})
const shellName = Object.keys(shellKeys).find((n) => n.startsWith('muza-shell-')) ?? ''
const shell = shellKeys[shellName] ?? []
ok('каркас закэширован при установке', shell.length >= 5, `ключей ${shell.length}`)
ok('ключи каркаса — внутри папки приложения', shell.every((u) => u.startsWith(app)), shell.slice(0, 2).join(', '))
await freshCtx.setOffline(true)
const freshResp = await fresh.reload({ waitUntil: 'load' }).catch(() => null)
await fresh.waitForTimeout(1200)
const freshText = await fresh.locator('body').innerText().catch(() => '')
ok(
  'новый человек открывает приложение без сети',
  Boolean(freshResp) && freshResp.status() === 200 && /Муза/.test(freshText),
  `${freshResp ? freshResp.status() : 'нет ответа'} | ${freshText.slice(0, 40).replace(/\n/g, ' ')}`,
)
await freshCtx.close()

await b.close()
server.close()
console.log('--------------------------------------------')
console.log(`Пройдено: ${pass}   Провалено: ${fail}`)
process.exit(fail > 0 ? 1 : 0)
