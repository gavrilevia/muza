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
  import { SELECT_LIMIT, describeFilters, selectIdeas } from './logic'

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

  const result = $derived(
    query.trim().length < 2
      ? null
      : selectIdeas(ideas, materials, query, new Date(), SELECT_LIMIT),
  )

  function title(idea: Idea): string {
    return (idea.title || idea.body).trim().slice(0, 140)
  }
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

  .hint {
    margin: 9px 0 0;
    color: #66718a;
    font-size: 12px;
  }
</style>
