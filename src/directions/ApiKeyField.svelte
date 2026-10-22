<script lang="ts">
  /**
   * Поле ключа polza.ai.
   *
   * Ключ вводит сам пользователь: в коде его нет и не будет. Хранится в `meta`
   * IndexedDB, на экране показывается маской. Рядом — «Проверить ключ»:
   * один короткий запрос, по которому видно, рабочий ключ или нет.
   *
   * Если ключа нет — кнопки проверки и разбора не работают, но подсказка
   * объясняет, где ключ взять. Ничего не падает: ошибка хранилища или модели
   * превращается в понятную строку.
   */

  import { onMount } from 'svelte'
  import { createLlmClient, META_KEYS } from '../ai'
  import { checkApiKey } from './keyCheck'
  import { formatRub } from './logic'
  import { API_KEY_HINT, deleteMetaValue, maskKey, metaStore, readApiKey, writeMetaValue } from './meta'

  let {
    onChanged,
  }: {
    /** Ключ сохранили или удалили — родителю стоит перечитать состояние. */
    onChanged?: () => void | Promise<void>
  } = $props()

  /** Сохранённый ключ (в памяти — чтобы показать маску). */
  let savedKey = $state('')
  /** Открыт ли ввод: без ключа он открыт сразу. */
  let editing = $state(false)
  let draft = $state('')
  let busy = $state(false)
  let status = $state<string | null>(null)
  let failed = $state(false)
  /** Расход проверки, ₽ — показываем честно. */
  let costRub = $state(0)

  onMount(() => {
    void load()
  })

  /** Читает сохранённый ключ. Ошибка хранилища не роняет экран. */
  async function load(): Promise<void> {
    try {
      savedKey = await readApiKey()
      editing = savedKey === ''
    } catch (e) {
      failed = true
      status = `Настройки недоступны: ${describe(e)}`
      editing = true
    }
  }

  /** Пишет ключ в `meta` и закрывает ввод. */
  async function persist(value: string): Promise<void> {
    await writeMetaValue(META_KEYS.apiKey, value)
    savedKey = value
    draft = ''
    editing = false
  }

  /** Сохранить введённый ключ. */
  async function save(): Promise<void> {
    const value = draft.trim()
    if (value === '' || busy) return
    busy = true
    status = null
    try {
      await persist(value)
      failed = false
      status = 'Ключ сохранён в этом браузере.'
      await onChanged?.()
    } catch (e) {
      failed = true
      status = `Не удалось сохранить ключ: ${describe(e)}`
    } finally {
      busy = false
    }
  }

  /** Удалить ключ с устройства. */
  async function remove(): Promise<void> {
    if (busy) return
    busy = true
    status = null
    try {
      await deleteMetaValue(META_KEYS.apiKey)
      savedKey = ''
      draft = ''
      editing = true
      failed = false
      status = 'Ключ удалён с этого устройства.'
      await onChanged?.()
    } catch (e) {
      failed = true
      status = `Не удалось удалить ключ: ${describe(e)}`
    } finally {
      busy = false
    }
  }

  /**
   * Проверка ключа одним дешёвым запросом.
   * Если в поле есть несохранённый ключ — сначала сохраняем его: пользователь
   * явно просит проверить именно этот ключ.
   */
  async function check(): Promise<void> {
    if (busy) return
    busy = true
    failed = false
    costRub = 0
    status = 'Проверяю ключ коротким запросом…'
    try {
      if (editing && draft.trim() !== '') {
        await persist(draft.trim())
        await onChanged?.()
      }
      if (savedKey === '') {
        failed = true
        status = 'Сначала вставьте ключ polza.ai.'
        return
      }
      const client = await createLlmClient({ store: metaStore })
      const result = await checkApiKey(client)
      failed = !result.ok
      costRub = result.costRub
      status = result.ok ? `${result.message} Можно раскладывать идеи.` : result.message
    } catch (e) {
      failed = true
      status = `Проверка не удалась: ${describe(e)}`
    } finally {
      busy = false
    }
  }

  function describe(e: unknown): string {
    return e instanceof Error ? e.message : 'неизвестная ошибка'
  }

  /** Отменяет ввод и возвращает маску сохранённого ключа. */
  function cancelEdit(): void {
    draft = ''
    editing = false
    status = null
  }
