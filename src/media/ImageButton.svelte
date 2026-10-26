<script lang="ts">
  /**
   * Кнопка «Прочитать и описать» и показ готового текста для материала-картинки.
   *
   * Почему подпись именно такая: модель делает ДВЕ вещи за один запрос —
   * читает текст (он нужен поиску) и описывает изображение (смысл нужен
   * направлениям). «Прочитать картинку» было бы нечестно, если текста на ней
   * нет; «Описать» скрыло бы, что текст тоже распознаётся. Поэтому на кнопке
   * прямо названы оба действия, а подпись под ней объясняет их простыми словами.
   *
   * Сервис собирается в обработчике нажатия, а не при появлении экрана:
   * ключ, добавленный позже, должен быть виден (та же причина, что у
   * «Расшифровать»). Ничего не запускается само: это платная операция,
   * решение принимает человек.
   *
   * Материал и идея не теряются ни при какой ошибке: сервис только читает
   * `blob`, а отметка в базе — отдельный шаг, и её сбой не прячет причину.
   */

  import { materialRepository } from '../data'
  import type { Material } from '../data'
  import { metaStore } from '../directions/meta'
  import { createImageUnderstandingService } from './ImageUnderstandingService'
  import { describeImageCost, formatImageCost } from './format'

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

  /** Готовый текст, если он уже есть: иначе показываем кнопку. */
  const saved = $derived((material.extracted_text ?? '').trim())

  /** Свёрнутый вид: первые строки, чтобы было видно, что текст появился. */
  const preview = $derived.by(() => {
    if (saved === '') return ''
    const head = saved.split('\n').slice(0, 4).join('\n')
    return head.length > 260 ? `${head.slice(0, 260)}…` : head
  })

  /** Есть ли что прятать за «показать целиком». */
  const cropped = $derived(saved.length > preview.length)

  /** Подпись материала: имя файла или понятное слово. */
  const label = $derived(material.title || material.file || 'Картинка')

  async function run(): Promise<void> {
    if (busy) return

    // Повторный запрос перезаписывает готовый текст — только с согласия.
    if (saved !== '') {
      const agreed = window.confirm('Текст и описание уже есть. Посмотреть картинку заново и заменить их?')
      if (!agreed) return
    }

    const blob = material.blob
    if (!blob) {
      failed = true
      // Материал без файла — тоже неудачная попытка: отметка не даст очереди
      // считать его готовым. Текст, если он уже был, не стираем.
      const updated = saved === '' ? await mark('failed') : null
      const line = 'Файл не сохранился — смотреть нечего. Материал и идея на месте.'
      status = saved === '' && !updated ? withSaveNote(line) : line
      if (updated) onChanged?.(updated)
      return
    }

    busy = true
    failed = false
    progress = 0
    status = 'Готовлю картинку…'

    try {
      // Ключ читается в момент нажатия: добавленный позже он уже виден.
      const service = await createImageUnderstandingService({ store: metaStore })
      const outcome = await service.understand({
        source: {
          blob,
          // Тип для решения о формате не используется — сервис смотрит байты.
          mimeType: material.mime ?? blob.type ?? null,
          name: material.file,
        },
        onProgress: (event) => {
          progress = event.progress
          status = event.message
        },
      })

      if (outcome.ok) {
        const updated = await mark('done', outcome.result.text)
        // Что реально произошло: уменьшили ли картинку и сколько это стоило.
        const size = outcome.result.resized
          ? `Картинка уменьшена до ${outcome.result.width}×${outcome.result.height}.`
          : ''
        const price = describeImageCost(outcome.result.costRub, outcome.result.usage.estimated)
        const line = ['Готово: текст с картинки и описание сохранены.', size, price]
          .filter(Boolean)
          .join(' ')
        status = updated ? line : withSaveNote(line)
        if (updated) onChanged?.(updated)
      } else {
        // Неудача: материал не трогаем, но отмечаем попытку и показываем
        // причину. Если провайдер уже списал деньги — говорим и об этом.
        const updated = await mark('failed')
        failed = true
        const spent =
          outcome.error.costRub > 0 ? `Списано: ${formatImageCost(outcome.error.costRub)}.` : ''
        const line = [outcome.error.message, spent].filter(Boolean).join(' ')
        status = updated ? line : withSaveNote(line)
        if (updated) onChanged?.(updated)
      }
    } catch (e) {
      // Последняя страховка: сервис не бросает, но хранилище или настройки
      // могут. Материал не теряем — только отмечаем попытку и показываем причину.
      failed = true
      const updated = await mark('failed')
      const line = `Не удалось понять картинку: ${describe(e)} Материал и идея на месте.`
      status = updated ? line : withSaveNote(line)
      if (updated) onChanged?.(updated)
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
    <span class="meta">картинка</span>
  </div>

  {#if !material.blob && saved === ''}
    <p class="note">Файл не сохранился — смотреть нечего. Идея на месте.</p>
  {:else if saved === ''}
    <button type="button" class="btn" onclick={() => void run()} disabled={busy}>
      {busy ? 'Смотрю картинку…' : 'Прочитать и описать'}
    </button>
    <p class="hint">Модель прочитает текст на картинке и коротко опишет её. Запрос платный и уходит только по нажатию.</p>
  {:else}
    <p class="text" class:expanded={expanded}>{expanded ? saved : preview}</p>
    <div class="row">
      {#if cropped}
        <button type="button" class="link" onclick={() => (expanded = !expanded)}>
          {expanded ? 'Свернуть' : 'Показать целиком'}
        </button>
      {/if}
      <button type="button" class="link" onclick={() => void run()} disabled={busy}>
        {busy ? 'Смотрю картинку…' : 'Прочитать и описать заново'}
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
    background: #7aa2ff;
    color: #0a1020;
    font: inherit;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
  }

  .btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .hint {
    margin: 6px 0 0;
    font-size: 12px;
    color: #66718a;
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
    color: #7aa2ff;
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
    accent-color: #7aa2ff;
  }

  .status {
    margin: 7px 0 0;
    font-size: 12px;
    color: #97a3b8;
    overflow-wrap: anywhere;
    white-space: pre-line;
  }

  .failed {
    color: #ff9b7a;
  }
</style>
