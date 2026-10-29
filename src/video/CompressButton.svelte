<script lang="ts">
  /**
   * Сжатие видео — по кнопке и с предупреждением.
   *
   * РЕШЕНИЕ АВТОРА (обсуждали отдельно): сжатие — **осознанное действие**,
   * а не автоматика. Оригинал при этом **заменяется**, поэтому человек
   * обязан понимать, на что соглашается: это единственное место в проекте,
   * где что-то исчезает, и правило «ничего не терять» должно быть нарушено
   * только с явного согласия.
   *
   * Что НЕ теряется при сжатии: распознанный текст, расшифровка, кадр-обложка
   * и свои слова относятся к содержанию, а не к байтам, поэтому остаются.
   *
   * Проверка необходимости бесплатна: `inspect` считает параметры, **не
   * загружая ядро ffmpeg**. Человек видит оценку раньше, чем что-то скачается.
   */
  import { materialRepository } from '../data'
  import type { Material } from '../data'
  import { videoCompressor } from './VideoCompressor'

  let { material, onChanged }: { material: Material; onChanged?: (updated: Material) => void } =
    $props()

  let checking = $state(true)
  let needed = $state(false)
  let estimate = $state('')
  let reason = $state('')
  let busy = $state(false)
  let progress = $state(0)
  let step = $state('')
  let error = $state<string | null>(null)
  let result = $state<string | null>(null)

  const sizeMb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} МБ`

  $effect(() => {
    let alive = true
    void (async () => {
      const blob = material.blob
      if (!blob) {
        checking = false
        return
      }
      try {
        const inspection = await videoCompressor.inspect({ blob, mimeType: material.mime ?? null })
        if (!alive) return
        if (inspection.ok) {
          needed = inspection.plan.needed
          estimate = inspection.plan.message
        } else {
          reason = inspection.error.message
        }
      } catch (e) {
        reason = e instanceof Error ? e.message : String(e)
      } finally {
        if (alive) checking = false
      }
    })()
    return () => {
      alive = false
    }
  })

  async function compress(): Promise<void> {
    const blob = material.blob
    if (!blob) return

    // Предупреждение обязательно: оригинал будет заменён. Обещать
    // «сжатие без последствий» было бы неправдой.
    const agreed = window.confirm(
      `Сжать это видео?\n\n${estimate}\n\n` +
        `Оригинал будет ЗАМЕНЁН сжатой версией, чтобы освободить память. ` +
        `Расшифровка, обложка и ваши слова останутся на месте.\n\n` +
        `Первый раз понадобится скачать около 30 МБ (ядро сжатия) — дальше оно уже в памяти.`,
    )
    if (!agreed) return

    busy = true
    error = null
    result = null
    progress = 0
    step = 'Готовлю…'
    try {
      const outcome = await videoCompressor.compress({
        source: { blob, mimeType: material.mime ?? null },
        onProgress: ({ progress: value, message }) => {
          progress = value
          step = message
        },
      })
      if (!outcome.ok) {
        error = outcome.error.message
        return
      }

      const { blob: smaller, bytesBefore, bytesAfter } = outcome.result
      // Меняем только БАЙТЫ. Текст, обложка, свои слова и заголовок
      // относятся к содержанию идеи и не должны пострадать.
      const updated = await materialRepository.update(material.id, {
        blob: smaller,
        size_bytes: bytesAfter,
        mime: smaller.type || material.mime || null,
        compressed_at: new Date().toISOString(),
      })
      onChanged?.(updated)
      result = `Сжато: ${sizeMb(bytesBefore)} → ${sizeMb(bytesAfter)}. Освободилось ${sizeMb(bytesBefore - bytesAfter)}.`
      needed = false
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      busy = false
      step = ''
    }
  }
</script>

<div class="box">
  {#if result}
    <p class="done">{result}</p>
  {:else if checking}
    <p class="note">Смотрю, нужно ли сжимать…</p>
  {:else if error}
    <p class="error">{error}</p>
    <button type="button" class="link" onclick={() => void compress()}>Попробовать снова</button>
  {:else if reason}
    <p class="note">Сжать не получится: {reason}</p>
  {:else if needed}
    <button type="button" class="btn" onclick={() => void compress()} disabled={busy}>
      {busy ? 'Сжимаю…' : 'Сжать видео'}
    </button>
    <p class="note">{estimate}</p>
    {#if busy}
      <progress max="1" value={progress}></progress>
      {#if step}<p class="note">{step}</p>{/if}
    {/if}
  {:else}
    <p class="note">Сжатие не нужно: {estimate || 'видео уже небольшое.'}</p>
  {/if}
</div>

<style>
  .box {
    margin-top: 8px;
  }

  .btn {
    background: #1b2130;
    border: 1px solid #1d2433;
    border-radius: 9px;
    color: #c7d2e5;
    font: inherit;
    font-size: 14px;
    padding: 8px 14px;
    cursor: pointer;
  }

  .btn:disabled {
    opacity: 0.6;
  }

  .note {
    margin: 7px 0 0;
    color: #66718a;
    font-size: 12px;
  }

  .done {
    margin: 0;
    color: #5eead4;
    font-size: 13px;
  }

  .error {
    margin: 0 0 7px;
    color: #fca5a5;
    font-size: 13px;
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

  progress {
    width: 100%;
    margin-top: 8px;
  }
</style>
