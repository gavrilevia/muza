/**
 * SearchService — поиск по слову: мгновенный, офлайн, с сохранением индекса.
 *
 * Как устроено:
 *   1. MiniSearch держит перевёрнутый индекс в памяти — поиск идёт по нему,
 *      база во время поиска не читается вовсе;
 *   2. индекс сериализуется в хранилище `meta` под ключом `search.index.v1`
 *      (там же, где настройки), поэтому перезагрузка страницы не заставляет
 *      собирать его заново;
 *   3. после создания, правки или удаления идеи зовётся один из методов
 *      `indexIdea` / `removeIdea` / `indexMaterial` / `removeMaterial` —
 *      они меняют один документ, без полной пересборки;
 *   4. `build()` — полная пересборка: нужна при смене версии индекса,
 *      импорте копии и любом случае, когда непонятно, чему верить.
 *
 * Что индексируется: заголовок, тело идеи и `extracted_text` её материалов.
 * Удалённые идеи (`status: deleted`) в индекс не попадают, а если попали
 * раньше — отсеиваются на выдаче.
 *
 * Чего здесь нет: сети, ИИ и интерфейса. Экран поиска — отдельно; сюда он
 * приходит только за результатами.
 */

import MiniSearch from 'minisearch'
import type { Options, SearchOptions as MiniSearchOptions, SearchResult } from 'minisearch'

import {
  countAll,
  ideaRepository,
  iterateStore,
  materialRepository,
  nowIso,
  req,
  withTx,
} from '../data'
import type { Idea, IdeaStatus, Material, MetaRecord } from '../data'
import type {
  SearchField,
  SearchHit,
  SearchQueryOptions,
  SearchStats,
} from './types'

/**
 * Ключ сохранённого индекса в `meta`.
 * Версия стоит и в имени ключа, и в самом значении: старый индекс при смене
 * настроек не читается, а новый ключ не конфликтует со старым.
 */
export const SEARCH_INDEX_KEY = 'search.index.v1'

/** Версия формата сохранённого индекса. Меняется вместе с ключом. */
export const SEARCH_INDEX_VERSION = 1

/** Поля документа: то, что человек ищет словом. */
const FIELDS = ['title', 'body', 'materials'] as const

/** Что вернуть вместе с результатом, чтобы не читать базу ради заголовка. */
const STORE_FIELDS = ['title', 'status'] as const

/** Сколько результатов отдавать по умолчанию. */
const DEFAULT_LIMIT = 20

/** Как индекс лежит в `meta`. */
interface SavedIndex {
  version: number
  saved_at: string
  /** Сколько идей и материалов было в базе при сохранении — признак устаревания. */
  idea_count: number
  material_count: number
  /** Сериализованный MiniSearch: `JSON.stringify(index)`. */
  json: string
}

/** Документ индекса: одна идея и весь текст, найденный в её материалах. */
interface IdeaDocument {
  id: string
  title: string
  body: string
  materials: string
  status: IdeaStatus
}

/**
 * Префикс — только для слов от двух букв.
 * Одна буква совпадает почти со всем словарём: и результат бесполезен,
 * и работы у индекса много.
 */
function prefixTerm(term: string): boolean {
  return term.length >= 2
}

/**
 * Одна опечатка прощается словам от четырёх букв.
 * У коротких слов правка в один символ меняет слово целиком
 * («дом» → «ком»), поэтому они ищутся точно.
 */
function fuzzyTerm(term: string): number {
  return term.length > 3 ? 1 : 0
}

/**
 * Приведение слова: нижний регистр и «ё» → «е».
 *
 * Без этого поиск по русскому тексту спотыкается: в идее «ёлка», а человек
 * набирает «елка». Функция общая для индексации и для запроса — иначе
 * слова перестанут совпадать между собой.
 */
function normalizeTerm(term: string): string | null {
  const folded = term.toLowerCase().replace(/ё/g, 'е')
  return folded.length > 0 ? folded : null
}

/** Непустые тексты материалов: пустые строки индекс только раздувают. */
function materialTextsOf(materials: readonly Material[]): string[] {
  const texts: string[] = []
  for (const material of materials) {
    const text = material.extracted_text?.trim()
    if (text) texts.push(text)
  }
  return texts
}

/** Идея плюс её материалы → документ индекса. */
function toDocument(idea: Idea, texts: readonly string[]): IdeaDocument {
  return {
    id: idea.id,
    title: idea.title,
    body: idea.body,
    materials: texts.join('\n'),
    status: idea.status,
  }
}

