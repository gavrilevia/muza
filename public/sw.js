/// <reference lib="webworker" />
/**
 * Service Worker «Музы».
 *
 * Задача: приложение открывается мгновенно и всегда, даже без сети.
 * Стратегии:
 *   - App Shell (html, js, css, иконки) — cache-first
 *   - Запросы к LLM (polza.ai)         — network-only (нужна свежесть)
 *   - Всё остальное                    — network-first с фолбэком на кэш
 */

const VERSION = 'v1'
const SHELL_CACHE = `muza-shell-${VERSION}`
const RUNTIME_CACHE = `muza-runtime-${VERSION}`

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
      // чистим кэши прошлых версий
      const keys = await caches.keys()
      await Promise.all(
        keys
          .filter((k) => k !== SHELL_CACHE && k !== RUNTIME_CACHE)
          .map((k) => caches.delete(k)),
      )
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event

  // только GET; POST/PUT не кэшируем
  if (request.method !== 'GET') return

  const url = new URL(request.url)

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

/** Сообщение из приложения: «доступна новая версия, применить». */
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting()
})
