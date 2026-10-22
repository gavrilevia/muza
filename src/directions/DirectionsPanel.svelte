<script lang="ts">
  /**
   * Первый видимый экран продукта: «Муза» сама раскладывает идеи
   * по направлениям.
   *
   * Порядок работы: пользователь вставляет ключ polza.ai, жмёт
   * «Разложить по направлениям» — и получает сетку направлений с идеями.
   * Всё, что делает сервис, — в `DirectionService.ts`; здесь только показ
   * прогресса, расхода и результата.
   *
   * Интерфейс не блокируется: обработка идёт по одной идее, после каждой
   * обновляется строка «разложено N из M». Фоновых трат нет — модель
   * зовётся только по нажатию кнопки.
   */

  import { onMount } from 'svelte'
  import { directionStore } from '../data'
  import type { Direction, Idea } from '../data'
  import ApiKeyField from './ApiKeyField.svelte'
  import { DirectionService } from './DirectionService'
  import { formatRub } from './logic'
  import { readApiKey } from './meta'
  import type { AssignManyResult } from './types'

  let {
    ideas = [],
    onIdeasChanged,
  }: {
    /**
     * Идеи приходят с основного экрана.
     *
     * Панель НЕ читает их сама: иначе она видела бы только те, что были
     * в базе при её появлении, и после добавления новой идеи кнопка
     * «Разложить» оставалась бы неактивной до перезагрузки страницы.
     */
    ideas?: Idea[]
    /** Идеям присвоили направления — список на экране стоит перечитать. */
    onIdeasChanged?: () => void | Promise<void>
  } = $props()

  let hasKey = $state(false)
  let directions = $state<Direction[]>([])
  let busy = $state(false)
  /** Прогресс: сколько уже обработано и сколько всего. */
  let done = $state(0)
  let total = $state(0)
  let assigned = $state(0)
  let costRub = $state(0)
  let status = $state<string | null>(null)
  let failed = $state(false)

  /** Идеи без направления — именно их и раскладываем. */
  const unassigned = $derived(ideas.filter((idea) => idea.direction_id === null))

  /** Направления вместе со своими идеями — то, что видно в сетке. */
  const groups = $derived(
    directions.map((direction) => ({
      direction,
      items: ideas.filter((idea) => idea.direction_id === direction.id),
    })),
  )

  onMount(() => {
    void refresh()
  })

  /** Перечитывает ключ и направления. Идеи приходят свойством сверху. */
  async function refresh(): Promise<void> {
    try {
      const [key, list] = await Promise.all([
        readApiKey(),
        directionStore.list(),
      ])
      hasKey = key !== ''
      directions = list
      failed = false
    } catch (e) {
      failed = true
      status = `Не удалось прочитать данные: ${describe(e)}`
    }
  }

  /** Разложить все идеи без направления. */
  async function run(): Promise<void> {
    if (busy) return
    const pending = unassigned
    if (pending.length === 0) {
      failed = false
      status = 'Все идеи уже разложены по направлениям.'
      return
    }

    busy = true
    failed = false
    done = 0
    total = pending.length
    assigned = 0
    costRub = 0
    status = 'Раскладываю по направлениям…'

    try {
      const service = new DirectionService()
      const result = await service.assignMany(pending, {
        onProgress: (progress) => {
          done = progress.done
          total = progress.total
          assigned = progress.assigned
          costRub = progress.costRub
        },
      })
      status = describeRun(result)
      failed = result.stopped
      await refresh()
      await onIdeasChanged?.()
    } catch (e) {
      // Идеи целы: сервис не бросает их, а эта ветка — последняя страховка.
      failed = true
      status = `Обработка прервалась: ${describe(e)} Идеи не потеряны.`
    } finally {
      busy = false
    }
  }

  /** Итог обработки словами: сколько разложили, сколько осталось, расход. */
  function describeRun(result: AssignManyResult): string {
    const parts = [`Разложено ${result.assigned} из ${result.total}.`]
    if (result.lowConfidence > 0) parts.push(`Модель не была уверена: ${result.lowConfidence}.`)
    if (result.failed > 0) {
      parts.push(`Не обработано из-за ошибок: ${result.failed}.`)
      // Показываем первую причину: пользователю важно понять, что делать.
      const firstError = result.outcomes.find((outcome) => outcome.error_message !== null)
      if (firstError?.error_message) parts.push(`Причина: ${firstError.error_message}`)
    }
    parts.push(`Потрачено: ${formatRub(result.costRub)}.`)
    if (result.unassigned > 0) parts.push(`Без направления осталось: ${result.unassigned} — они в инбоксе, ничего не потеряно.`)
    if (result.stopped && result.stopReason === 'no_key') {
      parts.push('Ключ polza.ai не задан — запросы к модели не уходили.')
    }
    if (result.stopped && result.stopReason === 'budget') {
      parts.push('Достигнут заданный лимит расходов — обработку можно продолжить позже.')
    }
    return parts.join(' ')
  }

  /** Заголовок идеи для карточки; тело — запасной вариант. */
  function display(idea: Idea): string {
    const text = idea.title || idea.body
    return text.length > 140 ? `${text.slice(0, 140)}…` : text
  }

  function describe(e: unknown): string {
    return e instanceof Error ? e.message : 'неизвестная ошибка'
  }

  function plural(n: number, one: string, few: string, many: string): string {
    const m10 = n % 10
    const m100 = n % 100
    if (m10 === 1 && m100 !== 11) return one
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few
    return many
  }
