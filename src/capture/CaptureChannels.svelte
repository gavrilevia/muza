<script lang="ts">
  /**
   * Каналы захвата: файл, камера, микрофон, буфер обмена.
   *
   * Компонент ничего не решает про данные: он добывает текст и файлы и отдаёт
   * их наверх в `onCapture`. Сохранение — в `captureService`, поэтому идея
   * появляется в базе сразу, а материалы прикладываются следом.
   *
   * Главное правило: текст, который человек уже набрал в поле, не пропадает
   * ни при каком сбое канала. Поле очищается только после успешного
   * сохранения и только тем вызовом, который этот текст забрал.
   */

  import { onDestroy } from 'svelte'
  import {
    actionForChannel,
    asCaptureFile,
    describeCaptureError,
    extensionForMime,
    formatDuration,
    pluralRu,
    stampedName,
    unsupportedMessage,
  } from './logic'
  import { isVoiceSupported, startVoiceRecording } from './recorder'
  import type { VoiceRecording } from './recorder'
  import type { CaptureBatchOutcome, CaptureChannel, CaptureFile, CaptureRequest } from './types'

  let {
    text = '',
    onCapture,
    onTextConsumed,
  }: {
    /** Текущий текст поля ввода — он же становится текстом идеи. */
    text: string
    /** Сохранить запрос; бросает, если не сохранилось ничего. */
    onCapture: (request: CaptureRequest) => Promise<CaptureBatchOutcome>
    /** Текст ушёл в идею — поле можно очистить (зовётся только при успехе). */
    onTextConsumed: () => void
  } = $props()

  /** Сообщение под кнопками: и успех, и ошибка. */
  let status = $state<string | null>(null)
  let failed = $state(false)
  /** Идёт сохранение или запуск записи — кнопки на паузе. */
  let busy = $state(false)
  let isRecording = $state(false)
  /** Секунды с начала записи. */
  let elapsed = $state(0)

  let fileInput: HTMLInputElement | null = null
  let cameraInput: HTMLInputElement | null = null
  let active: VoiceRecording | null = null
  let startedAt = 0
  let ticker: ReturnType<typeof globalThis.setInterval> | null = null

  onDestroy(() => {
    clearTicker()
    active?.cancel()
    active = null
  })

  /** Текст поля, если он непустой: пробелы идеей не считаются. */
  function typedText(): string | undefined {
    const value = text.trim()
    return value ? value : undefined
  }

  function clearTicker(): void {
    if (ticker !== null) {
      clearInterval(ticker)
      ticker = null
    }
  }

  /** Общий путь всех каналов: сохранить и рассказать, что получилось. */
  async function run(request: CaptureRequest): Promise<void> {
    if (busy) return
    busy = true
    failed = false
    status = null
    try {
      const outcome = await onCapture(request)
      // Поле очищаем только если текст действительно уехал в идею.
      if (outcome.textConsumed) onTextConsumed()
      status = outcome.warning ?? savedNote(outcome, Boolean(request.text?.trim()))
      failed = Boolean(outcome.warning)
    } catch (e) {
      // Текст остаётся в поле: сохранить идею не удалось.
      failed = true
      status = describeCaptureError(e, actionForChannel(request.channel))
    } finally {
      busy = false
    }
  }

  /**
   * Что сказать после удачного захвата.
   * Один файл — как раньше: одна идея и её материалы. Несколько файлов — это
   * несколько идей, и говорим об идеях, а не о материалах: человеку важно
   * понять, что записей стало много, а не одна.
   */
  function savedNote(outcome: CaptureBatchOutcome, hadText: boolean): string {
    const ideas = outcome.outcomes.length
    if (ideas === 1) {
      const count = outcome.outcomes[0].materials.length
      return count === 0 ? 'Сохранено.' : `Сохранено. Материалов: ${count}.`
    }
    const word = pluralRu(ideas, 'идея', 'идеи', 'идей')
    // Набранный текст достаётся первой идее — скажем, где его искать.
    const tail = hadText ? ' Ваш текст — в первой.' : ''
    return `Сохранено: ${ideas} ${word}.${tail}`
  }

  function filesToList(list: FileList | null): CaptureFile[] {
    const out: CaptureFile[] = []
    if (!list) return out
    for (let i = 0; i < list.length; i += 1) {
      const file = list.item(i)
      if (file) out.push(asCaptureFile(file))
    }
    return out
  }

  /** Файл и камера — один и тот же путь, разница только в канале и в атрибутах. */
  async function onFilesPicked(event: Event, channel: CaptureChannel): Promise<void> {
    const input = event.currentTarget as HTMLInputElement
    const files = filesToList(input.files)
    // Сбрасываем выбор: иначе тот же файл второй раз не выбрать.
    input.value = ''
    if (files.length === 0) return
    await run({ channel, text: typedText(), files })
  }

  function tick(): void {
    elapsed = Math.max(0, Math.round((Date.now() - startedAt) / 1000))
  }

  async function startRecording(): Promise<void> {
    if (isRecording || busy) return
    failed = false
    status = null
    if (!isVoiceSupported()) {
      failed = true
      status = unsupportedMessage('voice')
      return
    }
    busy = true
    try {
      active = await startVoiceRecording()
      startedAt = Date.now()
      elapsed = 0
      isRecording = true
      ticker = setInterval(tick, 500)
    } catch (e) {
      active = null
      isRecording = false
      failed = true
      status = describeCaptureError(e, 'voice')
    } finally {
      busy = false
    }
  }

  /** `save = false` — запись выбрасывается, микрофон всё равно освобождается. */
  async function stopRecording(save: boolean): Promise<void> {
    const recording = active
    if (!recording) return
    active = null
    isRecording = false
    clearTicker()

    if (!save) {
      recording.cancel()
      failed = false
      status = 'Запись отменена.'
      return
    }

    busy = true
    try {
      const result = await recording.stop()
      busy = false
      await run({
        channel: 'voice',
        text: typedText(),
        files: [result.file],
        durationSec: result.durationSec,
      })
    } catch (e) {
      busy = false
      failed = true
      status = describeCaptureError(e, 'voice')
    }
  }

  /** Что умеет буфер обмена в этом браузере. Возможностей может и не быть. */
  interface ClipboardReader {
    read?: () => Promise<ClipboardItem[]>
    readText?: () => Promise<string>
  }

  function clipboardReader(): ClipboardReader | null {
    if (typeof navigator === 'undefined') return null
    const clipboard = navigator.clipboard as unknown as ClipboardReader | undefined
    if (!clipboard) return null
    if (!clipboard.read && !clipboard.readText) return null
    return clipboard
  }

  /**
   * Картинка из буфера, если она там есть.
   * Ошибку чтения гасим молча: картинок может не быть вовсе, а текст
   * прочитать всё равно получится — сообщение покажем только на тексте.
   */
  async function readClipboardImage(reader: ClipboardReader): Promise<CaptureFile | null> {
    if (!reader.read || typeof ClipboardItem === 'undefined') return null
    try {
      const items = await reader.read()
      for (const item of items) {
        const type = item.types.find((value) => value.startsWith('image/'))
        if (!type) continue
        const blob = await item.getType(type)
        const name = stampedName('clipboard', extensionForMime(type), new Date())
        return asCaptureFile(blob, name, type)
      }
    } catch {
      /* нет разрешения или буфер недоступен — ниже попробуем текст */
    }
    return null
  }

  /** Текст из буфера; `null` — прочитать не удалось, сообщение уже показано. */
  async function readClipboardText(reader: ClipboardReader): Promise<string | null> {
    if (!reader.readText) {
      failed = true
      status = unsupportedMessage('clipboard')
      return null
    }
    try {
      return await reader.readText()
    } catch (e) {
      failed = true
      status = describeCaptureError(e, 'clipboard')
      return null
    }
  }

  async function pasteFromClipboard(): Promise<void> {
    if (busy) return
    const reader = clipboardReader()
    if (!reader) {
      failed = true
      status = unsupportedMessage('clipboard')
      return
    }

    failed = false
    status = null

    // Картинка важнее текста: скриншот — это отдельный материал.
    const image = await readClipboardImage(reader)
    if (image) {
      await run({ channel: 'clipboard', text: typedText(), files: [image] })
      return
    }

    const pasted = await readClipboardText(reader)
    if (pasted === null) return

    const body = [typedText(), pasted.trim()].filter(Boolean).join('\n\n')
    if (!body) {
      failed = true
      status = 'В буфере обмена нет ни текста, ни картинки.'
      return
    }
    await run({ channel: 'clipboard', text: body })
  }
