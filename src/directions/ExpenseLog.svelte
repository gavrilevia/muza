<script lang="ts">
  /**
   * Журнал расходов: разбор трат, а не одна цифра.
   *
   * После каждого действия человек видит «0,01 ₽». Но по одной цифре нельзя
   * решить, что улучшать: она может сложиться по-разному. Главное, что здесь
   * видно, — **доля кэша**. Если она ноль, промпт в кэш не попадает, и мы
   * платим втрое больше, чем могли бы.
   */
  import { onMount } from 'svelte'
  import {
    clearExpenses,
    onExpenseRecorded,
    readExpenses,
    summarize,
    type ExpenseSummary,
  } from './expenses'

  let summary = $state<ExpenseSummary | null>(null)
  let loading = $state(true)

  const rub = (value: number): string =>
    value >= 1 ? `${value.toFixed(2)} ₽` : `${value.toFixed(4)} ₽`

  const percent = (value: number): string => `${Math.round(value * 100)}%`

  async function refresh(): Promise<void> {
    loading = true
    summary = summarize(await readExpenses())
    loading = false
  }

  onMount(() => {
    void refresh()
    // Новая трата — журнал обновляется сам: иначе он показывал бы пустоту
    // сразу после того, как деньги потрачены.
    return onExpenseRecorded(() => void refresh())
  })
</script>

<section class="log">
  <h2>Журнал расходов</h2>

  {#if loading}
    <p class="note">Читаю…</p>
  {:else if !summary || summary.requests === 0}
    <p class="note">
      Пока пусто. Как только что-нибудь обратится к модели — разбор, подбор,
      расшифровка, — здесь появятся числа.
    </p>
  {:else}
    <p class="note">
      Всего <strong>{rub(summary.costRub)}</strong> за {summary.requests}
      {summary.requests === 1 ? 'запрос' : 'запросов'}.
    </p>

    <!-- Это число и есть предмет анализа: попадает ли промпт в кэш. -->
    <p class="cache" class:bad={summary.cacheShare === 0}>
      Из кэша пришло <strong>{percent(summary.cacheShare)}</strong> запроса
      ({summary.cachedTokens} из {summary.promptTokens} токенов).
      {#if summary.cacheShare === 0}
        Кэш не работает — платим как за обычный текст, а он в 12 раз дороже.
      {:else if summary.cacheShare < 0.5}
        Кэш работает частично. Это главный резерв экономии.
      {:else}
        Кэш работает: это заметно дешевле.
      {/if}
    </p>

    <table>
      <thead>
        <tr>
          <th>Задача</th>
          <th>Запросов</th>
          <th>Токенов</th>
          <th>Из кэша</th>
          <th>Цена</th>
        </tr>
      </thead>
      <tbody>
        {#each summary.byTask as row (row.task)}
          <tr>
            <td>{row.task}</td>
            <td>{row.requests}</td>
            <td>{row.promptTokens}</td>
            <td>{row.promptTokens > 0 ? percent(row.cachedTokens / row.promptTokens) : '—'}</td>
            <td>{rub(row.costRub)}</td>
          </tr>
        {/each}
      </tbody>
    </table>

    <p class="note">
      В ответе модели {summary.completionTokens} токенов — они дороже всех
      остальных, поэтому короткий ответ экономит больше, чем короткий промпт.
    </p>

    <button
      type="button"
      class="link"
      onclick={() => void clearExpenses().then(refresh)}
    >
      Стереть журнал
    </button>
  {/if}
</section>

<style>
  .log {
    margin-top: 18px;
    padding: 14px;
    border-radius: 12px;
    background: #131a2a;
    border: 1px solid #26324a;
  }

  h2 {
    margin: 0 0 8px;
    font-size: 16px;
    color: #e7edf7;
  }

  .note {
    margin: 0 0 9px;
    color: #a9b4c9;
    font-size: 13px;
    line-height: 1.45;
  }

  .note strong,
  .cache strong {
    color: #e7edf7;
  }

  .cache {
    margin: 0 0 11px;
    padding: 10px;
    border-radius: 9px;
    background: #0d1320;
    border: 1px solid #1d2433;
    color: #5eead4;
    font-size: 13px;
    line-height: 1.45;
  }

  .cache.bad {
    color: #fca5a5;
    border-color: #4b1d1d;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
    margin-bottom: 10px;
  }

  th {
    text-align: left;
    color: #66718a;
    font-weight: 400;
    padding: 5px 6px 5px 0;
    border-bottom: 1px solid #1d2433;
  }

  td {
    color: #c7d2e5;
    padding: 5px 6px 5px 0;
    border-bottom: 1px solid #161c29;
  }

  .link {
    background: none;
    border: 0;
    padding: 0;
    font: inherit;
    font-size: 13px;
    color: #5eead4;
    text-decoration: underline;
    cursor: pointer;
  }
</style>
