<script lang="ts">
  /**
   * Экран поиска: поле, выдача по мере ввода и честный рассказ о том,
   * почему идея попала в результаты.
   *
   * Поиск полностью локальный: он спрашивает `searchService`, а тот держит
   * перевёрнутый индекс в памяти. Сети и ИИ здесь нет — ни одного запроса
   * наружу этот экран не делает.
   *
   * Что важно для человека:
   *   - под полем видно, готов ли поиск (на большом количестве идей первая
   *     сборка занимает время);
   *   - в каждом результате есть кусок текста вокруг совпадения, а не только
   *     название — иначе непонятно, почему идея нашлась;
   *   - нажатие ведёт к идее в списке (прокрутка и подсветка), а если её там
   *     уже нет — раскрывает текст прямо здесь;
   *   - пустой запрос и «ничего не найдено» говорят словами, что происходит.
   *
   * Задержка ввода: пока человек печатает, поиск не запускается на каждую
   * букву. Через небольшой промежуток выполняется один запрос; ответы,
   * пришедшие позже последнего запроса, отбрасываются.
   */

  import { onMount } from 'svelte'
  import type { Idea, Material } from '../data'
  import { searchService } from './SearchService'
  import { buildSnippet, normalizeForSearch } from './snippet'
  import type { Snippet } from './snippet'
  import type { SearchHit, SearchStats } from './types'

  let {
    ideas = [],
    materials = {},
    onOpenIdea,
  }: {
    /**
     * Идеи и материалы приходят с основного экрана: там они уже прочитаны.
     * Так для куска текста не нужно лишний раз ходить в базу.
     */
    ideas?: Idea[]
    materials?: Record<string, Material[]>
    /**
     * Перейти к идее в списке. `true` — перешли и подсветили,
     * `false` — идеи в списке нет, покажем её содержимое здесь.
     */
    onOpenIdea?: (ideaId: string) => boolean | void
  } = $props()

  /** Небольшая пауза после последней буквы: не искать на каждый символ. */
  const DEBOUNCE_MS = 250

  let query = $state('')
  let hits = $state<SearchHit[]>([])
  let searching = $state(false)
  let ready = $state(false)
  let indexError = $state<string | null>(null)
  let searchError = $state<string | null>(null)
  let searchedFor = $state('')
  let stats = $state<SearchStats | null>(null)
  /** Какой результат раскрыт целиком — запасной путь, если до идеи не дошли. */
  let expandedId = $state<string | null>(null)

  /** Номер последнего запроса: ответы прошлых запросов уже не нужны. */
  let requestId = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  const ideaById = $derived(new Map(ideas.map((idea) => [idea.id, idea])))

  const results = $derived.by(() => hits.map((hit) => describeHit(hit)))

  onMount(() => {
    let alive = true
    void (async () => {
      try {
        // Первое обращение читает сохранённый индекс или собирает его заново.
        await searchService.ensure()
        if (!alive) return
        stats = searchService.stats()
        ready = true
      } catch (e) {
        if (!alive) return
        indexError = describe(e)
      }
    })()

    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
  })

  // Запрос меняется — старый таймер гасим, новый ставим с задержкой.
  $effect(() => {
    const text = query.trim()
    if (timer) clearTimeout(timer)
    timer = null
    const id = ++requestId

    if (text === '') {
      hits = []
      searching = false
      searchError = null
      searchedFor = ''
      expandedId = null
      return
    }

    searching = true
    searchError = null
    timer = setTimeout(() => {
      timer = null
      void run(text, id)
    }, DEBOUNCE_MS)
  })

  /** Один поиск. Ответ применяется, только если он всё ещё актуален. */
  async function run(text: string, id: number): Promise<void> {
    try {
      const found = await searchService.search(text)
      if (id !== requestId) return
      hits = found
      searchedFor = text
      searchError = null
      stats = searchService.stats()
      ready = true
    } catch (e) {
      if (id !== requestId) return
      hits = []
      searchError = describe(e)
    } finally {
      if (id === requestId) searching = false
    }
  }

  /** Заголовок, кусок текста и подпись «где нашлось» для одной находки. */
  function describeHit(hit: SearchHit): {
    hit: SearchHit
    idea: Idea | undefined
    title: string
    snippet: Snippet | null
    source: string
  } {
    const idea = ideaById.get(hit.id)
    const title = titleOf(hit, idea)
    let text = ''
    let source = ''

    // Текст материала — самое ценное совпадение: имя файла о содержании
    // ничего не говорит. Если индекс нашёл слово в материалах, показываем их.
    if (hit.fields.includes('materials')) {
      const materialText = materialTextFor(hit.id, hit.terms)
      if (materialText !== '') {
        text = materialText
        source = 'в тексте материала'
      }
    }
    if (text === '' && idea?.body.trim()) {
      text = idea.body
      source = 'в тексте идеи'
    }
    if (text === '') {
      text = title
      source = 'в заголовке'
    }

    return { hit, idea, title, snippet: buildSnippet(text, hit.terms), source }
  }

  /** Название идеи; если его нет — первая строка текста. */
  function titleOf(hit: SearchHit, idea: Idea | undefined): string {
    const title = idea?.title.trim() ?? ''
    if (title !== '') return title
    const body = idea?.body.trim() ?? ''
    if (body !== '') return body.split('\n')[0].trim()
    return hit.title.trim() || 'Без названия'
  }

  /** Самый подходящий текст материала: где раньше встретилось слово. */
  function materialTextFor(ideaId: string, terms: readonly string[]): string {
    const list = materials[ideaId] ?? []
    let best = ''
    let bestIndex = Number.POSITIVE_INFINITY

    for (const material of list) {
      const text = (material.extracted_text ?? '').trim()
      if (text === '') continue
      const haystack = normalizeForSearch(text)
      for (const term of terms) {
        const index = haystack.indexOf(term)
        if (index >= 0 && index < bestIndex) {
          best = text
          bestIndex = index
        }
      }
    }
    if (best !== '') return best

    // Точной формы нет (слово нашлось с опечаткой) — берём первый непустой текст.
    for (const material of list) {
      const text = (material.extracted_text ?? '').trim()
      if (text !== '') return text
    }
    return ''
  }

  /** Тексты материалов для раскрытого результата. */
  function materialTexts(ideaId: string): string[] {
    return (materials[ideaId] ?? [])
      .map((material) => (material.extracted_text ?? '').trim())
      .filter((text) => text !== '')
  }

  /** Нажатие на результат: уходим к идее или раскрываем её здесь. */
  function open(id: string): void {
    if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) {
      // На телефоне убираем клавиатуру: иначе она закрывает найденную идею.
      document.activeElement.blur()
    }
    const moved = onOpenIdea?.(id)
    expandedId = moved === false || moved === undefined ? (expandedId === id ? null : id) : null
  }

  /** Escape очищает поле — привычное поведение поиска. */
  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && query !== '') {
      event.preventDefault()
      query = ''
    }
  }

  function describe(e: unknown): string {
    return e instanceof Error ? e.message : 'неизвестная ошибка'
  }

  function plural(n: number, one: string, few: string, many: string): string {
    const last = n % 10
    const lastTwo = n % 100
    if (last === 1 && lastTwo !== 11) return one
    if (last >= 2 && last <= 4 && (lastTwo < 10 || lastTwo >= 20)) return few
    return many
  }

  /** Сколько идей в индексе и что делать дальше — простыми словами. */
  const indexLine = $derived.by(() => {
    const count = stats?.ideas ?? 0
    if (count === 0) {
      return 'Пока искать нечего: добавьте идею — и она сразу появится в поиске.'
    }
    return `В поиске ${count} ${plural(count, 'идея', 'идеи', 'идей')}. Введите слово — найдём его в названиях, тексте идей и расшифровках.`
  })
