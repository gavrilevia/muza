<script lang="ts">
  /**
   * Свои слова человека о материале.
   *
   * Отдельно от распознанного текста: расшифровку и OCR сделала машина,
   * а здесь то, что человек сказал сам — «здесь важен момент про 5 литров».
   *
   * Ценность в том, что эти слова попадают в поиск и в разбор направлений
   * (`SearchService`, `materialsText`). Иначе мысль о материале потерялась бы
   * так же бесследно, как потерялся бы нераспознанный файл.
   */
  import { materialRepository } from '../data'
  import type { Material } from '../data'

  let {
    material,
    onChanged,
  }: { material: Material; onChanged?: (updated: Material) => void } = $props()

  let editing = $state(false)
  let draft = $state('')
  let busy = $state(false)
  let error = $state<string | null>(null)

  const comment = $derived((material.comment ?? '').trim())

  function start(): void {
    draft = comment
    error = null
    editing = true
  }

  async function save(): Promise<void> {
    const clean = draft.trim()
    busy = true
    error = null
    try {
      const updated = await materialRepository.update(material.id, { comment: clean || null })
      // Отдаём наружу: приложение переиндексирует поиск, иначе новые слова
      // найдутся только после перезагрузки.
      onChanged?.(updated)
      editing = false
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      busy = false
    }
  }

  async function clear(): Promise<void> {
    busy = true
    try {
      const updated = await materialRepository.update(material.id, { comment: null })
      onChanged?.(updated)
      editing = false
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      busy = false
    }
  }
</script>

{#if editing}
  <div class="box">
    <textarea
      bind:value={draft}
      rows="3"
      placeholder="Например: здесь важен момент про 5 литров"
      aria-label="Свои слова о материале"
    ></textarea>
    <div class="row">
      <button type="button" class="btn" onclick={() => void save()} disabled={busy}>
        {busy ? 'Сохраняю…' : 'Сохранить'}
      </button>
      <button type="button" class="link" onclick={() => (editing = false)} disabled={busy}>
        Отмена
      </button>
      {#if comment !== ''}
        <button type="button" class="link" onclick={() => void clear()} disabled={busy}>
          Стереть
        </button>
      {/if}
    </div>
    {#if error}<p class="error">{error}</p>{/if}
  </div>
{:else if comment !== ''}
  <div class="shown">
    <p class="text">{comment}</p>
    <button type="button" class="link" onclick={start}>Изменить свои слова</button>
  </div>
{:else}
  <button type="button" class="link solo" onclick={start}>Добавить свои слова</button>
{/if}

<style>
  .box {
    margin-top: 8px;
  }

  textarea {
    width: 100%;
    box-sizing: border-box;
    background: #0d1320;
    border: 1px solid #1b2130;
    border-radius: 9px;
    color: #e7edf7;
    font: inherit;
    font-size: 14px;
    padding: 9px 11px;
    resize: vertical;
  }

  textarea:focus {
    outline: none;
    border-color: #2f6f63;
  }

  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
    margin-top: 8px;
  }

  .btn {
    background: #1f6f5c;
    border: 0;
    border-radius: 9px;
    color: #ecfdf5;
    font: inherit;
    font-size: 14px;
    padding: 8px 14px;
    cursor: pointer;
  }

  .btn:disabled {
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

  .shown {
    margin-top: 8px;
    display: flex;
    flex-direction: column;
    gap: 5px;
    align-items: flex-start;
  }

  .text {
    margin: 0;
    color: #c7d2e5;
    font-size: 14px;
    white-space: pre-wrap;
  }

  .solo {
    margin-top: 8px;
  }

  .error {
    margin: 8px 0 0;
    color: #fca5a5;
    font-size: 13px;
  }
</style>
