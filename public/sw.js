/// <reference lib="webworker" />
/**
 * Service Worker «Музы».
 *
 * Задача: приложение открывается мгновенно и всегда, даже без сети.
 * Стратегии:
 *   - App Shell (html, js, css, иконки) — cache-first
 *   - Запросы к LLM (polza.ai)         — network-only (нужна свежесть)
 *   - Всё остальное                    — network-first с фолбэком на кэш
 *
 * Плюс отдельная обязанность: принимать «Поделиться» из других приложений.
 * `share_target` в манифесте отправляет POST, а статический хостинг POST не
 * принимает, поэтому перехватываем его здесь: складываем то, чем поделились,
 * во «входящие» (Cache API) и перенаправляем приложение на `?share=1`.
 * Страница заберёт входящие сама (см. src/capture/shareInbox.ts).
 */

const VERSION = 'v2'
const SHELL_CACHE = `muza-shell-${VERSION}`
const RUNTIME_CACHE = `muza-runtime-${VERSION}`
/** «Входящие» для «Поделиться»; имя кэша продублировано в src/capture/shareInbox.ts. */
const SHARE_CACHE = 'muza-share-v1'
/** Путь действия share_target — совпадает с `action` в манифесте. */
const SHARE_PATH = '/share-target'
/** Ключ с описанием того, чем поделились, и префикс ключей файлов.
 *  Путь относительный (`./`), чтобы входящие лежали внутри папки приложения,
 *  а не в корне домена: тот же приём, что у `action` в манифесте. */
const SHARE_PAYLOAD_KEY = './__share__/payload'
const SHARE_FILE_PREFIX = './__share__/file-'

/** Кэши, которые нельзя удалять при обновлении версии. */
const KEEP_CACHES = [SHELL_CACHE, RUNTIME_CACHE, SHARE_CACHE]

/** Что кэшируем сразу при установке — сам каркас приложения. */
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
  '/apple-touch-icon.png',
]

/** Домены, к которым нельзя лезть из кэша: там живут свежие ответы модели. */
const NETWORK_ONLY_HOSTS = ['polza.ai', 'api.deepseek.com', 'api.openai.com']

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE)
      // addAll падает целиком, если хоть один файл недоступен, —
      // поэтому кладём по одному и не боимся частичного провала
      await Promise.all(
        SHELL_ASSETS.map((url) =>
          cache.add(url).catch(() => {
            /* файла может не быть — не ломаем установку */
          }),
        ),
      )
      await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // чистим кэши прошлых версий, но не «входящие» с непрочитанным «Поделиться»
      const keys = await caches.keys()
      await Promise.all(
        keys.filter((k) => !KEEP_CACHES.includes(k)).map((k) => caches.delete(k)),
      )
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  const url = new URL(request.url)

  // 0. «Поделиться» из другого приложения: POST на действие share_target.
  //    Всё остальное — только GET.
  if (
    request.method === 'POST' &&
    url.origin === self.location.origin &&
    url.pathname.endsWith(SHARE_PATH)
  ) {
    event.respondWith(receiveShared(request))
    return
  }

  // только GET; POST/PUT не кэшируем
  if (request.method !== 'GET') return

  // 1. Запросы к LLM — всегда в сеть, без кэша
  if (NETWORK_ONLY_HOSTS.some((h) => url.hostname.endsWith(h))) return

  // 2. Навигация — отдаём каркас из кэша, обновляем в фоне
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request)
          const cache = await caches.open(SHELL_CACHE)
          cache.put('/index.html', fresh.clone())
          return fresh
        } catch {
          const cache = await caches.open(SHELL_CACHE)
          return (
            (await cache.match('/index.html')) ||
            (await cache.match('/')) ||
            new Response('Нет сети', { status: 503, statusText: 'Offline' })
          )
        }
      })(),
    )
    return
  }

  // 3. Статика своего происхождения — cache-first, потом сеть
  if (url.origin === self.location.origin) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(SHELL_CACHE)
        const hit = await cache.match(request)
        if (hit) return hit
        try {
          const fresh = await fetch(request)
          if (fresh.ok && fresh.type === 'basic') {
            cache.put(request, fresh.clone())
          }
          return fresh
        } catch {
          return new Response('', { status: 504, statusText: 'Offline' })
        }
      })(),
    )
    return
  }

  // 4. Чужое (шрифты и т.п.) — network-first с фолбэком
  event.respondWith(
    (async () => {
      try {
        const fresh = await fetch(request)
        const cache = await caches.open(RUNTIME_CACHE)
        if (fresh.ok) cache.put(request, fresh.clone())
        return fresh
      } catch {
        const cache = await caches.open(RUNTIME_CACHE)
        return (
          (await cache.match(request)) ||
          new Response('', { status: 504, statusText: 'Offline' })
        )
      }
    })(),
  )
})

/**
 * Принимает то, чем с приложением поделились, и складывает во «входящие».
 *
 * Формат «входящих» намеренно простой: строковые поля как есть и список
 * файлов, каждый — отдельной записью в кэше. Разбирается с этим страница:
 * какие решения принять (какой `captured_via`, какой тип материала) —
 * дело её логики, а не Service Worker.
 *
 * Ответ — перенаправление в приложение. Если что-то пошло не так, ведём
 * туда же, но с `?share=error`: приложение скажет человеку, что случилось.
 */
async function receiveShared(request) {
  try {
    const form = await request.formData()
    const fields = {}
    const files = []

    const cache = await caches.open(SHARE_CACHE)
    // Прошлую порцию убираем: иначе она догрузится вместе с новой.
    const old = await cache.keys()
    await Promise.all(old.map((key) => cache.delete(key)))

    for (const [name, value] of form.entries()) {
      if (typeof value === 'string') {
        fields[name] = fields[name] ? `${fields[name]}\n${value}` : value
        continue
      }
      if (!value || typeof value.size !== 'number' || value.size === 0) continue

      const index = files.length
      const key = `${SHARE_FILE_PREFIX}${index}`
      await cache.put(
        key,
        new Response(value, {
          headers: { 'content-type': value.type || 'application/octet-stream' },
        }),
      )
      files.push({
        key,
        name: value.name || `файл-${index + 1}`,
        type: value.type || '',
        size: value.size,
      })
    }

    await cache.put(
      SHARE_PAYLOAD_KEY,
      new Response(JSON.stringify({ fields, files }), {
        headers: { 'content-type': 'application/json' },
      }),
    )

    return Response.redirect(appUrl('?share=1'), 303)
  } catch (e) {
    console.warn('Не удалось принять «Поделиться»:', e)
    return Response.redirect(appUrl('?share=error'), 303)
  }
}

/** Адрес приложения с параметром — от scope, а не от корня домена. */
function appUrl(query) {
  return new URL(`.${query}`, self.registration.scope).href
}

/** Сообщение из приложения: «доступна новая версия, применить». */
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting()
})