/** Результат MiniSearch → находка «Музы». */
function toHit(result: SearchResult): SearchHit {
  const fields = new Set<SearchField>()
  for (const names of Object.values(result.match)) {
    for (const name of names) {
      if (name === 'title' || name === 'body' || name === 'materials') fields.add(name)
    }
  }
  const status = result.status
  return {
    id: String(result.id),
    title: typeof result.title === 'string' ? result.title : '',
    status: typeof status === 'string' ? (status as IdeaStatus) : 'inbox',
    score: result.score,
    terms: result.terms,
    fields: [...fields],
  }
}

/**
 * Проверяет и разбирает значение из `meta`.
 * Всё, что не похоже на наш индекс, считается отсутствующим: сервис обязан
 * пережить и чужую запись, и обрезанный JSON.
 */
function toSavedIndex(value: unknown): SavedIndex | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  if (raw.version !== SEARCH_INDEX_VERSION) return null
  if (typeof raw.json !== 'string' || raw.json.length === 0) return null
  if (typeof raw.idea_count !== 'number' || typeof raw.material_count !== 'number') return null
  return {
    version: raw.version,
    saved_at: typeof raw.saved_at === 'string' ? raw.saved_at : nowIso(),
    idea_count: raw.idea_count,
    material_count: raw.material_count,
    json: raw.json,
  }
}

/**
 * Тексты материалов, сгруппированные по идее.
 *
 * Идём курсором, а не `getAll`: у материала в записи лежат ещё и байты файла
 * (`blob`), и держать их все в памяти разом незачем — для индекса нужен
 * только `extracted_text`.
 */
async function readMaterialTexts(): Promise<{ byIdea: Map<string, string[]>; count: number }> {
  const byIdea = new Map<string, string[]>()
  let count = 0
  await withTx('materials', 'readonly', (tx) =>
    iterateStore<Material>(tx, 'materials', (material) => {
      count += 1
      const text = material.extracted_text?.trim()
      if (!text) return
      const list = byIdea.get(material.idea_id)
      if (list) list.push(text)
      else byIdea.set(material.idea_id, [text])
    }),
  )
  return { byIdea, count }
}

export class SearchService {
  /** Индекс в памяти; `null` — ещё не загружен. */
  private index: MiniSearch<IdeaDocument> | null = null
  /** Идущая загрузка: повторные вызовы ждут ту же операцию, а не вторую. */
  private loading: Promise<void> | null = null
  private source: SearchStats['source'] = 'empty'
  private savedBytes = 0
  private savedAt: string | null = null
  /**
   * Очередь изменений индекса.
   * Два обновления не должны обгонять друг друга: иначе более старое
   * сохранение может лечь в базу после нового и потерять чужую правку.
   */
  private writeChain: Promise<void> = Promise.resolve()

  /** Готов ли индекс к поиску. */
  get isReady(): boolean {
    return this.index !== null
  }

  /**
   * Ждёт окончания фоновых обновлений индекса.
   *
   * Нужно экрану поиска: после расшифровки обновление идёт в фоне, чтобы
   * не задерживать показ текста. Без ожидания первый же запрос мог бы
   * вернуть старую выдачу. Ошибки обновлений сюда не пробрасываются —
   * они уже случились у того, кто обновление запускал.
   */
  async whenIdle(): Promise<void> {
    // Очередь заканчивается, когда последнее изменение дописало индекс.
    await this.writeChain
  }

  /**
   * Ставит изменение индекса в очередь и ждёт только его.
   * Сбой одного изменения не останавливает следующие.
   */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.writeChain.then(task, task)
    // Хвост очереди всегда «успешный»: иначе одна ошибка закрыла бы её.
    this.writeChain = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  /**
   * Настройки MiniSearch.
   * Одна и та же фабрика используется и при сборке, и при `loadJSON`:
   * сохранённый индекс читается теми же правилами, какими собран.
   */
  private options(): Options<IdeaDocument> {
    return {
      fields: [...FIELDS],
      idField: 'id',
      storeFields: [...STORE_FIELDS],
      processTerm: normalizeTerm,
      searchOptions: {
        // Начало слова и одна опечатка — возможности MiniSearch, настроенные
        // осознанно: префикс от двух букв, правка — словам от четырёх.
        prefix: prefixTerm,
        fuzzy: fuzzyTerm,
        // Все слова запроса обязаны найтись: так же ведёт себя и поиск
        // в IdeaRepository, и меньше случайных попаданий.
        combineWith: 'AND',
        // Слово из заголовка весит втрое: обычно оно и есть суть идеи.
        boost: { title: 3, body: 1, materials: 1 },
        // Страховка на случай индекса, собранного старой версией:
        // удалённая идея не должна показаться, даже если попала в индекс.
        filter: (result) => result.status !== 'deleted',
      },
    }
  }

