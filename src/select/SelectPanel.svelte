<script lang="ts">
  /**
   * Подбор: «что сейчас кстати».
   *
   * Главная функция продукта. Здесь — **первый уровень**: локальный фильтр,
   * который работает всегда, бесплатно и без сети (`АРХИТЕКТУРА.md`, §8).
   *
   * Модель для этого не нужна — и это не компромисс, а правило замысла:
   * «модель не нужна для 80% запросов. Это и есть экономия».
   *
   * Поэтому здесь нет ни одной копейки расходов и ни одного запроса наружу.
   */
  import type { Idea, Material } from '../data'
  import { createLlmClient, rankIdeas, type Ranking } from '../ai'
  import { metaStore } from '../directions/meta'
  import { SELECT_LIMIT, describeFilters, selectIdeas } from './logic'

  /**
   * Сколько кандидатов отдаём модели.
   *
   * Двадцать — из замысла (`АРХИТЕКТУРА.md`, §8): модель выбирает из
   * короткого списка точнее, и это в разы дешевле, чем отдать всю базу.
   */
  const CANDIDATES_FOR_MODEL = 20

  let {
    ideas,
    materials,
    onOpenIdea,
  }: {
    ideas: readonly Idea[]
    materials: Record<string, Material[]>
    onOpenIdea: (idea: Idea) => void
  } = $props()

  let query = $state('')

  /**
   * Модель зовём ТОЛЬКО по кнопке.
   *
   * Локальный отбор бесплатный и работает всегда; этот — единственное
   * место в подборе, которое стоит денег. Решает человек, а не автоматика.
   */
  let asking = $state(false)
  let ranking = $state<Ranking | null>(null)
  let askedFor = $state('')
  let askError = $state<string | null>(null)
  let costRub = $state<number | null>(null)

  async function askModel(): Promise<void> {
    const text = query.trim()
    if (text === '') return
    asking = true
    askError = null
    ranking = null
    costRub = null
    try {
      // Сначала локальный отбор — он бесплатный. Модель получает его итог,
      // а не всю базу.
      const local = selectIdeas(
        ideas,
        materials,
        text,
        new Date(),
        CANDIDATES_FOR_MODEL,
      )
      const candidates = local.candidates.map((candidate) => ({
        id: candidate.idea.id,
        title: (candidate.idea.title || candidate.idea.body).trim().slice(0, 160),
        ...(candidate.idea.kind ? { kind: candidate.idea.kind } : {}),
        ...(Object.keys(candidate.idea.props ?? {}).length > 0
          ? { props: Object.keys(candidate.idea.props ?? {}).slice(0, 8) }
          : {}),
      }))

      const client = await createLlmClient({ store: metaStore })
      const outcome = await rankIdeas(client, { query: text, candidates, limit: 5 })
      if (!outcome.ok) {
        askError = outcome.error.message
        costRub = outcome.usage.costRub
        return
      }
      ranking = outcome.data
      askedFor = text
      costRub = outcome.usage.costRub
    } catch (e) {
      askError = e instanceof Error ? e.message : String(e)
    } finally {
      asking = false
    }
  }

  function ideaById(id: string): Idea | undefined {
    return ideas.find((idea) => idea.id === id)
  }

  function title(idea: Idea): string {
    return (idea.title || idea.body).trim().slice(0, 140)
  }

  const result = $derived(
    query.trim().length < 2
      ? null
      : selectIdeas(ideas, materials, query, new Date(), SELECT_LIMIT),
  )
</script>

