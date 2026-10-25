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
   * в `captureMany`, а тот сначала сохраняет идеи и только потом материалы.
   * Файлов несколько — идей столько же, по одной на файл.
   */

  import { onMount } from 'svelte'
  import { ideaRepository, materialRepository } from './data'
  import type { Idea, Material } from './data'
  import { CaptureChannels, asCaptureFile, captureMany, describeCaptureError } from './capture'
  import { clearSharedHandoff, peekSharedHandoff, pluralRu, shareReturnState, shouldAcceptShare } from './capture'
  import type { CaptureBatchOutcome, CaptureFile, CaptureRequest } from './capture'
  import { BackupPanel } from './backup'
  import { DirectionsPanel } from './directions'
  import { SearchPanel, searchService } from './search'
  import { TranscribeButton } from './video'

  let text = $state('')
  let ideas = $state<Idea[]>([])
  /**
   * Материалы идей: нужны, чтобы показать «Расшифровать» там, где есть видео
   * или голос без текста, и чтобы показать готовую расшифровку.
   */
  let materials = $state<Record<string, Material[]>>({})
  /** Текст ошибки слоя данных: показываем вместо списка, если база недоступна. */
  let dbError = $state<string | null>(null)
  /** Идея, к которой пришли из поиска: её карточку подсвечиваем. */
  let highlightId = $state<string | null>(null)
  let highlightTimer: ReturnType<typeof setTimeout> | null = null

  onMount(() => {
    void boot()
  })

  /** Загрузка и приём «Поделиться» — по очереди, чтобы входящие встали в список. */
  async function boot() {
    await load()
    await acceptShared()
  }

  /**
   * Копию восстановили: список перечитываем, а поиск собираем заново.
   * Импорт мог добавить идеи и тексты мимо обычных путей сохранения.
   * Пересборку не ждём: она идёт в фоне, а экран поиска дождётся её сам.
   */
  async function onImported(): Promise<void> {
    await load()
    void searchService.build().catch(() => {
      /* идеи уже на месте; поиск соберётся при следующем обращении */
    })
  }

  /** Читает идеи и их материалы из IndexedDB. */
  async function load() {
    try {
      const list = await ideaRepository.list({ sortBy: 'captured_at', order: 'desc' })
      ideas = list
      materials = await loadMaterials(list)
      dbError = null
    } catch (e) {
      dbError = errorText(e)
    }
  }

  /**
   * Материалы всех идей. Читаем по идее, а не всё хранилище разом: в памяти
   * оказываются материалы одной идеи, а не все видео сразу. Сбой чтения
   * одной идеи не роняет список — просто у неё не будет кнопки.
   */
  async function loadMaterials(list: readonly Idea[]): Promise<Record<string, Material[]>> {
    const map: Record<string, Material[]> = {}
    await Promise.all(
      list.map(async (idea) => {
        try {
          map[idea.id] = await materialRepository.listByIdea(idea.id)
        } catch {
          map[idea.id] = []
        }
      }),
    )
    return map
  }

  /** Материалы идеи, у которых может быть речь: видео и голосовые заметки. */
  function transcribable(idea: Idea): Material[] {
    return (materials[idea.id] ?? []).filter(
      (material) => material.kind === 'video' || material.kind === 'audio',
    )
  }

  /** Материал изменился (появился текст или отметка об ошибке) — обновляем список. */
  function applyMaterial(updated: Material) {
    const list = materials[updated.idea_id] ?? []
    materials = {
      ...materials,
      [updated.idea_id]: list.map((material) => (material.id === updated.id ? updated : material)),
    }
    // Расшифровка готова: переиндексируем идею, иначе новый текст найдётся
    // только после перезагрузки страницы.
    updateSearchIndex(searchService.indexMaterial(updated))
  }

  /**
   * Обновление поискового индекса в фоне.
   *
   * Поиск не должен задерживать сохранение идеи или расшифровку. Сбой
   * индекса тоже не отменяет данные: идея и материал уже в базе, просто
   * поиск временно останется прежним.
   */
  function updateSearchIndex(work: Promise<void>): void {
    void work.catch(() => {
      /* идея и материал уже сохранены — это главное */
    })
  }

  /**
   * Переход из поиска к идее: прокрутка к карточке и короткая подсветка.
   * `false` — идеи в списке уже нет (например, индекс не успел обновиться);
   * тогда экран поиска покажет её содержимое сам.
   */
  function openIdea(id: string): boolean {
    const element = document.getElementById(`idea-${id}`)
    if (!element) return false
    element.scrollIntoView({ behavior: 'smooth', block: 'center' })
    highlightId = id
    if (highlightTimer) clearTimeout(highlightTimer)
    highlightTimer = setTimeout(() => {
      if (highlightId === id) highlightId = null
      highlightTimer = null
    }, 2600)
    return true
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
      updateSearchIndex(searchService.indexIdea(idea))
      text = ''
      dbError = null
    } catch (e) {
      dbError = errorText(e)
    }
  }

  /**
   * Единая точка сохранения для всех каналов, кроме «+».
   *
   * Бросает только тогда, когда не сохранилось ничего: канал покажет
   * сообщение, а набранный текст останется в поле. Сбой на одном файле
   * из нескольких остальные не отменяет — об этом скажет `warning`.
   */
  async function saveCapture(request: CaptureRequest): Promise<CaptureBatchOutcome> {
    const batch = await captureMany(request)
    // Идеи встают в порядке файлов: первая идея — первый файл.
    ideas = [...batch.outcomes.map((outcome) => outcome.idea), ...ideas]
    // Материалы только что захваченных идей — сразу в список: у видео
    // и голосовой заметки тут же появится «Расшифровать», без перезагрузки.
    const added: Record<string, Material[]> = {}
    for (const outcome of batch.outcomes) {
      added[outcome.idea.id] = outcome.materials
      // Новая идея должна находиться поиском сразу, вместе с уже
      // приложенными к ней материалами.
      updateSearchIndex(searchService.indexIdea(outcome.idea))
    }
    materials = { ...materials, ...added }
    // Прошлая ошибка больше не «висит»: предупреждение о частичном сбое
    // вызывающий выставит сам, уже после этого.
    dbError = null
    return batch
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
      .then((batch) => {
        // Поле очищаем только если текст действительно уехал в идею.
        if (batch.textConsumed) text = ''
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
      const batch = await saveCapture({
        channel: 'share',
        text: handoff.text,
        sourceTitle: handoff.title,
        url: handoff.url,
        files: handoff.files,
      })
      await clearSharedHandoff()
      dbError = batch.warning
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
      updateSearchIndex(searchService.removeIdea(id))
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

  <!-- Поиск по названиям, тексту идей и расшифровкам — без сети. -->
  <SearchPanel {ideas} {materials} onOpenIdea={openIdea} />

  <!-- Ключевой экран продукта: идеи сами собираются в направления. -->
  <DirectionsPanel {ideas} onIdeasChanged={load} />

  <section class="list">
    <h2>
      {ideas.length}
      {pluralRu(ideas.length, 'идея', 'идеи', 'идей')}
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
          <li id={`idea-${idea.id}`} class:found={highlightId === idea.id}>
            <div class="line">
              <span class="txt">{display(idea)}</span>
              <button
                class="del"
                onclick={() => remove(idea.id)}
                aria-label="Удалить"
                title="Удалить"
              >
                ×
              </button>
            </div>
            {#each transcribable(idea) as material (material.id)}
              <TranscribeButton {material} onChanged={applyMaterial} />
            {/each}
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <section class="backup">
    <h2>Копия идей</h2>
    <BackupPanel ideasCount={ideas.length} onImported={onImported} />
  </section>

  <section class="next">
    <h2>Что дальше</h2>
    <p>
      Идеи и материалы живут в IndexedDB на устройстве и переживают
      перезагрузку. Копия идей сохраняется одним файлом: zip-архив со всеми
      идеями и материалами.
    </p>
    <p>
      <strong>Как получить из идеи смысл.</strong> У видео и голосовых заметок
      нажмите <strong>«Расшифровать»</strong> — речь станет текстом, и по нему
      заработает поиск. Русская речь распознаётся русской моделью, нерусская —
      общей; стоимость видна после каждой расшифровки.
    </p>
    <p>
      Потом нажмите <strong>«Разложить по направлениям»</strong> — идеи
      соберутся в 5–9 понятных групп. По одному имени файла модель ничего не
      поймёт, поэтому расшифровка идёт первой. Ключ хранится только в этом
      браузере.
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
    padding: 12px 13px;
    border-radius: 11px;
    background: #111725;
    border: 1px solid #1d2433;
    transition: border-color 0.2s ease, box-shadow 0.2s ease, background 0.2s ease;
  }

  /* Идея, к которой пришли из поиска: заметно, но не навсегда. */
  li.found {
    border-color: #ff8a5b;
    background: #171b26;
    box-shadow: 0 0 0 2px rgba(255, 138, 91, 0.18);
  }

  .line {
    display: flex;
    align-items: flex-start;
    gap: 10px;
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

  .backup {
    margin-top: 30px;
    padding-top: 20px;
    border-top: 1px solid #1b2130;
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
