<script lang="ts">
  /**
   * Просмотр материала: посмотреть видео или картинку, не выходя из идеи.
   *
   * Раньше посмотреть запись было нельзя вообще — только расшифровать.
   * А решить судьбу идеи, не увидев, что в ней, невозможно: разбор
   * превращался в угадывание по имени файла.
   *
   * Ссылку на файл создаём при открытии и **обязательно освобождаем** при
   * закрытии: иначе браузер держит в памяти весь ролик, и на телефоне это
   * заканчивается падением вкладки.
   */
  import { onDestroy } from 'svelte'
  import { ideaRepository } from '../data'
  import type { Idea, Material } from '../data'
  import MaterialComment from './MaterialComment.svelte'

  let {
    material,
    idea,
    onClose,
    onIdeaChanged,
  }: {
    material: Material
    /** Идея нужна, чтобы здесь же дать ей ЧЕЛОВЕЧЕСКОЕ название. */
    idea?: Idea | null
    onClose: () => void
    onIdeaChanged?: (idea: Idea) => void
  } = $props()

  /**
   * Переименование прямо здесь.
   *
   * Имя файла из Instagram (`d2c22f18….mp4`) — не название. Человек,
   * посмотрев запись, знает, как её назвать, и не должен уходить в другой
   * экран ради этого. Название — его слова, а не автоматика.
   */
  // Черновик заполняется в момент нажатия «Переименовать»: читать название
  // идеи при создании компонента незачем и вредно — оно может ещё измениться.
  let titleDraft = $state('')
  let renaming = $state(false)
  let renameBusy = $state(false)
  let renameError = $state<string | null>(null)

  async function saveTitle(): Promise<void> {
    if (!idea) return
    renameBusy = true
    renameError = null
    try {
      const updated = await ideaRepository.update(idea.id, { title: titleDraft.trim() })
      onIdeaChanged?.(updated)
      renaming = false
    } catch (e) {
      renameError = e instanceof Error ? e.message : String(e)
    } finally {
      renameBusy = false
    }
  }

  // Именно derived, а не state: ссылка должна следовать за материалом,
  // иначе при смене материала останется старая.
  const url = $derived(material.blob ? URL.createObjectURL(material.blob) : null)

  onDestroy(() => {
    if (url) URL.revokeObjectURL(url)
  })

  const name = $derived(material.title ?? 'запись')
  const isVideo = $derived(material.kind === 'video')
</script>

<div class="backdrop" role="dialog" aria-modal="true" aria-label={`Просмотр: ${name}`}>
  <div class="frame">
    <div class="bar">
      <span class="name">{name}</span>
      <button type="button" class="close" onclick={onClose} aria-label="Закрыть">×</button>
    </div>

    {#if !url}
      <p class="note">Файл не сохранился — посмотреть нечего. Идея и материалы на месте.</p>
    {:else if isVideo}
      <!-- Субтитров-дорожки нет: расшифровка лежит текстом ниже, отдельным
           блоком — она получена без разметки по времени. -->
      <!-- svelte-ignore a11y_media_has_caption -->
      <video src={url} controls playsinline preload="metadata"></video>
    {:else}
      <img src={url} alt={name} />
    {/if}

    {#if idea}
      <div class="rename">
        {#if renaming}
          <label class="field">
            <span>Название идеи</span>
            <input bind:value={titleDraft} aria-label="Название идеи" />
          </label>
          <div class="row">
            <button type="button" class="save" onclick={() => void saveTitle()} disabled={renameBusy}>
              {renameBusy ? 'Сохраняю…' : 'Сохранить'}
            </button>
            <button type="button" class="link" onclick={() => (renaming = false)} disabled={renameBusy}>
              Отмена
            </button>
          </div>
          {#if renameError}<p class="error">{renameError}</p>{/if}
        {:else}
          <button type="button" class="link" onclick={() => { titleDraft = idea.title; renaming = true }}>
            Переименовать идею
          </button>
        {/if}
      </div>
    {/if}

    {#if material.extracted_text}
      <p class="text">{material.extracted_text}</p>
    {/if}

    <!-- Свои слова — здесь же: посмотрел запись и сразу записал, зачем она. -->
    <MaterialComment {material} onChanged={() => {}} />
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 50;
    background: rgba(4, 7, 14, 0.92);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 14px;
  }

  .frame {
    width: 100%;
    max-width: 520px;
    max-height: 100%;
    overflow-y: auto;
    background: #0d1320;
    border: 1px solid #1d2433;
    border-radius: 12px;
    padding: 12px;
  }

  .bar {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    margin-bottom: 10px;
  }

  .name {
    flex: 1;
    min-width: 0;
    color: #a9b4c9;
    font-size: 13px;
    overflow-wrap: anywhere;
  }

  .close {
    flex: none;
    background: none;
    border: 0;
    color: #c7d2e5;
    font-size: 22px;
    line-height: 1;
    cursor: pointer;
    padding: 0 4px;
  }

  video,
  img {
    width: 100%;
    max-height: 60vh;
    border-radius: 9px;
    background: #000;
    display: block;
  }

  img {
    object-fit: contain;
  }

  .text {
    margin: 10px 0 0;
    color: #c7d2e5;
    font-size: 14px;
    line-height: 1.45;
    white-space: pre-wrap;
  }

  .rename {
    margin-top: 12px;
    padding-top: 10px;
    border-top: 1px solid #1d2433;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  .field span {
    color: #66718a;
    font-size: 12px;
  }

  .field input {
    width: 100%;
    box-sizing: border-box;
    background: #111725;
    border: 1px solid #1d2433;
    border-radius: 8px;
    color: #e7edf7;
    font: inherit;
    font-size: 14px;
    padding: 8px 10px;
  }

  .row {
    display: flex;
    gap: 12px;
    align-items: center;
    margin-top: 8px;
  }

  .save {
    background: #1f6f5c;
    border: 0;
    border-radius: 9px;
    color: #ecfdf5;
    font: inherit;
    font-size: 14px;
    padding: 8px 14px;
    cursor: pointer;
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

  .note {
    margin: 0;
    color: #66718a;
    font-size: 14px;
  }
</style>