</script>

<section class="directions">
  <h2>Направления</h2>

  <ApiKeyField onChanged={refresh} />

  <div class="row">
    <button
      type="button"
      class="btn"
      onclick={() => void run()}
      disabled={busy || !hasKey || unassigned.length === 0}
    >
      {busy ? 'Раскладываю…' : 'Разложить по направлениям'}
    </button>
    <span class="hint">
      {#if !hasKey}
        Сначала вставьте ключ polza.ai — без него разбор недоступен.
      {:else if unassigned.length === 0}
        Все идеи уже разложены.
      {:else}
        {unassigned.length}
        {plural(unassigned.length, 'идея', 'идеи', 'идей')} ждёт разбора
      {/if}
    </span>
  </div>

  {#if busy || total > 0}
    <p class="progress" role="status" aria-live="polite">
      разложено {done} из {total} · присвоено {assigned} · потрачено {formatRub(costRub)}
    </p>
  {/if}

  {#if status}
    <p class="status" class:failed role="status" aria-live="polite">{status}</p>
  {/if}

  {#if groups.length === 0}
    <p class="empty">
      Направлений пока нет. Добавьте идеи и нажмите «Разложить по направлениям» — они
      соберутся в понятные группы.
    </p>
  {:else}
    <div class="grid">
      {#each groups as group (group.direction.id)}
        <article class="card">
          <header class="card-head">
            <h3>
              {#if group.direction.icon}{group.direction.icon}{/if}
              {group.direction.name}
            </h3>
            <span class="count">
              {group.items.length}
              {plural(group.items.length, 'идея', 'идеи', 'идей')}
            </span>
          </header>
          {#if group.items.length === 0}
            <p class="card-empty">Пока пусто.</p>
          {:else}
            <ul>
              {#each group.items as idea (idea.id)}
                <li>{display(idea)}</li>
              {/each}
            </ul>
          {/if}
        </article>
      {/each}
    </div>
  {/if}
</section>

<style>
  .directions {
    margin: 26px 0;
    padding-top: 20px;
    border-top: 1px solid #1b2130;
  }

  h2 {
    margin: 0 0 12px;
    font-size: 15px;
    font-weight: 600;
    color: #97a3b8;
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

  .progress {
    margin: 12px 0 0;
    font-size: 13px;
    color: #5fd4a8;
  }

  .status {
    margin: 10px 0 0;
    font-size: 13px;
    color: #97a3b8;
  }

  .failed {
    color: #ff9b7a;
  }

  .empty {
    margin: 14px 0 0;
    font-size: 14px;
    color: #66718a;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 10px;
    margin-top: 16px;
  }

  .card {
    padding: 12px 13px;
    border-radius: 12px;
    background: #111725;
    border: 1px solid #1d2433;
  }

  .card-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 8px;
  }

  h3 {
    margin: 0;
    font-size: 15px;
    font-weight: 650;
    color: #e8ecf2;
    overflow-wrap: anywhere;
  }

  .count {
    flex: none;
    font-size: 12px;
    color: #66718a;
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  li {
    font-size: 13px;
    color: #c3cbd8;
    overflow-wrap: anywhere;
    padding-left: 10px;
    position: relative;
  }

  li::before {
    content: '';
    position: absolute;
    left: 0;
    top: 8px;
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: #ff8a5b;
  }

  .card-empty {
    margin: 0;
    font-size: 13px;
    color: #66718a;
  }
</style>