  /**
   * Готовит индекс к работе: читает сохранённый из `meta`, а если того нет,
   * он устарел или битый — собирает заново. Сама операция одна на всех:
   * параллельные вызовы ждут её, а не запускают вторую.
   */
  async ensure(): Promise<void> {
    if (this.index) return
    if (this.loading) return this.loading

    const task = this.restoreOrBuild()
    this.loading = task
    try {
      await task
    } finally {
      if (this.loading === task) this.loading = null
    }
  }

  /**
   * Полная пересборка индекса по базе.
   * Нужна при смене версии индекса, после импорта копии и как честный
   * ответ на «индекс не сходится с данными».
   */
  async build(): Promise<SearchStats> {
    return this.enqueue(() => this.buildNow())
  }

  /** Та же пересборка без очереди: её зовёт `ensure` изнутри изменения. */
  private async buildNow(): Promise<SearchStats> {
    const ideas = await ideaRepository.listAll()
    const materials = await readMaterialTexts()

    const index = new MiniSearch<IdeaDocument>(this.options())
    const documents: IdeaDocument[] = []
    for (const idea of ideas) {
      if (idea.status === 'deleted') continue
      documents.push(toDocument(idea, materials.byIdea.get(idea.id) ?? []))
    }
    index.addAll(documents)

    this.index = index
    this.source = 'rebuilt'
    await this.persist(ideas.length, materials.count)
    return this.stats()
  }

  /**
   * Инкрементальное обновление: одна идея после создания или правки.
   * Полная пересборка не нужна — MiniSearch заменяет один документ.
   * Если идея удалена статусом, она из индекса убирается.
   */
  async indexIdea(idea: Idea): Promise<void> {
    return this.enqueue(() => this.indexIdeaNow(idea))
  }

  /** Обновление одной идеи без очереди: его зовут изнутри других изменений. */
  private async indexIdeaNow(idea: Idea): Promise<void> {
    await this.ensure()
    const index = this.index
    if (!index) return

    if (idea.status === 'deleted') {
      if (this.discard(idea.id)) await this.persistCurrent()
      return
    }

    const materials = await materialRepository.listByIdea(idea.id)
    const document = toDocument(idea, materialTextsOf(materials))
    if (index.has(idea.id)) index.replace(document)
    else index.add(document)
    await this.persistCurrent()
  }

  /**
   * Инкрементальное удаление: идея сразу пропадает из результатов.
   * Повторный вызов для уже убранной идеи ничего не делает — и не пишет
   * индекс в базу зря.
   */
  async removeIdea(ideaId: string): Promise<void> {
    return this.enqueue(() => this.removeIdeaNow(ideaId))
  }

  /** Удаление одной идеи без очереди. */
  private async removeIdeaNow(ideaId: string): Promise<void> {
    await this.ensure()
    if (!this.discard(ideaId)) return
    await this.persistCurrent()
  }

  /**
   * Инкрементальное обновление по материалу: изменился `extracted_text` —
   * переиндексируем только ту идею, к которой материал приложен.
   */
  async indexMaterial(material: Material): Promise<void> {
    return this.enqueue(() => this.indexMaterialNow(material))
  }

  /** То же без очереди — чтобы не ждать самих себя. */
  private async indexMaterialNow(material: Material): Promise<void> {
    await this.ensure()
    const idea = await ideaRepository.get(material.idea_id)
    if (idea) await this.indexIdeaNow(idea)
  }

  /** Материал удалён — идея остаётся, но текста у неё в индексе стало меньше. */
  async removeMaterial(material: Material): Promise<void> {
    return this.enqueue(() => this.removeMaterialNow(material))
  }

  /** То же без очереди — чтобы не ждать самих себя. */
  private async removeMaterialNow(material: Material): Promise<void> {
    await this.ensure()
    const idea = await ideaRepository.get(material.idea_id)
    if (idea) await this.indexIdeaNow(idea)
  }

