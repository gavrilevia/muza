<script lang="ts">
  /**
   * Каркас «Музы» — этап 0.
   *
   * Источник данных — IndexedDB через IdeaRepository (задача 1).
   * Временная заглушка на localStorage удалена: идеи читаются из базы
   * и переживают перезагрузку страницы.
   *
   * Захват (задача 3): «+» остаётся главным путём, а рядом живут каналы —
   * файл, камера, микрофон, буфер обмена и «Поделиться» из другого
   * приложения. Каналы ничего не решают про данные: они отдают запрос
   * в `capture`, а тот сначала сохраняет идею и только потом материалы.
   */

  import { onMount } from 'svelte'
  import { ideaRepository } from './data'
  import type { Idea } from './data'
  import { CaptureChannels, asCaptureFile, capture, describeCaptureError } from './capture'
  import { clearSharedHandoff, peekSharedHandoff, shareReturnState, shouldAcceptShare } from './capture'
  import type { CaptureFile, CaptureOutcome, CaptureRequest } from './capture'

  let text = $state('')
  let ideas = $state<Idea[]>([])
  /** Текст ошибки слоя данных: показываем вместо списка, если база недоступна. */
  let dbError = $state<string | null>(null)

  onMount(() => {
    void boot()
  })

  /** Загрузка и приём «Поделиться» — по очереди, чтобы входящие встали в список. */
  async function boot() {
    await load()
    await acceptShared()
  }

  /** Читает идеи из IndexedDB. */
  async function load() {
    try {
      ideas = await ideaRepository.list({ sortBy: 'captured_at', order: 'desc' })
      dbError = null
    } catch (e) {
      dbError = errorText(e)
    }
  }

  /** Первая строка текста — заголовок; всё остальное живёт в `body`. */
  function firstLine(value: string): string {
    return value.split('\n')[0].trim().slice(0, 120)
  }

  /** Заголовок для списка: он же запасной вариант, если заголовка нет. */
  function display(idea: Idea): string {
    return idea.title || idea.body
  }

  async function add() {
    const t = text.trim()
    if (!t) return
    try {
      // «+» — текст, набранный вручную. Путь `typed` не привязан к устройству:
      // продукт начинается с телефона, и метрика «захват без открытия
      // приложения» не должна считать это десктопом.
      const idea = await ideaRepository.create({
        title: firstLine(t),
        body: t,
        captured_via: 'typed',
      })
      ideas = [idea, ...ideas]
      text = ''
      dbError = null
    } catch (e) {
      dbError = errorText(e)
    }
  }

  /**
   * Единая точка сохранения для всех каналов, кроме «+».
   *
   * Бросает только тогда, когда идею сохранить не удалось: канал покажет
   * сообщение, а набранный текст останется в поле.
   */
  async function saveCapture(request: CaptureRequest): Promise<CaptureOutcome> {
    const outcome = await capture(request)
    ideas = [outcome.idea, ...ideas]
    // Прошлая ошибка больше не «висит»: предупреждение о материалах вызывающий
    // выставит сам, уже после этого.
    dbError = null
    return outcome
  }

  /** Поле очищаем только после успешного сохранения. */
  function consumeText() {
    text = ''
  }

  /**
   * Картинка, вставленная прямо в поле (Ctrl+V), — запасной путь для
   * браузеров, которые не дают читать буфер обмена программно (Firefox).
   * Обычный текст не трогаем: пусть вставляется как обычно.
   */
  function onPaste(event: ClipboardEvent) {
    const items = event.clipboardData?.items
    if (!items) return
    const files: CaptureFile[] = []
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i]
      if (item.kind !== 'file' || !item.type.startsWith('image/')) continue
      const file = item.getAsFile()
      if (file) files.push(asCaptureFile(file))
    }
    if (files.length === 0) return

    event.preventDefault()
    void saveCapture({ channel: 'clipboard', text: text.trim() || undefined, files })
      .then(() => {
        text = ''
        dbError = null
      })
      .catch((e) => {
        dbError = describeCaptureError(e, 'clipboard')
      })
  }

  /**
   * Приём «Поделиться»: Service Worker сложил то, чем поделились, во входящие
   * и привёл сюда. Входящие стираем только после успешного сохранения —
   * иначе поделённое потерялось бы вместе со сбоем.
   */
  async function acceptShared() {
    let hasIncoming = false
    try {
      hasIncoming = await shouldAcceptShare(window.location.search)
    } catch (e) {
      dbError = errorText(e)
      return
    }
    if (!hasIncoming) return

    try {
      const handoff = await peekSharedHandoff()
      if (!handoff) {
        if (shareReturnState(window.location.search) === 'error') {
          dbError = 'Не удалось принять то, чем поделились. Попробуйте ещё раз или сохраните текстом.'
        }
        dropShareFlag()
        return
      }
      const outcome = await saveCapture({
        channel: 'share',
        text: handoff.text,
        sourceTitle: handoff.title,
        url: handoff.url,
        files: handoff.files,
      })
      await clearSharedHandoff()
      dbError = outcome.warning
    } catch (e) {
      // Входящие оставляем: попробуем снова при следующем открытии.
      dbError = describeCaptureError(e, 'share')
    } finally {
      dropShareFlag()
    }
  }

  /** Убирает `?share=1` из адреса, чтобы обновление страницы не повторяло приём. */
  function dropShareFlag() {
    if (!window.location.search) return
    try {
      window.history.replaceState(null, '', window.location.pathname)
    } catch {
      /* история недоступна — не критично */
    }
  }

  async function remove(id: string) {
    try {
      // Мягкое удаление: запись остаётся в базе со статусом `deleted`.
      await ideaRepository.remove(id)
      ideas = ideas.filter((i) => i.id !== id)
      dbError = null
    } catch (e) {
      dbError = errorText(e)
    }
  }

  function errorText(e: unknown): string {
    return e instanceof Error ? e.message : 'Хранилище идей недоступно.'
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) add()
  }

  function plural(n: number, one: string, few: string, many: string) {
    const m10 = n % 10
    const m100 = n % 100
    if (m10 === 1 && m100 !== 11) return one
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few
    return many
  }