</script>

<div class="key">
  <div class="head">
    <span class="label">Ключ polza.ai</span>
    {#if savedKey}
      <span class="masked" title="Сохранённый ключ (середина скрыта)">{maskKey(savedKey)}</span>
    {:else}
      <span class="missing">не задан</span>
    {/if}
  </div>

  {#if editing}
    <div class="row">
      <input
        class="field"
        type="password"
        bind:value={draft}
        placeholder="Вставьте ключ polza.ai"
        autocomplete="off"
        spellcheck="false"
        aria-label="Ключ polza.ai"
      />
      <button
        type="button"
        class="tool"
        onclick={() => void save()}
        disabled={busy || draft.trim() === ''}
      >
        {savedKey ? 'Заменить' : 'Сохранить ключ'}
      </button>
      <button
        type="button"
        class="tool"
        onclick={() => void check()}
        disabled={busy || (draft.trim() === '' && savedKey === '')}
      >
        Проверить ключ
      </button>
      {#if savedKey}
        <button type="button" class="tool" onclick={cancelEdit} disabled={busy}>Отмена</button>
      {/if}
    </div>
  {:else}
    <div class="row">
      <button type="button" class="tool" onclick={() => void check()} disabled={busy}>
        {busy ? 'Проверяю…' : 'Проверить ключ'}
      </button>
      <button
        type="button"
        class="tool"
        onclick={() => {
          editing = true
          status = null
        }}
        disabled={busy}
      >
        Заменить
      </button>
      <button type="button" class="tool danger" onclick={() => void remove()} disabled={busy}>
        Удалить
      </button>
    </div>
  {/if}

  {#if status}
    <p class="status" class:failed role="status" aria-live="polite">
      {status}{#if costRub > 0} Потрачено: {formatRub(costRub)}.{/if}
    </p>
  {/if}

  {#if savedKey === ''}
    <p class="hint">
      Пока ключа нет, разбор идей недоступен.
      {API_KEY_HINT}
      <a href="https://polza.ai/" target="_blank" rel="noreferrer noopener">Открыть polza.ai</a>
    </p>
  {:else}
    <p class="hint">Ключ хранится только в этом браузере.</p>
  {/if}
</div>

<style>
  .key {
    margin-bottom: 14px;
  }

  .head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    flex-wrap: wrap;
    margin-bottom: 8px;
  }

  .label {
    font-size: 14px;
    color: #97a3b8;
  }

  .masked {
    font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
    font-size: 13px;
    color: #5fd4a8;
  }

  .missing {
    font-size: 13px;
    color: #66718a;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .field {
    flex: 1 1 200px;
    min-width: 0;
    padding: 10px 12px;
    border-radius: 10px;
    border: 1px solid #232a3b;
    background: #111725;
    color: #e8ecf2;
  }

  .field:focus {
    outline: none;
    border-color: #ff8a5b;
  }

  .tool {
    padding: 9px 14px;
    border-radius: 10px;
    border: 1px solid #232a3b;
    background: #111725;
    color: #e8ecf2;
    font-size: 14px;
    cursor: pointer;
  }

  .tool:hover:not(:disabled) {
    border-color: #ff8a5b;
    color: #ff8a5b;
  }

  .tool:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .danger:hover:not(:disabled) {
    border-color: #ff9b7a;
    color: #ff9b7a;
  }

  .status {
    margin: 10px 0 0;
    font-size: 13px;
    color: #5fd4a8;
  }

  .failed {
    color: #ff9b7a;
  }

  .hint {
    margin: 10px 0 0;
    font-size: 12px;
    color: #66718a;
  }

  .hint a {
    color: #97a3b8;
  }
</style>
