import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'

const app = mount(App, {
  target: document.getElementById('app')!,
})

/**
 * Защита данных: просим браузер не удалять хранилище.
 *
 * Без этого Safari и Chrome могут вычистить IndexedDB при нехватке места —
 * а для пользователя это означает потерю всех идей.
 *
 * Браузер может отказать (вернуть false) — тогда напомним про экспорт.
 * Повторять запрос нельзя: браузеры считают это спамом и отказывают чаще.
 */
async function requestPersistentStorage(): Promise<void> {
  if (!navigator.storage?.persist) return
  try {
    if (await navigator.storage.persisted()) return // уже защищено
    await navigator.storage.persist()
  } catch {
    /* отказ — не критично, обработаем в интерфейсе */
  }
}

/**
 * Регистрация Service Worker — только в собранной версии.
 *
 * В режиме разработки (vite dev) кэш мешает: правки не видны.
 * На хостинге (HTTPS) Service Worker включается и даёт офлайн-работу.
 */
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    await requestPersistentStorage()
    try {
      // Путь относительно СТРАНИЦЫ (не модуля): register() сам разрешает
      // относительный путь от адреса документа. Работает и в корне,
      // и на подпути (GitHub Pages: /muza/).
      // scope не задаём — по умолчанию это папка самого sw.js, что верно.
      const base = import.meta.env.BASE_URL || '/'
      const reg = await navigator.serviceWorker.register(`${base}sw.js`)

      // Если нашлась новая версия — предлагаем обновиться,
      // но НЕ перезагружаем молча: пользователь может печатать идею.
      reg.addEventListener('updatefound', () => {
        const next = reg.installing
        next?.addEventListener('statechange', () => {
          if (next.state === 'installed' && navigator.serviceWorker.controller) {
            if (confirm('Доступна новая версия. Обновить сейчас?')) {
              next.postMessage({ type: 'SKIP_WAITING' })
              window.location.reload()
            }
          }
        })
      })
    } catch (e) {
      console.warn('Service Worker не зарегистрирован:', e)
    }
  })
}

export default app
