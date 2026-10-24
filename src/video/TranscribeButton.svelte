<script lang="ts">
  /**
   * Кнопка «Расшифровать» и показ готового текста для одного материала.
   *
   * Почему сервис собирается прямо в обработчике нажатия: он читает ключ
   * polza.ai один раз, при создании. Если собрать его при появлении экрана,
   * ключ, добавленный позже, останется невидимым — расшифровка будет
   * отказывать «нет ключа», хотя ключ есть (ВИДЕО.md, 8.4).
   *
   * Ничего не запускается само: расшифровка — платная операция, решение
   * принимает человек. Материал и идея не теряются ни при какой ошибке:
   * сервис только читает `blob`, а отметка в базе — отдельный шаг,
   * и её сбой не прячет причину.
   */

  import { formatDuration } from '../capture'
  import { materialRepository } from '../data'
  import type { Material } from '../data'
  import { metaStore } from '../directions/meta'
  import { createTranscriptionService } from './TranscriptionService'
  import { describeTranscriptionModel } from './transcriptionConfig'

  let {
    material,
    onChanged,
  }: {
    material: Material
    /** Материал обновлён в базе — список на экране стоит освежить. */
    onChanged?: (material: Material) => void
  } = $props()

  let busy = $state(false)
  let progress = $state(0)
  let status = $state<string | null>(null)
  let failed = $state(false)
  /** Текст показан целиком; иначе — первые строки. */
  let expanded = $state(false)

  /** Готовый текст расшифровки, если он уже есть. */
  const saved = $derived((material.extracted_text ?? '').trim())

  /** Свёрнутый вид: первые строки, чтобы было видно, что текст появился. */
  const preview = $derived.by(() => {
    if (saved === '') return ''
    const head = saved.split('\n').slice(0, 3).join('\n')
    return head.length > 220 ? `${head.slice(0, 220)}…` : head
  })

  /** Есть ли что прятать за «показать целиком». */
  const cropped = $derived(saved.length > preview.length)

  /** Подпись материала: имя файла или понятное слово. */
  const label = $derived(
    material.title || material.file || (material.kind === 'audio' ? 'Голосовая заметка' : 'Видео'),
  )

  /** Длительность для подписи: есть только у видео и голосовых заметок. */
  const duration = $derived(
    typeof material.duration_sec === 'number' && material.duration_sec > 0
      ? formatDuration(material.duration_sec)
      : '',
  )

  async function run(): Promise<void> {
    if (busy) return

    // Повторная расшифровка перезаписывает готовый текст — только с согласия.
    if (saved !== '') {
      const agreed = window.confirm('Текст уже есть. Расшифровать заново и заменить его?')
      if (!agreed) return
    }

    const blob = material.blob
    if (!blob) {
      failed = true
      status = 'Файл не сохранился — расшифровывать нечего. Идея на месте.'
      return
    }

    busy = true
    failed = false
    progress = 0
    status = 'Готовим расшифровку…'

    try {
      // Сервис собирается в момент нажатия: ключ, добавленный после
      // открытия экрана, уже виден. См. шапку файла.
      const service = await createTranscriptionService({ store: metaStore })
      const outcome = await service.transcribe({
        source: {
          blob,
          mimeType: material.mime ?? blob.type ?? null,
          name: material.file,
          durationSec: material.duration_sec ?? null,
        },
        onProgress: (event) => {
          progress = event.progress
          status = event.message
        },
      })

      if (outcome.ok) {
        const updated = await mark('done', outcome.result.text)
        const seconds = Math.round(outcome.result.durationSec)
        const done = seconds > 0 ? `Готово: расшифровано ${seconds} с.` : 'Готово: текст получен.'
        // Какая модель сработала — человеку видно: «русская» или «общая».
        const note = describeTranscriptionModel(
          outcome.result.model,
          outcome.result.language,
          outcome.result.usedFallback,
        )
        // Расшифровка — платная операция, поэтому цену показываем всегда.
        // За нерусскую речь платят дважды (две модели), и это должно быть
        // видно сразу, а не выясняться в личном кабинете провайдера.
        const price =
          outcome.result.costRub > 0 ? `Стоимость: ${outcome.result.costRub.toFixed(4)} ₽.` : ''
        const line = [done, note, price].filter(Boolean).join(' ')
        status = updated ? line : withSaveNote(line)
        // Отдельное примечание сервиса: например, «общая модель не ответила,
        // показан текст русской» — человек должен знать, что текст хуже.
        if (outcome.result.note) status = `${status} ${outcome.result.note}`
        if (updated) onChanged?.(updated)
      } else {
        // «Речи в записи нет» — обычный результат, а не поломка: ролики без
        // слов бывают, и красным такое показывать нельзя. Материал при этом
        // не помечаем неудачным: расшифровка прошла, речи просто нет.
        const noSpeech = outcome.error.code === 'no_speech'
        const updated = await mark(noSpeech ? 'done' : 'failed')
        failed = !noSpeech
        status = updated ? outcome.error.message : withSaveNote(outcome.error.message)
        if (updated) onChanged?.(updated)
      }
    } catch (e) {
      // Последняя страховка: сервис не бросает, но хранилище может.
      failed = true
      status = `Расшифровка не удалась: ${describe(e)} Материал и идея на месте.`
    } finally {
      busy = false
    }
  }

  /**
   * Отметка в базе. Возвращает null, если записать не удалось: причина
   * уже показана, а материал и идея остаются как были — терять нечего.
   */
  async function mark(extraction: 'done' | 'failed', text?: string): Promise<Material | null> {
    try {
      return await materialRepository.update(material.id, {
        extraction,
        ...(text === undefined ? {} : { extracted_text: text }),
      })
    } catch {
      return null
    }
  }

  /** Добавляет к сообщению честную оговорку, если отметка не сохранилась. */
  function withSaveNote(message: string): string {
    return `${message} Отметка в базе не сохранилась — материал и идея на месте.`
  }

  function describe(e: unknown): string {
    return e instanceof Error ? e.message : 'неизвестная ошибка'
  }
