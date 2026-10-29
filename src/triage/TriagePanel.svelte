<script lang="ts">
  /**
   * Разбор: уборка входящих.
   *
   * В v1 триаж понижен до гигиены — «Разбор — уборка, а не ценность»
   * (`КОНЦЕПЦИЯ-v1.md`). Поэтому здесь нет обязательных комментариев
   * и длинных форм: **три решения, один тап каждое**.
   *
   * - **Оставить** — идея уходит в работу;
   * - **Покой** — идея засыпает. Это не смерть: ветвь можно вернуть;
   * - **Архив** — уходит с причиной и остаётся в поиске.
   *
   * И здесь же — **вопрос про дубли**. При захвате его задавать нельзя:
   * это трение там, где человек просто хочет сохранить мысль.
   */
  import { ideaRepository } from '../data'
  import type { Idea, Material } from '../data'
  import { ARCHIVE_REASONS, archiveIdea } from '../data'
  import { MaterialViewer, meaningfulTitle, technicalName } from '../media'
  import { mergeIdeas } from './merge'
  import { similarTo, statusFor, triageReason } from './logic'

  let {
    queue,
    allIdeas,
    materials,
    onChanged,
  }: {
    queue: readonly Idea[]
    allIdeas: readonly Idea[]
    materials: Record<string, Material[]>
    onChanged: () => void | Promise<void>
  } = $props()

  let busyId = $state<string | null>(null)
  let error = $state<string | null>(null)
  let shown = $state(5)
  /** Что человек смотрит прямо сейчас: разбор не должен быть угадыванием. */
  let viewing = $state<Material | null>(null)

  /**
   * Название для разбора — СМЫСЛ, а не имя файла.
   *
   * Раньше здесь стоял хеш (`d2c22f18….mp4`), и разбор превращался
   * в бессмыслицу: решать судьбу идеи, не понимая, что в ней, невозможно.
   * Имя файла остаётся, но мелкой подписью внизу.
   */
  function title(idea: Idea): string {
    return meaningfulTitle(idea, materials[idea.id] ?? []).slice(0, 160)
  }

  /** Имя файла — техническая подробность, показываем тихо. */
  function fileName(idea: Idea): string | null {
    return technicalName(idea, materials[idea.id] ?? [])
  }

  /** Первый материал, который можно посмотреть. */
  function previewable(idea: Idea): Material | null {
    const list = materials[idea.id] ?? []
    return (
      list.find(
        (material) =>
          Boolean(material.blob) && (material.kind === 'video' || material.kind === 'image'),
      ) ?? null
    )
  }

  function poster(idea: Idea): string | null {
    for (const material of materials[idea.id] ?? []) {
      if (material.poster) return material.poster
    }
    return null
  }

  async function decide(idea: Idea, decision: 'keep' | 'rest'): Promise<void> {
    busyId = idea.id
    error = null
    try {
      await ideaRepository.update(idea.id, { status: statusFor(decision) })
      await onChanged()
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      busyId = null
    }
  }

  async function archive(idea: Idea): Promise<void> {
    busyId = idea.id
    error = null
    try {
      const answer = window.prompt(
        `Почему идея уходит в архив?\n\nМожно выбрать готовое (${ARCHIVE_REASONS.join(' / ')}) или написать своё:`,
        ARCHIVE_REASONS[0],
      )
      if (answer === null) return
      await archiveIdea(idea.id, answer)
      await onChanged()
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      busyId = null
    }
  }

  async function merge(idea: Idea, other: Idea): Promise<void> {
    busyId = idea.id
    error = null
    try {
      await mergeIdeas(other.id, idea.id)
      await onChanged()
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      busyId = null
    }
  }
</script>

