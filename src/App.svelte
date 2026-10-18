<script lang="ts">
  /**
   * Каркас «Музы» — этап 0.
   *
   * Здесь только проверка, что приложение выглядит правильно на телефоне.
   * Слой данных — задача 1 (IndexedDB). Сейчас идеи лежат в localStorage,
   * это ВРЕМЕННАЯ заглушка: она будет заменена репозиторием из задачи 1.
   * Удалять эту заглушку вместе с появлением IdeaRepository.
   */

  type Idea = { id: string; text: string; at: number }

  const STORAGE_KEY = 'muza.shell.ideas'

  let text = $state('')
  let ideas = $state<Idea[]>(load())

  function load(): Idea[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      return raw ? (JSON.parse(raw) as Idea[]) : []
    } catch {
      return []
    }
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(ideas))
    } catch {
      /* приватный режим — не страшно для каркаса */
    }
  }

  function add() {
    const t = text.trim()
    if (!t) return
    ideas = [
      { id: crypto.randomUUID(), text: t, at: Date.now() },
      ...ideas,
    ]
    text = ''
    save()
  }

  function remove(id: string) {
    ideas = ideas.filter((i) => i.id !== id)
    save()
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
    ></textarea>
    <div class="row">
      <button class="btn" onclick={add} disabled={!text.trim()}>
        Сохранить идею
      </button>
      <span class="hint">Ctrl + Enter</span>
    </div>
  </section>

  <section class="list">
    <h2>
      {ideas.length}
      {plural(ideas.length, 'идея', 'идеи', 'идей')}
    </h2>

    {#if ideas.length === 0}
      <p class="empty">
        Пока пусто. Добавьте первую идею — она появится здесь и сохранится
        на этом устройстве.
      </p>
    {:else}
      <ul>
        {#each ideas as idea (idea.id)}
          <li>
            <span class="txt">{idea.text}</span>
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
      ярлыком и работает без сети. Идеи пока хранятся во временном месте.
    </p>
    <p>
      Настоящее хранение (IndexedDB), классификация через ИИ и направления —
      следующие задачи.
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