</script>

<div class="material">
  <div class="head">
    <span class="name">{label}</span>
    {#if duration}<span class="meta">{duration}</span>{/if}
  </div>

  {#if !material.blob && saved === ''}
    <p class="note">Файл не сохранился — расшифровывать нечего. Идея на месте.</p>
  {:else if saved === ''}
    <button type="button" class="btn" onclick={() => void run()} disabled={busy}>
      {busy ? 'Расшифровываю…' : 'Расшифровать'}
    </button>
  {:else}
    <p class="text" class:expanded={expanded}>{expanded ? saved : preview}</p>
    <div class="row">
      {#if cropped}
        <button type="button" class="link" onclick={() => (expanded = !expanded)}>
          {expanded ? 'Свернуть' : 'Показать целиком'}
        </button>
      {/if}
      <button type="button" class="link" onclick={() => void run()} disabled={busy}>
        {busy ? 'Расшифровываю…' : 'Расшифровать заново'}
      </button>
    </div>
  {/if}

  {#if busy}
    <progress max="1" value={progress}></progress>
  {/if}

  {#if status}
    <p class="status" class:failed role="status" aria-live="polite">{status}</p>
  {/if}
</div>

<style>
  .material {
    margin-top: 8px;
    padding: 9px 11px;
    border-radius: 9px;
    background: #0d1320;
    border: 1px solid #1b2130;
  }

  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
  }

  .name {
    font-size: 13px;
    color: #97a3b8;
    overflow-wrap: anywhere;
  }

  .meta {
    flex: none;
    font-size: 12px;
    color: #66718a;
  }

  .btn {
    margin-top: 8px;
    padding: 7px 13px;
    border: none;
    border-radius: 9px;
    background: #5fd4a8;
    color: #08140f;
    font: inherit;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
  }

  .btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .text {
    margin: 8px 0 0;
    font-size: 13px;
    color: #c3cbd8;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .text.expanded {
    max-height: 260px;
    overflow-y: auto;
  }

  .row {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
    margin-top: 6px;
  }

  .link {
    padding: 0;
    border: none;
    background: none;
    color: #5fd4a8;
    font: inherit;
    font-size: 13px;
    cursor: pointer;
    text-decoration: underline;
  }

  .link:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .note {
    margin: 8px 0 0;
    font-size: 13px;
    color: #66718a;
  }

  progress {
    display: block;
    width: 100%;
    height: 4px;
    margin-top: 8px;
    accent-color: #5fd4a8;
  }

  .status {
    margin: 7px 0 0;
    font-size: 12px;
    color: #97a3b8;
    overflow-wrap: anywhere;
    /* Причина отказа от ffmpeg приходит отдельной строкой — показываем её так. */
    white-space: pre-line;
  }

  .failed {
    color: #ff9b7a;
  }
</style>