<section class="select">
  <h2>Что сейчас кстати</h2>
  <p class="note">
    Напишите, что нужно: «быстро приготовить из того, что есть», «подарок», «почитать».
    Подбор идёт на устройстве — без сети и без трат.
  </p>

  <input
    type="search"
    bind:value={query}
    placeholder="Например: быстро приготовить из того, что есть"
    aria-label="Подбор по запросу"
    enterkeyhint="search"
  />

  {#if result}
    <p class="understood">Понял так: {describeFilters(result.filters)}</p>

    {#if result.candidates.length === 0}
      <p class="empty">
        Ничего подходящего не нашлось. Попробуйте другие слова — или посмотрите весь список ниже.
      </p>
    {:else}
      <ul>
        {#each result.candidates as candidate (candidate.idea.id)}
          <li>
            <button type="button" class="pick" onclick={() => onOpenIdea(candidate.idea)}>
              <span class="txt">{title(candidate.idea)}</span>
              <span class="why">{candidate.why}</span>
            </button>
          </li>
        {/each}
      </ul>
      <p class="hint">
        Показано {result.candidates.length}. Список отсортирован по свойствам, свежести,
        близости момента и тому, пробовали вы это или нет.
      </p>

      <!-- Уровень 2: модель выбирает из двадцати. Только по кнопке —
           это единственное место в подборе, которое стоит денег. -->
      <button type="button" class="ask" onclick={() => void askModel()} disabled={asking}>
        {asking ? 'Спрашиваю модель…' : 'Спросить модель, что лучше'}
      </button>
      <p class="hint">
        Модель получит {CANDIDATES_FOR_MODEL} лучших из найденного и выберет до пяти
        с объяснением. Это платно — примерно копейки за запрос.
      </p>
    {/if}

    {#if askError}
      <p class="error">{askError}</p>
    {/if}

    {#if ranking}
      <div class="model">
        <h3>Выбор модели</h3>
        {#if ranking.selected.length === 0}
          <p class="empty">
            Модель не выбрала ничего.{#if ranking.reasoning} {ranking.reasoning}{/if}
          </p>
        {:else}
          <ul>
            {#each ranking.selected as pick (pick.id)}
              {@const idea = ideaById(pick.id)}
              {#if idea}
                <li>
                  <button type="button" class="pick" onclick={() => onOpenIdea(idea)}>
                    <span class="txt">{title(idea)}</span>
                    <span class="why">{pick.why}</span>
                  </button>
                </li>
              {/if}
            {/each}
          </ul>
        {/if}
        {#if costRub !== null}
          <p class="hint">
            Вопрос был про «{askedFor}». Стоимость: {costRub.toFixed(4)} ₽.
          </p>
        {/if}
      </div>
    {/if}
  {/if}
</section>

<style>
  .select {
    margin-top: 18px;
  }

  h2 {
    margin: 0 0 6px;
    font-size: 16px;
    color: #e7edf7;
  }

  .note {
    margin: 0 0 10px;
    color: #66718a;
    font-size: 13px;
  }

  input {
    width: 100%;
    box-sizing: border-box;
    background: #111725;
    border: 1px solid #1d2433;
    border-radius: 10px;
    color: #e7edf7;
    font: inherit;
    font-size: 15px;
    padding: 11px 13px;
  }

  input:focus {
    outline: none;
    border-color: #2f6f63;
  }

  input::placeholder {
    color: #4d5769;
  }

  .understood {
    margin: 9px 0 0;
    color: #5eead4;
    font-size: 13px;
  }

  ul {
    list-style: none;
    margin: 10px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .pick {
    width: 100%;
    text-align: left;
    background: #0d1320;
    border: 1px solid #1d2433;
    border-radius: 10px;
    padding: 10px 11px;
    font: inherit;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .pick:hover {
    border-color: #2f6f63;
  }

  .txt {
    color: #e7edf7;
    font-size: 14px;
    overflow-wrap: anywhere;
  }

  .why {
    color: #5eead4;
    font-size: 12px;
  }

  .empty {
    margin: 10px 0 0;
    color: #66718a;
    font-size: 14px;
  }

  .ask {
    margin-top: 12px;
    width: 100%;
    background: #1f6f5c;
    border: 0;
    border-radius: 10px;
    color: #ecfdf5;
    font: inherit;
    font-size: 14px;
    padding: 11px;
    cursor: pointer;
  }

  .ask:disabled {
    opacity: 0.6;
  }

  .model {
    margin-top: 14px;
    padding: 12px;
    border-radius: 12px;
    background: #131a2a;
    border: 1px solid #26324a;
  }

  .model h3 {
    margin: 0 0 8px;
    font-size: 15px;
    color: #e7edf7;
  }

  .error {
    margin: 10px 0 0;
    color: #fca5a5;
    font-size: 13px;
  }

  .hint {
    margin: 9px 0 0;
    color: #66718a;
    font-size: 12px;
  }
</style>
