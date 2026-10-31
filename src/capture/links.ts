/**
 * ССЫЛКА КАК ИДЕЯ: вытащить из неё хотя бы название.
 *
 * Чего мы не можем: прочитать страницу. Браузер не имеет права загружать
 * чужой сайт (CORS), а сервера у нас пока нет. Поэтому полный разбор ссылки
 * ждёт сервера.
 *
 * Что можем: некоторые сервисы сами отдают данные о своей странице через
 * oEmbed — публичный, документированный канал именно для этого. Оттуда
 * приходит название и автор, и это уже настоящий сигнал: «Как жарить курицу
 * в аэрогриле — рецепт» вместо «Ссылка без названия».
 *
 * ВАЖНО, и это не отговорка: часть сервисов закрыта в России. Instagram
 * запрещён, YouTube замедлен. Если oEmbed не ответил — мы **честно говорим
 * об этом**, а не делаем вид, что ссылка пустая по нашей вине. Человек
 * должен знать, что приложить файл надёжнее.
 */

/** Что удалось узнать о ссылке. */
export interface LinkMeta {
  /** Адрес, к которому это относится. */
  url: string
  /** Название: заголовок страницы или подпись видео. */
  title: string | null
  /** Автор или канал, если сервис его отдаёт. */
  author: string | null
  /** Название сервиса: «YouTube», «VK» и т. п. */
  service: string
  /** Почему названия нет: сервис закрыт, не ответил, время вышло. */
  problem: string | null
}

interface Service {
  name: string
  /**
   * Сервис закрыт в России. Не «неудобен» — именно закрыт.
   *
   * Это нужно, чтобы человек не ломал голову: он вставил ссылку, а названия
   * нет. Скажем прямо, что делать, вместо того чтобы показывать пустоту.
   */
  blocked?: boolean
  /** Подходит ли адрес этому сервису. */
  match: (url: URL) => boolean
  /** Адрес oEmbed, если сервис его умеет. */
  oembed?: (url: string) => string
}

/**
 * Сервисы, которые МЫ знаем. Список намеренно короткий: только те, что
 * реально работают в России и отдают oEmbed. Добавлять «на всякий случай»
 * бессмысленно — если сервис закрыт, запрос всё равно не пройдёт.
 */
const SERVICES: Service[] = [
  {
    name: 'YouTube',
    match: (url) => /(^|\.)youtube\.com$|(^|\.)youtu\.be$/i.test(url.hostname),
    oembed: (url) => `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`,
  },
  {
    name: 'VK',
    match: (url) => /(^|\.)vk\.com$|(^|\.)vkvideo\.ru$/i.test(url.hostname),
  },
  {
    name: 'Rutube',
    match: (url) => /(^|\.)rutube\.ru$/i.test(url.hostname),
  },
  {
    name: 'Telegram',
    match: (url) => /(^|\.)t\.me$/i.test(url.hostname) || /(^|\.)telegram\.me$/i.test(url.hostname),
  },
  {
    name: 'Дзен',
    match: (url) => /(^|\.)dzen\.ru$/i.test(url.hostname),
  },
  {
    name: 'Habr',
    match: (url) => /(^|\.)habr\.com$/i.test(url.hostname),
  },
  {
    name: 'Instagram',
    match: (url) => /(^|\.)instagram\.com$/i.test(url.hostname),
    blocked: true,
  },
  {
    name: 'Facebook',
    match: (url) => /(^|\.)facebook\.com$/i.test(url.hostname),
    blocked: true,
  },
]

/** Какой сервис идёт в ссылке. `null` — не наш случай, но ссылку всё равно храним. */
export function serviceOf(raw: string): { name: string; service: Service | null } {
  try {
    const url = new URL(raw)
    const found = SERVICES.find((service) => service.match(url))
    return { name: found?.name ?? url.hostname.replace(/^www\./, ''), service: found ?? null }
  } catch {
    return { name: 'ссылка', service: null }
  }
}

/**
 * Пробует узнать название по ссылке.
 *
 * Никогда не бросает: не вышло — значит название неизвестно, и это
 * нормальный исход. Идея сохраняется в любом случае — потерять её из-за
 * того, что сервис не ответил, нельзя.
 */
export async function fetchLinkMeta(raw: string, timeoutMs = 8000): Promise<LinkMeta> {
  const { name, service } = serviceOf(raw)

  if (!service) {
    return { url: raw, title: null, author: null, service: name, problem: 'сервис незнакомый' }
  }
  if (!service.oembed) {
    // Честно: сервис знаем, но публичного способа получить название у него нет.
    return { url: raw, title: null, author: null, service: name, problem: 'сервис не отдаёт название' }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(service.oembed(raw), { signal: controller.signal })
    if (!response.ok) {
      return {
        url: raw,
        title: null,
        author: null,
        service: name,
        problem: `сервис ответил ${response.status}`,
      }
    }
    const data = (await response.json()) as { title?: unknown; author_name?: unknown }
    const title = typeof data.title === 'string' ? data.title.trim() : ''
    const author = typeof data.author_name === 'string' ? data.author_name.trim() : ''
    return {
      url: raw,
      title: title === '' ? null : title,
      author: author === '' ? null : author,
      service: name,
      problem: title === '' ? 'название пустое' : null,
    }
  } catch (error) {
    // Самая частая причина в России — сайт закрыт или замедлен.
    return {
      url: raw,
      title: null,
      author: null,
      service: name,
      problem: error instanceof Error && error.name === 'AbortError' ? 'сервис не ответил' : 'сервис недоступен',
    }
  } finally {
    clearTimeout(timer)
  }
}

/** Сервис закрыт в России — ему нужен обход, и ссылку мы не прочитаем. */
export function isBlocked(raw: string): boolean {
  try {
    const url = new URL(raw)
    return SERVICES.some((service) => service.blocked === true && service.match(url))
  } catch {
    return false
  }
}

/**
 * Что сказать человеку, если ссылку прочитать не вышло.
 *
 * Молчать нельзя: он видит адрес вместо названия и не понимает, чья это
 * вина. Говорим, что делать, — и предлагаем путь, который работает всегда.
 */
export function linkHelp(raw: string): string {
  const { name } = serviceOf(raw)
  if (isBlocked(raw)) {
    // Внутренняя кухня человека не касается: что мы делаем с файлом —
    // наша забота. Говорим только то, что нужно ЕМУ сделать.
    return `${name} здесь не открывается. Запишите экран или сохраните видео — пришлите файлом, и идея сохранится.`
  }
  return `${name} не поделился названием. Приложите файл — так надёжнее.`
}

/** Текст для идеи: название и автор, если они есть. */
export function linkToText(meta: LinkMeta): string {
  if (meta.title === null) return ''
  return meta.author === null ? meta.title : `${meta.title} — ${meta.author}`
}
