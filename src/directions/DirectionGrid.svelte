<script lang="ts">
  /**
   * Направления — вокруг поисковой строки, на главном экране.
   *
   * Замысел автора: поиск стоит в центре как **символ того, что ничего
   * не забывается**, а рядом — всё, что из идей уже сложилось. Нажал на
   * направление и рассмотрел его подробно.
   *
   * Почему это лучше прежнего: раньше направления лежали на отдельном
   * экране «Ещё», между копией и пояснениями. То есть главное, что продукт
   * умеет — собирать идеи в понятные группы, — было спрятано дальше всего.
   */
  import { onMount } from 'svelte'
  import { directionStore } from '../data'
  import type { Direction, Idea } from '../data'

  let {
    ideas,
    onPick,
  }: { ideas: readonly Idea[]; onPick: (direction: Direction) => void } = $props()

  let directions = $state<Direction[]>([])
  let error = $state<string | null>(null)

  onMount(() => {
    void (async () => {
      try {
        directions = await directionStore.list()
      } catch (e) {
        error = e instanceof Error ? e.message : String(e)
      }
    })()
  })

  /**
   * Сколько идей в направлении.
   *
   * Архивные не считаем: направление показывает то, что в работе. Иначе
   * число врало бы — «Дача · 12», а открываешь и половина в архиве.
   */
  function count(direction: Direction): number {
    return ideas.filter((idea) => idea.direction_id === direction.id).length
  }

  const shown = $derived(directions.filter((direction) => count(direction) > 0))
  const withoutDirection = $derived(ideas.filter((idea) => !idea.direction_id).length)
</script>

{#if error}
  <p class="error">Не удалось прочитать направления: {error}</p>
{:else if shown.length > 0}
  <div class="grid">
    {#each shown as direction (direction.id)}
      <button type="button" class="chip" onclick={() => onPick(direction)}>
        <span class="name">{direction.icon ? `${direction.icon} ` : ''}{direction.name}</span>
        <span class="count">{count(direction)}</span>
      </button>
    {/each}
  </div>
  <p class="hint">
    Это всё, что уже сложилось из ваших идей. Нажмите — и увидите, что внутри.
    {#if withoutDirection > 0}
      Ещё {withoutDirection} не разложены — они появятся здесь после разбора.
    {/if}
  </p>
{:else if ideas.length > 0}
  <p class="hint">
    Направлений пока нет. Нажмите «Разложить по направлениям» — и идеи соберутся
    в понятные группы, а они появятся здесь.
  </p>
{/if}

<style>
  .grid {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    background: #111725;
    border: 1px solid #1d2433;
    border-radius: 999px;
    color: #e7edf7;
    font: inherit;
    font-size: 14px;
    padding: 9px 14px;
    cursor: pointer;
  }

  .chip:hover {
    border-color: #2f6f63;
  }

  .count {
    color: #5eead4;
    font-size: 13px;
  }

  .hint {
    margin: 10px 0 0;
    color: #66718a;
    font-size: 13px;
  }

  .error {
    margin: 0;
    color: #fca5a5;
    font-size: 13px;
  }
</style>
