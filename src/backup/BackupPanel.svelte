<script lang="ts">
  /**
   * Блок резервной копии на экране: «Сохранить копию» и «Восстановить из копии».
   *
   * Копия — один zip-файл (формат и разбор — в src/data/ExportService.ts и
   * backup.ts). Большой архив собирается несколько секунд, поэтому на время
   * работы кнопки блокируются, а о размере предупреждаем ДО начала сборки —
   * но сохранить не мешаем.
   *
   * Импорт идемпотентен: повторная та же копия ничего не задваивает.
   * Ошибка импорта данные не меняет: слой данных применяет всё одной
   * транзакцией, а разбор файла идёт до неё.
   *
   * О выгрузке напоминаем тихо и не чаще раза в 30 дней: продукт не ставит
   * задач и не создаёт чувства долга — это просто спокойная строка.
   */

  import { onMount } from 'svelte'
  import { archiveSizeWarning, backupFileName, exportBackup, importBackupFile } from '../data'
  import { describeBackupError, describeBackupResult, shouldSuggestBackup } from './logic'
  import { estimateArchiveBytes, readLastBackupAt, writeLastBackupAt } from './store'

  let {
    ideasCount = 0,
    onImported,
  }: {
    /** Сколько идей сейчас на экране: без идей напоминать не о чем. */
    ideasCount?: number
    /** Импорт удался — список на экране надо перечитать. */
    onImported: () => void | Promise<void>
  } = $props()

  /** Что сейчас идёт: сборка, восстановление или ничего. Кнопки на паузе. */
  let busy = $state<'save' | 'restore' | null>(null)
  /** Сообщение под кнопками: и успех, и ошибка. */
  let status = $state<string | null>(null)
  let failed = $state(false)
  /** Предупреждение о большом архиве — показывается до сборки. */
  let sizeNote = $state<string | null>(null)
  /** Нужно ли тихо предложить сохранить копию. */
  let remind = $state(false)
  /** Когда копию сохраняли в последний раз; `null` — ещё ни разу. */
  let lastSavedAt = $state<Date | null>(null)

  let fileInput: HTMLInputElement | null = null

  onMount(() => {
    void checkReminder()
  })

  /** Тихое напоминание: копии не было ни разу или прошло больше 30 дней. */
  async function checkReminder(): Promise<void> {
    try {
      lastSavedAt = await readLastBackupAt()
    } catch {
      // Хранилище недоступно — об этом уже говорит список идей; молчим.
      lastSavedAt = null
    }
    remind = shouldSuggestBackup(lastSavedAt)
  }

  /** Собирает и скачивает zip. Дату копии пишем в `meta` после успеха. */
  async function save(): Promise<void> {
    if (busy) return
    busy = 'save'
    failed = false
    status = 'Собираю архив — на большом количестве файлов это занимает несколько секунд.'
    sizeNote = null
    const at = new Date()
    try {
      // Оценка до сборки: у большого архива предупреждение должно успеть
      // появиться на экране раньше, чем начнётся упаковка.
      try {
        sizeNote = archiveSizeWarning(await estimateArchiveBytes())
      } catch {
        sizeNote = null
      }

      const bytes = await exportBackup(at)
      status = `Копия сохранена: ${backupFileName(at)} (${formatSize(bytes.length)}).`
      lastSavedAt = at
      // Напоминание гаснет сразу: копия только что сохранена.
      remind = false

      // Файл уже у пользователя. Записать не удалось — не страшно.
      try {
        await writeLastBackupAt(at)
      } catch {
        /* не критично: копия скачана */
      }
    } catch (e) {
      failed = true
      status = describeBackupError(e)
    } finally {
      busy = null
    }
  }

  /** Импорт выбранного файла: zip или старый JSON — формат по содержимому. */
  async function onFilePicked(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement
    const file = input.files?.[0] ?? null
    // Сбрасываем выбор: иначе тот же файл второй раз не выбрать.
    input.value = ''
    if (!file) {
      failed = false
      status = 'Файл не выбран.'
      return
    }
    if (busy) return

    busy = 'restore'
    failed = false
    status = 'Восстанавливаю копию…'
    sizeNote = null
    try {
      const report = await importBackupFile(file)
      // Список читаем заново: импорт мог добавить идеи.
      await onImported()
      status = describeBackupResult(report)
    } catch (e) {
      // Данные не тронуты: импорт либо применился целиком, либо нет.
      failed = true
      status = describeBackupError(e)
    } finally {
      busy = null
    }
  }

  /** Размер по-человечески: мегабайты с одним знаком после запятой. */
  function formatSize(bytes: number): string {
    return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`
  }
</script>

<div class="backup">
  {#if remind && ideasCount > 0}
    <p class="remind">
      {lastSavedAt
        ? 'Копию идей сохраняли больше месяца назад. Если захочется — можно сохранить новую.'
        : 'Копию идей ещё не сохраняли. Её можно скачать файлом — он останется у вас.'}
    </p>
  {/if}

  <div class="row">
    <button type="button" class="tool" onclick={() => void save()} disabled={busy !== null}>
      {busy === 'save' ? 'Собираю…' : 'Сохранить копию'}
    </button>
    <button
      type="button"
      class="tool"
      onclick={() => fileInput?.click()}
      disabled={busy !== null}
    >
      {busy === 'restore' ? 'Восстанавливаю…' : 'Восстановить из копии'}
    </button>
    <span class="hint">файл .zip или старый .json</span>
  </div>

  {#if sizeNote}
    <p class="note" role="status" aria-live="polite">{sizeNote}</p>
  {/if}

  {#if status}
    <p class="status" class:failed role="status" aria-live="polite">{status}</p>
  {/if}

  <input
    bind:this={fileInput}
    class="hidden"
    type="file"
    accept=".zip,.json,application/zip,application/json"
    aria-label="Выбрать файл копии"
    onchange={(event) => void onFilePicked(event)}
  />
</div>

<style>
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .tool {
    padding: 9px 14px;
    border-radius: 10px;
    border: 1px solid #232a3b;
    background: #111725;
    color: #e8ecf2;
    font: inherit;
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

  .hint {
    font-size: 12px;
    color: #66718a;
  }

  .remind {
    margin: 0 0 12px;
    font-size: 13px;
    color: #8b96ab;
  }

  /* Предупреждение о размере — заметное, но не тревожное */
  .note {
    margin: 10px 0 0;
    font-size: 13px;
    color: #e0b072;
  }

  .status {
    margin: 10px 0 0;
    font-size: 13px;
    color: #5fd4a8;
  }

  .failed {
    color: #ff9b7a;
  }

  .hidden {
    display: none;
  }
</style>