</script>

<section class="search">
  <h2>Поиск</h2>

  <label class="field">
    <span class="sr-only">Поиск по идеям</span>
    <input
      type="search"
      bind:value={query}
      onkeydown={onKeydown}
      placeholder="Например: аэрогриль, подарок, аккорды"
      aria-label="Поиск по идеям"
      autocomplete="off"
      spellcheck="false"
      enterkeyhint="search"
    />
  </label>

  {#if indexError}
    <p class="state failed" role="status" aria-live="polite">
      Поиск не удалось подготовить: {indexError} Идеи на месте — можно продолжать ими пользоваться.
    </p>
  {:else if !ready}
    <p class="state" role="status" aria-live="polite">
      Готовлю поиск… На большом количестве идей это может занять несколько секунд.
    </p>
  {:else if searchError}
    <p class="state failed" role="status" aria-live="polite">
      Поиск не удался: {searchError}
    </p>
  {:else if query.trim() === ''}
    <p class="state" role="status">{indexLine}</p>
  {:else if searching}
    <p class="state" role="status" aria-live="polite">Ищу «{query.trim()}»…</p>
  {:else if hits.length === 0}
    <p class="state" role="status" aria-live="polite">
      Ничего не найдено по слову «{searchedFor}». Попробуйте другое слово или его начало.
    </p>
  {:else}
    <p class="state" role="status" aria-live="polite">
      Нашлось {hits.length}
      {plural(hits.length, 'идея', 'идеи', 'идей')}. Нажмите на результат — идея откроется в списке.
    </p>
  {/if}

  {#if results.length > 0 && !searching}
    <ul class="hits">
      {#each results as view (view.hit.id)}
        <li>
          <button type="button" class="hit" onclick={() => open(view.hit.id)}>
            <span class="title">{view.title}</span>
            {#if view.source}
              <span class="where">{view.source}</span>
            {/if}
            {#if view.snippet}
              <span class="snippet">
                {#each view.snippet.parts as part}
                  {#if part.match}<mark>{part.text}</mark>{:else}{part.text}{/if}
                {/each}
              </span>
            {/if}
          </button>

          {#if expandedId === view.hit.id}
            <div class="details">
              {#if view.idea?.body.trim()}
                <p>{view.idea.body}</p>
              {/if}
              {#each materialTexts(view.idea?.id ?? view.hit.id) as text, index (index)}
                <p>{text}</p>
              {/each}
              {#if !view.idea?.body.trim() && materialTexts(view.idea?.id ?? view.hit.id).length === 0}
                <p>{view.title}</p>
              {/if}
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .search {
    margin: 0 0 26px;
    padding: 15px 14px 14px;
    border-radius: 14px;
    background: #0d1320;
    border: 1px solid #1b2130;
  }

  h2 {
    margin: 0 0 10px;
    font-size: 15px;
    font-weight: 600;
    color: #97a3b8;
  }

  .field {
    display: block;
  }

  input {
    width: 100%;
    box-sizing: border-box;
    padding: 12px 14px;
    border-radius: 12px;
    border: 1px solid #232a3b;
    background: #111725;
    color: #e8ecf2;
    font: inherit;
    /* На телефоне поле не должно прыгать при появлении клавиатуры. */
    font-size: 16px;
  }

  input::placeholder {
    color: #66718a;
  }

  input:focus {
    outline: none;
    border-color: #ff8a5b;
  }

  input::-webkit-search-cancel-button {
    filter: invert(0.6);
  }

  .state {
    margin: 10px 0 0;
    font-size: 13px;
    color: #66718a;
    overflow-wrap: anywhere;
  }

  .failed {
    color: #ff9b7a;
  }

  .hits {
    list-style: none;
    margin: 12px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .hit {
    display: block;
    width: 100%;
    box-sizing: border-box;
    padding: 11px 12px;
    border-radius: 11px;
    border: 1px solid #1d2433;
    background: #111725;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .hit:hover {
    border-color: #2e374b;
  }

  .hit:focus-visible {
    outline: 2px solid #ff8a5b;
    outline-offset: 2px;
  }

  .title {
    display: block;
    font-size: 15px;
    font-weight: 600;
    color: #e8ecf2;
    overflow-wrap: anywhere;
  }

  .where {
    display: inline-block;
    margin-top: 3px;
    font-size: 11px;
    color: #5fd4a8;
  }

  .snippet {
    display: block;
    margin-top: 5px;
    font-size: 13px;
    line-height: 1.45;
    color: #97a3b8;
    overflow-wrap: anywhere;
  }

  mark {
    border-radius: 3px;
    padding: 0 1px;
    background: rgba(255, 138, 91, 0.2);
    color: #ffc3a6;
  }

  .details {
    margin-top: 6px;
    padding: 10px 12px;
    border-radius: 9px;
    background: #0d1320;
    border: 1px solid #1b2130;
    max-height: 280px;
    overflow-y: auto;
  }

  .details p {
    margin: 0 0 8px;
    font-size: 13px;
    line-height: 1.5;
    color: #c3cbd8;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .details p:last-child {
    margin-bottom: 0;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
</style>