</script>

<div class="channels">
  <div class="row">
    <button type="button" class="tool" onclick={() => fileInput?.click()} disabled={busy}>
      Файл
    </button>
    <button type="button" class="tool" onclick={() => cameraInput?.click()} disabled={busy}>
      Камера
    </button>
    {#if isRecording}
      <button type="button" class="tool rec" onclick={() => void stopRecording(true)} disabled={busy}>
        Остановить · {formatDuration(elapsed)}
      </button>
      <button type="button" class="tool" onclick={() => void stopRecording(false)} disabled={busy}>
        Отменить
      </button>
    {:else}
      <button type="button" class="tool" onclick={() => void startRecording()} disabled={busy}>
        Микрофон
      </button>
    {/if}
    <button type="button" class="tool" onclick={() => void pasteFromClipboard()} disabled={busy}>
      Вставить
    </button>
  </div>

  {#if isRecording}
    <p class="live" role="status">
      <span class="dot" aria-hidden="true"></span>
      Идёт запись {formatDuration(elapsed)} — нажмите «Остановить», чтобы сохранить.
    </p>
  {/if}

  {#if status}
    <p class="status" class:failed role="status" aria-live="polite">{status}</p>
  {/if}

  <input
    bind:this={fileInput}
    class="hidden"
    type="file"
    multiple
    aria-label="Выбрать файлы"
    onchange={(event) => void onFilesPicked(event, 'file')}
  />
  <input
    bind:this={cameraInput}
    class="hidden"
    type="file"
    accept="image/*"
    capture="environment"
    aria-label="Снять фото"
    onchange={(event) => void onFilesPicked(event, 'camera')}
  />
</div>

<style>
  .channels {
    margin-top: 14px;
  }

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

  /* Кнопка остановки записи — заметная: видно, что микрофон работает. */
  .rec {
    border-color: #ff8a5b;
    color: #ff8a5b;
    font-weight: 600;
  }

  .live {
    display: flex;
    align-items: center;
    gap: 7px;
    margin: 10px 0 0;
    font-size: 13px;
    color: #ff8a5b;
  }

  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #ff5b4a;
    flex: none;
    animation: pulse 1.2s ease-in-out infinite;
  }

  @keyframes pulse {
    50% {
      opacity: 0.25;
    }
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
