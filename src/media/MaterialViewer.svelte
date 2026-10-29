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
  import type { Material } from '../data'

  let { material, onClose }: { material: Material; onClose: () => void } = $props()

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

    {#if material.extracted_text}
      <p class="text">{material.extracted_text}</p>
    {/if}
    {#if material.comment}
      <p class="own">Свои слова: {material.comment}</p>
    {/if}
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

  .own {
    margin: 8px 0 0;
    color: #5eead4;
    font-size: 13px;
  }

  .note {
    margin: 0;
    color: #66718a;
    font-size: 14px;
  }
</style>
