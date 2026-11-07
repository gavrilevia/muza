<script lang="ts">
  /**
   * «Подобрать решение» — только по явному запросу.
   *
   * ЧЕГО ЗДЕСЬ НЕТ: чтения идеи. Поле «что ищем» заполняется заголовком,
   * но человек его видит и правит. На сервер уходит только категория и
   * вилка бюджета — для обезличенной статистики. Текст запроса уходит
   * на сайт, который человек открывает, и никуда больше.
   *
   * ПОКА ЭТО ОБЫЧНЫЙ ПОИСК. Партнёрские ссылки с комиссией появятся,
   * когда будет аккаунт в CPA-сети; шаблоны ниже — заглушки.
   */
  import { BUDGET_BUCKETS, BUDGET_LABELS, CATEGORY_LABELS, PARTNER_CATEGORIES } from './logic'
  import { buildPartnerUrl, normalizePartnerQuery } from './logic'
  import type { BudgetBucket, PartnerCategory, PartnerQuery } from './logic'
  import type { Idea } from '../data'
  import { readServerConfig } from '../server'

  let {
    idea,
    onClose,
    onMute,
  }: {
    idea: Idea
    onClose: () => void
    /** «Не предлагать по этой идее»: App запоминает и прячет кнопку. */
    onMute?: (id: string) => void
  } = $props()

  // Компонент создаётся заново на каждую идею, но поле заполняем один раз:
  // иначе очищенный человеком ввод возвращался бы сам.
  let text = $state('')
  let seeded = false
  $effect(() => {
    if (seeded) return
    seeded = true
    text = idea.title.trim()
  })
  let category = $state<PartnerCategory>('tech')
  let budget = $state<BudgetBucket>('any')
  let city = $state('')
  let options = $state<{ title: string; url: string; note: string }[]>([])
  let error = $state<string | null>(null)
  let sent = $state<PartnerQuery | null>(null)

  /** Заглушки до CPA-сети: обычный поиск, без комиссии. */
  const DEMO: Record<PartnerCategory, { title: string; template: string; note: string }[]> = {
    tech: [
      {
        title: 'Яндекс Маркет',
        template: 'https://market.yandex.ru/search?text={query}',
        note: 'поиск по товарам',
      },
      {
        title: 'Ozon',
        template: 'https://www.ozon.ru/search/?text={query}',
        note: 'поиск по товарам',
      },
    ],
    repair: [
      {
        title: 'Яндекс Услуги',
        template: 'https://uslugi.yandex.ru/search?text={query}',
        note: 'исполнители',
      },
      {
        title: 'Авито',
        template: 'https://www.avito.ru/rossiya?q={query}',
        note: 'объявления',
      },
    ],
    services: [
      {
        title: 'Яндекс Услуги',
        template: 'https://uslugi.yandex.ru/search?text={query}',
        note: 'исполнители',
      },
    ],
  }

  function show(): void {
    error = null
    const query = normalizePartnerQuery({ text, category, budget, city })
    if (!query) {
      error = 'Впишите, что искать, и выберите категорию.'
      options = []
      return
    }
    const subid = crypto.randomUUID().slice(0, 8)
    const built = DEMO[query.category]
      .map((item) => {
        const url = buildPartnerUrl(item.template, query, subid)
        return url ? { title: item.title, url, note: item.note } : null
      })
      .filter((item): item is { title: string; url: string; note: string } => item !== null)
    sent = query
    options = built
    if (built.length === 0) error = 'Не получилось собрать ссылки.'
  }

  /**
   * Отмечает клик — ПОСЛЕ перехода и без ожидания.
   *
   * `sendBeacon` не блокирует открытие ссылки и переживает уход со
   * страницы. Тело — только категория и вилка; текста и города там нет.
   */
  function trackClick(): void {
    if (!sent) return
    const body = JSON.stringify({ category: sent.category, budget: sent.budget })
    void readServerConfig()
      .then((config) => {
        navigator.sendBeacon?.(
          `${config.baseUrl}/partner/click`,
          new Blob([body], { type: 'application/json' }),
        )
      })
      .catch(() => {
        /* статистика не важнее перехода */
      })
  }
</script>