{#if queue.length > 0}
  <section class="triage">
    <h2>Разбор · {queue.length}</h2>
    <p class="note">
      Разбор — это уборка, а не работа. Решение принимается одним тапом, и любой выбор
      можно изменить позже: «покой» — это сон, а не конец.
    </p>

    <ul>
      {#each queue.slice(0, shown) as idea (idea.id)}
        <li>
          <div class="card">
            {#if poster(idea)}
              <button
                type="button"
                class="shot"
                onclick={() => {
                  const material = previewable(idea)
                  if (material) viewing = material
                }}
                aria-label="Посмотреть запись"
              >
                <img src={poster(idea)} alt="" loading="lazy" />
                {#if previewable(idea)?.kind === 'video'}<span class="play" aria-hidden="true">▶</span>{/if}
              </button>
            {/if}
            <div class="head">
              <span class="txt">{title(idea)}</span>
              <span class="why">{triageReason(idea)}</span>
              {#if fileName(idea)}<span class="file">{fileName(idea)}</span>{/if}
            </div>
          </div>

          {#each similarTo(idea, allIdeas) as near (near.idea.id)}
            <!-- Вопрос про дубли — здесь и только здесь. -->
            <p class="near">
              Похоже на: «{title(near.idea)}
              {#if near.idea.status === 'archived'}(в архиве){/if}
              ».
              <button
                type="button"
                class="link"
                onclick={() => void merge(idea, near.idea)}
                disabled={busyId === idea.id}
              >
                Слить с ней
              </button>
            </p>
          {/each}

          <div class="row">
            <button
              type="button"
              class="keep"
              onclick={() => void decide(idea, 'keep')}
              disabled={busyId === idea.id}
            >
              Оставить
            </button>
            <button
              type="button"
              class="rest"
              onclick={() => void decide(idea, 'rest')}
              disabled={busyId === idea.id}
            >
              Покой
            </button>
            <button
              type="button"
              class="link"
              onclick={() => void archive(idea)}
              disabled={busyId === idea.id}
            >
              Архив
            </button>
          </div>
        </li>
      {/each}
    </ul>

    {#if queue.length > shown}
      <button type="button" class="more" onclick={() => (shown += 5)}>
        Показать ещё (осталось {queue.length - shown})
      </button>
    {/if}

    {#if error}<p class="error">{error}</p>{/if}
  </section>
{/if}

{#if viewing}
  <MaterialViewer
    material={viewing}
    idea={allIdeas.find((item) => item.id === viewing?.idea_id) ?? null}
    onClose={() => (viewing = null)}
    onIdeaChanged={() => onChanged()}
  />
{/if}

<style>
  .triage {
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
    padding: 11px;
    border-radius: 10px;
    background: #0d1320;
    border: 1px solid #1d2433;
  }

  .card {
    display: flex;
    gap: 11px;
    align-items: flex-start;
  }

  /* Кадр — кнопка: нажал и посмотрел запись. Без этого судить об идее
     приходилось по имени файла. */
  .shot {
    position: relative;
    flex: none;
    width: 72px;
    height: 72px;
    padding: 0;
    border: 1px solid #1d2433;
    border-radius: 9px;
    background: #0a0f1a;
    overflow: hidden;
    cursor: pointer;
  }

  .shot img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  .play {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #ffffff;
    font-size: 19px;
    text-shadow: 0 1px 5px rgba(0, 0, 0, 0.8);
  }

  .head {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }

  .file {
    color: #4d5769;
    font-size: 11px;
    overflow-wrap: anywhere;
  }

  .txt {
    color: #e7edf7;
    font-size: 14px;
    overflow-wrap: anywhere;
  }

  .why {
    color: #66718a;
    font-size: 12px;
  }

  .near {
    margin: 8px 0 0;
    padding: 7px 9px;
    border-radius: 8px;
    background: #111725;
    color: #a9b4c9;
    font-size: 13px;
  }

  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    margin-top: 10px;
  }

  .keep,
  .rest {
    border: 0;
    border-radius: 9px;
    font: inherit;
    font-size: 14px;
    padding: 8px 14px;
    cursor: pointer;
  }

  .keep {
    background: #1f6f5c;
    color: #ecfdf5;
  }

  .rest {
    background: #1b2130;
    color: #c7d2e5;
  }

  .keep:disabled,
  .rest:disabled {
    opacity: 0.6;
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

  .more {
    margin-top: 10px;
    width: 100%;
    background: #111725;
    border: 1px solid #1d2433;
    border-radius: 9px;
    color: #c7d2e5;
    font: inherit;
    font-size: 14px;
    padding: 9px;
    cursor: pointer;
  }

  .error {
    margin: 8px 0 0;
    color: #fca5a5;
    font-size: 13px;
  }
</style>