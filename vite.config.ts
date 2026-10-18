import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [svelte()],

  /**
   * base: './' — относительные пути к ресурсам.
   *
   * Нужно, чтобы приложение работало и в корне домена, и на подпути
   * (например, GitHub Pages: /muza/). С абсолютным '/' на подпути
   * ломаются стили, скрипты и Service Worker.
   */
  base: './',

  build: {
    assetsDir: 'assets',
    sourcemap: false,
  },
})