<div class="backdrop" role="dialog" aria-modal="true" aria-label="Подобрать решение">
  <div class="sheet">
    <div class="bar">
      <span>Подобрать решение</span>
      <button type="button" class="close" onclick={onClose} aria-label="Закрыть">×</button>
    </div>

    <p class="lead">
      Уйдёт только этот запрос. Текст идеи, расшифровки и имена останутся
      на устройстве.
    </p>

    <label class="field">
      <span>Что ищем</span>
      <input
        bind:value={text}
        maxlength="200"
        aria-label="Что ищем"
        placeholder="Например: аэрогриль 5 л"
      />
    </label>

    <div class="row cats">
      {#each PARTNER_CATEGORIES as value (value)}
        <button
          type="button"
          class="chip"
          class:on={category === value}
          onclick={() => (category = value)}
        >
          {CATEGORY_LABELS[value]}
        </button>
      {/each}
    </div>

    <div class="two">
      <label class="field">
        <span>Бюджет</span>
        <select bind:value={budget} aria-label="Бюджет">
          {#each BUDGET_BUCKETS as value (value)}
            <option value={value}>{BUDGET_LABELS[value]}</option>
          {/each}
        </select>
      </label>
      <label class="field">
        <span>Город (необязательно)</span>
        <input bind:value={city} maxlength="60" aria-label="Город" placeholder="Новосибирск" />
      </label>
    </div>

    <div class="row">
      <button type="button" class="btn" onclick={show}>Показать варианты</button>
      {#if onMute}
        <button type="button" class="link" onclick={() => onMute?.(idea.id)}>
          Не предлагать по этой идее
        </button>
      {/if}
    </div>

    {#if error}
      <p class="error" role="status">{error}</p>
    {/if}

    {#if options.length > 0}
      <ul class="options">
        {#each options as option (option.url)}
          <li>
            <a
              href={option.url}
              target="_blank"
              rel="noopener noreferrer"
              onclick={trackClick}
            >
              <span class="name">{option.title}</span>
              <span class="note">{option.note}</span>
            </a>
          </li>
        {/each}
      </ul>
      <p class="fine">
        Пока это обычный поиск: партнёрские предложения подключим после
        договора с сетью. Клик отмечается обезличенно — категория и вилка.
      </p>
    {/if}
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 40;
    display: grid;
    place-items: end center;
    background: rgba(4, 7, 12, 0.7);
    padding: 12px;
  }

  .sheet {
    width: min(520px, 100%);
    max-height: 88dvh;
    overflow: auto;
    padding: 16px;
    border-radius: 16px;
    background: #0f1420;
    border: 1px solid #26324a;
  }

  .bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-weight: 600;
    margin-bottom: 8px;
  }

  .close {
    width: 44px;
    height: 44px;
    border: 0;
    background: transparent;
    color: var(--dim);
    font-size: 24px;
    cursor: pointer;
  }

  .lead {
    margin: 0 0 14px;
    color: var(--dim);
    font-size: 13px;
    line-height: 1.45;
  }

  .field {
    display: block;
    margin-bottom: 10px;
  }

  .field span {
    display: block;
    margin-bottom: 6px;
    font-size: 13px;
    color: var(--dim);
  }

  .field input,
  .field select {
    width: 100%;
    box-sizing: border-box;
    padding: 10px;
    border-radius: 10px;
    border: 1px solid #2b3a55;
    background: #0a0f1a;
    color: #e7edf7;
    font-size: 16px;
  }

  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }

  .cats {
    margin-bottom: 10px;
  }

  .chip {
    padding: 8px 12px;
    border-radius: 999px;
    border: 1px solid #2b3a55;
    background: transparent;
    color: #e7edf7;
    font-size: 14px;
    cursor: pointer;
  }

  .chip.on {
    border-color: #ff8a5b;
    background: #2a1c14;
    color: #ffd9a8;
  }

  .two {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }

  .btn {
    padding: 11px 14px;
    border: 0;
    border-radius: 10px;
    background: #ff8a5b;
    color: #14100d;
    font-weight: 600;
    cursor: pointer;
  }

  .link {
    border: 0;
    background: transparent;
    color: var(--dim);
    font-size: 13px;
    text-decoration: underline;
    cursor: pointer;
  }

  .error {
    margin: 10px 0 0;
    color: #ffb4a8;
    font-size: 13px;
  }

  .options {
    list-style: none;
    margin: 12px 0 0;
    padding: 0;
    display: grid;
    gap: 8px;
  }

  .options a {
    display: flex;
    justify-content: space-between;
    gap: 10px;
    padding: 12px;
    border-radius: 10px;
    background: #111725;
    border: 1px solid #26324a;
    color: #e7edf7;
    text-decoration: none;
  }

  .options .name {
    font-weight: 600;
  }

  .options .note {
    color: var(--dim);
    font-size: 13px;
  }

  .fine {
    margin: 10px 0 0;
    color: var(--dim);
    font-size: 12px;
    line-height: 1.4;
  }
</style>