  /**
   * Ищет по слову. Пустой запрос — пустой ответ: «показать всё» через поиск
   * не бывает.
   *
   * Сам поиск идёт по индексу в памяти; база не читается. Первый вызов
   * может подождать `ensure` — дальше это чистые вычисления.
   */
  async search(query: string, options: SearchQueryOptions = {}): Promise<SearchHit[]> {
    const text = query.trim()
    if (!text) return []

    await this.ensure()
    // Обновления, запущенные в фоне (например, после расшифровки), должны
    // доехать до индекса: иначе первый же запрос покажет старую выдачу.
    await this.whenIdle()
    const index = this.index
    if (!index) return []

    // Передаём только то, что правда просили: остальное возьмётся из
    // настроек по умолчанию, заданных в `options()`.
    const overrides: MiniSearchOptions = {}
    if (options.prefix !== undefined) overrides.prefix = options.prefix
    if (options.fuzzy !== undefined) overrides.fuzzy = options.fuzzy
    if (options.combineWith !== undefined) overrides.combineWith = options.combineWith

    const found = index.search(text, overrides)
    const limit = options.limit ?? DEFAULT_LIMIT
    return (limit > 0 ? found.slice(0, limit) : found).map(toHit)
  }

  /** Состояние индекса: откуда взят, сколько в нём идей и слов. */
  stats(): SearchStats {
    const index = this.index
    return {
      source: index ? this.source : 'empty',
      ideas: index?.documentCount ?? 0,
      terms: index?.termCount ?? 0,
      bytes: this.savedBytes,
      saved_at: this.savedAt,
    }
  }

  /**
   * Читает сохранённый индекс и решает, можно ли ему верить.
   *
   * Признак устаревания — число идей и материалов в базе: оно меняется при
   * импорте копии и любом захвате мимо сервиса. Правка содержимого число не
   * меняет — такой случай закрывает явный `build()`; сервис для того и
   * просит звать себя после каждой правки.
   */
  private async restoreOrBuild(): Promise<void> {
    const saved = await this.readSaved()
    if (saved) {
      const [ideaCount, materialCount] = await Promise.all([
        countAll('ideas'),
        countAll('materials'),
      ])
      if (saved.idea_count === ideaCount && saved.material_count === materialCount) {
        try {
          this.index = MiniSearch.loadJSON<IdeaDocument>(saved.json, this.options())
          this.source = 'saved'
          this.savedBytes = saved.json.length
          this.savedAt = saved.saved_at
          return
        } catch {
          // Битый или несовместимый JSON: не падаем — соберём заново.
        }
      }
    }
    await this.buildNow()
  }

  /** Сохранённый индекс из `meta`; битую или чужую запись считаем отсутствующей. */
  private async readSaved(): Promise<SavedIndex | null> {
    try {
      const record = await withTx('meta', 'readonly', (tx) =>
        req<MetaRecord | undefined>(tx.objectStore('meta').get(SEARCH_INDEX_KEY)),
      )
      return toSavedIndex(record?.value)
    } catch {
      return null
    }
  }

  /**
   * Сериализует индекс и кладёт в `meta`.
   * Счётчики базы пишутся рядом: по ним следующий запуск поймёт, устарел ли
   * индекс, не читая ни одной идеи.
   */
  private async persist(ideaCount: number, materialCount: number): Promise<void> {
    const index = this.index
    if (!index) return

    const json = JSON.stringify(index)
    const saved_at = nowIso()
    const value: SavedIndex = {
      version: SEARCH_INDEX_VERSION,
      saved_at,
      idea_count: ideaCount,
      material_count: materialCount,
      json,
    }
    const record: MetaRecord = { key: SEARCH_INDEX_KEY, value, updated_at: saved_at }
    await withTx('meta', 'readwrite', (tx) => {
      tx.objectStore('meta').put(record)
    })
    this.savedBytes = json.length
    this.savedAt = saved_at
  }

  /** Сохранение после инкрементальной правки: счётчики берём из базы. */
  private async persistCurrent(): Promise<void> {
    const [ideaCount, materialCount] = await Promise.all([
      countAll('ideas'),
      countAll('materials'),
    ])
    await this.persist(ideaCount, materialCount)
  }

  /** Убирает документ из индекса; `false` — убирать было нечего. */
  private discard(ideaId: string): boolean {
    const index = this.index
    if (!index || !index.has(ideaId)) return false
    index.discard(ideaId)
    return true
  }
}

/** Готовый экземпляр для приложения. */
export const searchService = new SearchService()
