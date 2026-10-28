<script lang="ts">
  /**
   * «Что сейчас кстати» — идеи, у которых момент близко.
   *
   * Раздел, а не уведомление: по замыслу (`АРХИТЕКТУРА.md`, раздел 7) момент
   * **не требует действия** и **не повторяет сам**. Здесь ничего не всплывает
   * поверх экрана, никуда не торопит и не показывает «просрочено».
   *
   * Действия — только спокойные и необязательные:
   * - «Убрать напоминание» — момент снимается, идея живёт дальше;
   * - «Отложить» — новый срок, если сейчас не время.
   */
  import { ideaRepository } from '../data'
  import type { Idea } from '../data'
  import { describeMoment, momentDateLabel, momentFromDays } from './logic'

  let { ideas, onChanged }: { ideas: readonly Idea[]; onChanged: () => void | Promise<void> } =
    $props()

  let busyId = $state<string | null>(null)
  let error = $state<string | null>(null)

  function title(idea: Idea): string {
    return (idea.title || idea.body).trim().slice(0, 120)
  }

  async function clear(idea: Idea): Promise<void> {
    busyId = idea.id
    error = null
    try {
      await ideaRepository.update(idea.id, { moment_at: null, moment_rule: null })
      await onChanged()
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      busyId = null
    }
  }

  async function postpone(idea: Idea, days: number): Promise<void> {
    busyId = idea.id
    error = null
    try {
      await ideaRepository.update(idea.id, {
        moment_at: momentFromDays(days),
        moment_rule: 'manual',
      })
      await onChanged()
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      busyId = null
    }
  }
</script>

{#if ideas.length > 0}
  <section class="moment">
    <h2>Что сейчас кстати</h2>
    <p class="note">
      Эти идеи вы просили вспомнить. Ничего не обязательно — можно просто посмотреть
      или отложить на потом.
    </p>
    <ul>
      {#each ideas as idea (idea.id)}
        <li>
          <div class="head">
            <span class="txt">{title(idea)}</span>
            <span class="when">
              {describeMoment(idea.moment_at)}
              {#if momentDateLabel(idea.moment_at)}· {momentDateLabel(idea.moment_at)}{/if}
            </span>
          </div>
          <div class="row">
            <button
              type="button"
              class="link"
              onclick={() => void postpone(idea, 30)}
              disabled={busyId === idea.id}
            >
              Отложить на месяц
            </button>
            <button
              type="button"
              class="link"
              onclick={() => void clear(idea)}
              disabled={busyId === idea.id}
            >
              Убрать напоминание
            </button>
          </div>
        </li>
      {/each}
    </ul>
    {#if error}<p class="error">{error}</p>{/if}
  </section>
{/if}

<style>
  /* Раздел выделен мягко: он про «кстати», а не про «срочно». */
  .moment {
    margin-top: 18px;
    padding: 14px;
    border-radius: 12px;
    background: #131a2a;
    border: 1px solid #26324a;
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

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  li {
    padding: 10px 11px;
    border-radius: 10px;
    background: #0d1320;
    border: 1px solid #1d2433;
  }

  .head {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .txt {
    color: #e7edf7;
    font-size: 14px;
    overflow-wrap: anywhere;
  }

  .when {
    color: #5eead4;
    font-size: 13px;
  }

  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 14px;
    margin-top: 8px;
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

  .error {
    margin: 8px 0 0;
    color: #fca5a5;
    font-size: 13px;
  }
</style>
