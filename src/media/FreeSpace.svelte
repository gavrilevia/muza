<script lang="ts">
  /**
   * «Освободить память»: что уже внутри и что можно удалить из галереи.
   *
   * Зачем: файл, загруженный из галереи, лежит на телефоне **дважды** —
   * в галерее и внутри Музы. Человек этого не видит и не помнит, что уже
   * перенёс, а память кончается.
   *
   * ЧЕСТНОЕ ОГРАНИЧЕНИЕ, которое здесь сказано прямым текстом: **браузер
   * не может удалять файлы из галереи**. Это запрет, а не наша лень:
   * страница не получает доступа к файловой системе. Поэтому экран не
   * «удаляет за вас», а **снимает тревогу**: показывает, что уже скопировано
   * и что смело можно убрать руками.
   */
  import { materialRepository } from '../data'
  import type { Material } from '../data'

  let materials = $state<Material[]>([])
  let loading = $state(true)
  let usage = $state<{ used: number; quota: number } | null>(null)
  /**
   * Защищены ли данные от вытеснения.
   *
   * `null` — браузер не умеет отвечать; `false` — умеет и говорит «нет».
   * Разница важна: во втором случае данные МОГУТ исчезнуть, и человек
   * должен знать это заранее, а не узнать по чёрному плееру.
   */
  let persisted = $state<boolean | null>(null)
  let error = $state<string | null>(null)

  const size = (bytes: number): string =>
    bytes >= 1024 * 1024 * 1024
      ? `${(bytes / 1024 / 1024 / 1024).toFixed(1)} ГБ`
      : bytes >= 1024 * 1024
        ? `${(bytes / 1024 / 1024).toFixed(1)} МБ`
        : `${Math.max(1, Math.round(bytes / 1024))} КБ`

  $effect(() => {
    void (async () => {
      try {
        // Материалы с файлами: только они занимают память.
        const all = await materialRepository.listAll()
        // Только материалы С ФАЙЛОМ: без байтов они ничего не занимают.
        materials = all.filter((material) => Boolean(material.blob))
        if (navigator.storage?.estimate) {
          const estimate = await navigator.storage.estimate()
          usage = { used: estimate.usage ?? 0, quota: estimate.quota ?? 0 }
        }
        if (navigator.storage?.persisted) persisted = await navigator.storage.persisted()
      } catch (e) {
        error = e instanceof Error ? e.message : String(e)
      } finally {
        loading = false
      }
    })()
  })

  /** Размер файла: сохранённый при захвате, иначе считаем по самому файлу. */
  function bytesOf(material: Material): number {
    return material.size_bytes ?? material.blob?.size ?? 0
  }

  const total = $derived(materials.reduce((sum, material) => sum + bytesOf(material), 0))

  /**
   * Что уже наверняка внутри Музы: файлы с содержимым.
   *
   * Только они — кандидаты на удаление из галереи. Материал без байтов
   * («файл не сохранился») удалять из галереи НЕЛЬЗЯ: там он теперь
   * единственная копия.
   */
  const copied = $derived(materials.filter((material) => bytesOf(material) > 0))
</script>

<section class="free">
  <h2>Освободить память</h2>

  {#if loading}
    <p class="note">Считаю…</p>
  {:else if error}
    <p class="error">{error}</p>
  {:else}
    <p class="note">
      Муза хранит копии загруженных файлов у себя. Значит, в галерее они лежат
      <strong>второй раз</strong>. Всего внутри: <strong>{size(total)}</strong>
      {#if usage && usage.quota > 0}
        · занято на устройстве {size(usage.used)} из {size(usage.quota)}
      {/if}
    </p>

    {#if persisted === false}
      <!-- Найдено на живом телефоне: без этой защиты браузер молча удаляет
           большие файлы. Молчать нельзя — человек решит, что виновато приложение. -->
      <p class="warning">
        <strong>Телефон не обещает хранить данные.</strong> Большие видео могут
        исчезнуть сами, когда памяти станет мало. Оригиналы в галерее это не
        затрагивает — там они на месте.
      </p>
    {:else if persisted === true}
      <p class="note">Телефон обещает не удалять данные в приложении.</p>
    {/if}

    {#if copied.length === 0}
      <p class="note">Загруженных файлов пока нет.</p>
    {:else}
      <p class="note">
        Эти файлы <strong>можно удалить из галереи</strong> — они уже внутри Музы.
        Удалить может только сам телефон: <strong>браузер не имеет права трогать
        вашу галерею</strong>. Но список ниже — чтобы вы точно знали, что не потеряете.
      </p>
      <details>
        <summary>Показать {copied.length} файлов</summary>
        <ul>
          {#each copied as material (material.id)}
            <li>
              <span class="name">{material.title ?? 'без имени'}</span>
              <span class="size">{size(bytesOf(material))}</span>
            </li>
          {/each}
        </ul>
      </details>
    {/if}

    <p class="note">
      Совет: перед удалением скачайте <strong>копию идей</strong> — она лежит на этой же
      странице ниже. Тогда даже потеря телефона ничего не заберёт.
    </p>
  {/if}
</section>

<style>
  .free {
    margin-top: 18px;
    padding: 14px;
    border-radius: 12px;
    background: #131a2a;
    border: 1px solid #26324a;
  }

  h2 {
    margin: 0 0 8px;
    font-size: 16px;
    color: #e7edf7;
  }

  .note {
    margin: 0 0 9px;
    color: #a9b4c9;
    font-size: 13px;
    line-height: 1.45;
  }

  .note strong {
    color: #e7edf7;
  }

  details {
    margin: 4px 0 9px;
  }

  summary {
    color: #5eead4;
    font-size: 13px;
    cursor: pointer;
  }

  ul {
    list-style: none;
    margin: 9px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-height: 260px;
    overflow-y: auto;
  }

  li {
    display: flex;
    justify-content: space-between;
    gap: 10px;
    font-size: 13px;
    color: #c7d2e5;
  }

  .name {
    overflow-wrap: anywhere;
  }

  .size {
    flex: none;
    color: #66718a;
  }

  .warning {
    margin: 0 0 9px;
    padding: 10px;
    border-radius: 9px;
    background: #1a1a10;
    border: 1px solid #4a3a12;
    color: #fcd34d;
    font-size: 13px;
    line-height: 1.45;
  }

  .warning strong {
    color: #fde68a;
  }

  .error {
    margin: 0;
    color: #fca5a5;
    font-size: 13px;
  }
</style>