</script>

<svelte:window onkeydown={onKey} />

<header class="top">
  <div class="wrap">
    <div class="brand">
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M4 7h16M4 12h10M4 17h13" stroke="#ff8a5b" stroke-width="1.7" />
        <circle cx="18.5" cy="15" r="3.2" stroke="#5fd4a8" stroke-width="1.7" />
      </svg>
      Муза
    </div>
    <span class="stage">каркас · этап 0</span>
  </div>
</header>

<main class="wrap">
  <section class="capture">
    <label for="idea">Что надо будет сделать?</label>
    <textarea
      id="idea"
      bind:value={text}
      rows="3"
      placeholder="Например: аэрогриль на 5 литров — сравнить три варианта"
      onpaste={onPaste}
    ></textarea>
    <div class="row">
      <button class="btn" onclick={add} disabled={!text.trim()}>
        Сохранить идею
      </button>
      <span class="hint">Ctrl + Enter</span>
    </div>

    <CaptureChannels text={text} onCapture={saveCapture} onTextConsumed={consumeText} />
  </section>

  <section class="list">
    <h2>
      {ideas.length}
      {plural(ideas.length, 'идея', 'идеи', 'идей')}
    </h2>

    {#if ideas.length === 0}
      <p class="empty">
        {dbError ??
          'Пока пусто. Добавьте первую идею — она появится здесь и сохранится на этом устройстве.'}
      </p>
    {:else}
      {#if dbError}
        <p class="empty">{dbError}</p>
      {/if}
      <ul>
        {#each ideas as idea (idea.id)}
          <li>
            <span class="txt">{display(idea)}</span>
            <button
              class="del"
              onclick={() => remove(idea.id)}
              aria-label="Удалить"
              title="Удалить"
            >
              ×
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <section class="next">
    <h2>Что дальше</h2>
    <p>
      Это каркас: проверяем, что приложение открывается на телефоне, ставится
      ярлыком и работает без сети. Идеи сохраняются в IndexedDB на устройстве
      и переживают перезагрузку страницы.
    </p>
    <p>
      Дальше — разбор и классификация через ИИ, направления, выгрузка копии
      одним файлом.
    </p>
  </section>
</main>

<style>
  :global(body) {
    margin: 0;
    background: #0a0d14;
    color: #e8ecf2;
    font: 16px/1.55 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
  }

  .wrap {
    max-width: 640px;
    margin: 0 auto;
    padding: 0 16px;
  }

  .top {
    position: sticky;
    top: 0;
    z-index: 5;
    background: rgba(10, 13, 20, 0.92);
    backdrop-filter: blur(10px);
    border-bottom: 1px solid #1b2130;
    /* отступ под «челку» iPhone */
    padding-top: env(safe-area-inset-top);
  }

  .top .wrap {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    min-height: 52px;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 9px;
    font-weight: 650;
    letter-spacing: -0.01em;
  }

  .brand svg {
    width: 21px;
    height: 21px;
    flex: none;
  }

  .stage {
    font-size: 12px;
    color: #7c879c;
    white-space: nowrap;
  }

  main {
    padding-bottom: calc(48px + env(safe-area-inset-bottom));
  }

  .capture {
    margin: 22px 0 26px;
  }

  .capture label {
    display: block;
    font-size: 14px;
    color: #97a3b8;
    margin-bottom: 8px;
  }

  textarea {
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
    padding: 13px 14px;
    border-radius: 12px;
    border: 1px solid #232a3b;
    background: #111725;
    color: #e8ecf2;
    font: inherit;
  }

  textarea:focus {
    outline: none;
    border-color: #ff8a5b;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 10px;
    flex-wrap: wrap;
  }

  .btn {
    padding: 11px 18px;
    border: none;
    border-radius: 11px;
    background: #ff8a5b;
    color: #17110d;
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }

  .btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .hint {
    font-size: 12px;
    color: #66718a;
  }

  h2 {
    margin: 0 0 12px;
    font-size: 15px;
    font-weight: 600;
    color: #97a3b8;
  }

  .empty {
    color: #66718a;
    font-size: 14px;
    margin: 0;
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  li {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 12px 13px;
    border-radius: 11px;
    background: #111725;
    border: 1px solid #1d2433;
  }

  .txt {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .del {
    flex: none;
    width: 26px;
    height: 26px;
    border: none;
    border-radius: 7px;
    background: transparent;
    color: #66718a;
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
  }

  .del:hover {
    background: #1d2433;
    color: #ff8a5b;
  }

  .next {
    margin-top: 34px;
    padding-top: 20px;
    border-top: 1px solid #1b2130;
  }

  .next p {
    margin: 0 0 10px;
    font-size: 14px;
    color: #8b96ab;
  }
</style>
