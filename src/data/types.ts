/**
 * Типы данных «Музы».
 *
 * Источник полей — СХЕМА-ДАННЫХ.md (разделы Idea, Material, Fork, Direction),
 * состав объектных хранилищ и индексов — АРХИТЕКТУРА-PWA.md, раздел 3.3.
 *
 * Договорённость о датах: все моменты времени храним строками ISO-8601 в UTC
 * (`2026-02-11T09:14:22.000Z`). Причины: строки такого вида сортируются
 * лексикографически так же, как по времени, читаются человеком в выгрузке
 * и не превращаются в объекты Date при проходе через structured clone.
 *
 * Часть полей в документах помечена как необязательная. Здесь они записаны
 * как `T | null` (а не `T | undefined`): в IndexedDB запись с `null` остаётся
 * стабильной по форме, а индексы одинаково пропускают и `null`, и `undefined`.
 */

/** Состояние идеи в жизненном цикле (см. СХЕМА-ДАННЫХ.md, раздел 4). */
export type IdeaStatus =
  | 'inbox'
  | 'incubating'
  | 'dormant'
  | 'frozen'
  | 'archived'
  | 'exported'
  | 'deleted'

/** Что это за штука: слой `kind`, 4–6 значений, ставится автоматически. */
export type IdeaKind =
  | 'recipe'
  | 'purchase'
  | 'place'
  | 'gift'
  | 'read'
  | 'do'
  | 'note'

/** Почему у идеи такой момент уместности. */
export type MomentRule = 'date' | 'season' | 'event' | 'price' | 'manual'

/** Каким путём мысль попала в систему. */
export type CapturedVia =
  | 'share_sheet'
  | 'share_multiple'
  | 'files_save'
  | 'voice'
  | 'video_record'
  | 'widget'
  | 'quick_tile'
  | 'clipboard'
  | 'camera'
  | 'gallery_import'
  | 'desktop_text'
  | 'desktop_file'

/** Свободные свойства идеи: `{"быстро": true, "сезон": "лето"}`. */
export type IdeaProps = Record<string, unknown>

/** Идея — центральная сущность. */
export interface Idea {
  /** ULID: сортируется по времени, генерируется на устройстве. */
  id: string
  /** Первая строка или авто-заголовок. Может быть пустым. */
  title: string
  /** Текст идеи в markdown. Может быть пустым (идея = голос или картинка). */
  body: string
  status: IdeaStatus
  /** Когда пришла мысль (не когда загрузилась). */
  captured_at: string
  captured_via: CapturedVia
  /** Когда ветвь «заснула». Вычисляется, хранится для стабильности. */
  sleep_at: string | null
  archived_reason: string | null
  /** Идея исключена из ИИ-обработки (приватность). */
  ai_opt_out: boolean
  /** Корень древа, если это ветвь другой идеи. */
  root_of: string | null
  /** Идею обдумывают, а не просто используют. */
  worked_on: boolean
  /** Направление — одно на идею. */
  direction_id: string | null
  kind: IdeaKind | null
  props: IdeaProps
  /** Момент: когда идея станет уместной. */
  moment_at: string | null
  moment_rule: MomentRule | null
  /** Когда запись появилась в базе. */
  created_at: string
  /** Последняя активность — по ней считаются «застоявшиеся» и индекс by_activity. */
  last_activity_at: string
}

/** Поля, которые принимает `create`: остальное подставляется по умолчанию. */
export type NewIdea = Partial<Omit<Idea, 'id' | 'created_at' | 'last_activity_at'>> & {
  id?: string
}

/** Поля, которые можно менять через `update`: id и created_at неизменны. */
export type IdeaPatch = Partial<Omit<Idea, 'id' | 'created_at'>>

/** Направление — «о чём идея». Направлений мало (5–9), они общие для всех идей. */
export interface Direction {
  id: string
  /** Название словами пользователя: «Дача», «Подарки». */
  name: string
  /** Эмодзи или иконка. */
  icon: string | null
  /** Вопрос для разбора: «у кого скоро день рождения». */
  review_hint: string | null
  /** Порядок в сетке направлений. */
  order: number
  /** Окно «что сейчас кстати» в днях; `null` — общее значение по умолчанию. */
  window_days: number | null
  created_at: string
  /** Для выбора «какое направление застоялось». */
  last_reviewed_at: string | null
}

/** Поля, которые принимает `DirectionStore.create`. */
export type NewDirection = Partial<Omit<Direction, 'id' | 'created_at'>> & { id?: string }

// --- Материалы ---------------------------------------------------------------

export type MaterialKind = 'link' | 'pdf' | 'image' | 'video' | 'audio' | 'text' | 'quote'
export type MaterialOrigin = 'user' | 'shared' | 'imported'
export type ExtractionState = 'pending' | 'done' | 'failed' | 'skipped'

/**
 * Материал идеи. Хранилище `materials` создаётся сразу, но полноценного
 * интерфейса работы с материалами в этой задаче нет — есть только тип
 * и импорт/экспорт.
 */
export interface Material {
  id: string
  idea_id: string
  kind: MaterialKind
  origin: MaterialOrigin
  /** Для ссылок. */
  uri: string | null
  /** Для файлов: относительный путь. */
  file: string | null
  title: string | null
  /** Транскрипт, OCR, текст страницы — то, по чему идёт поиск. */
  extracted_text: string | null
  extraction: ExtractionState
  added_at: string

  // Поля видео. Решение автора: оригинал храним всегда (см. ВИДЕО.md).
  duration_sec?: number | null
  /** Вес оригинала — для сводки и предупреждений. */
  size_bytes?: number | null
  /** Кадр-обложка. */
  poster?: string | null
  /** Пути к извлечённым кадрам. */
  frames?: string[]
  /** Расшифровка речи. */
  transcript?: string | null
  /** Текст, распознанный с кадров. */
  ocr_text?: string | null
  /** Когда сжали (`null` — оригинал). */
  compressed_at?: string | null
  /** Вынесено ли в `attachments-blobs/`. */
  moved_to_blobs?: boolean
}

// --- История -----------------------------------------------------------------

/** Тип развилки. */
export type HistoryType =
  | 'origin'
  | 'development'
  | 'link'
  | 'reformulation'
  | 'doubt'
  | 'freeze'
  | 'archive'
  | 'export'
  | 'return'
  | 'materials'

export type Actor = 'user' | 'ai' | 'system'

/**
 * Развилка — запись append-only журнала.
 *
 * Записи никогда не изменяются и не удаляются: исправление оформляется новой
 * развилкой `reformulation` со ссылкой на предыдущую. Уникальный `id` даёт
 * слияние журналов простым объединением по id.
 */
export interface HistoryEntry {
  id: string
  idea_id: string
  type: HistoryType
  at: string
  actor: Actor
  /** Одна фраза: что произошло. */
  summary: string
  /** Почему ИИ так решил (прозрачность). */
  ai_reason: string | null
  /** Ссылка на материал, идею или пакет выгрузки. */
  ref: string | null
  /** Свободные поля, например `{"branch": "logistics"}`. */
  meta: Record<string, unknown>
}

/** Поля, которые принимает `HistoryStore.append`. */
export type NewHistoryEntry = Partial<Omit<HistoryEntry, 'id' | 'at'>> &
  Pick<HistoryEntry, 'idea_id' | 'type' | 'summary'> & { id?: string; at?: string }

// --- Очередь обработки -------------------------------------------------------

/** Что именно делает задача очереди. */
export type QueueStage = 'classify' | 'extract' | 'embed' | 'ocr' | 'transcribe'

export type QueueStatus = 'pending' | 'done' | 'failed'

/**
 * Задача очереди обработки. `idea_id` не уникален: по одной идее может быть
 * несколько задач разных стадий, поэтому первичный ключ — собственный `id`.
 */
export interface QueueItem {
  id: string
  idea_id: string
  stage: QueueStage | string
  status: QueueStatus
  /** Сколько раз пытались выполнить. */
  attempts: number
  /** Когда задача снова готова к выполнению. */
  next_try_at: string
  last_error: string | null
  /** Сколько уже стоили попытки (прозрачность расходов). */
  cost: number
  created_at: string
  updated_at: string
}

/** Поля, которые принимает `QueueStore.enqueue`. */
export interface NewQueueItem {
  idea_id: string
  stage: QueueStage | string
  /** Когда браться за задачу; по умолчанию — сразу. */
  next_try_at?: string
  /** Наследованная стоимость, если задача переоформляется. */
  cost?: number
}

// --- Прочее ------------------------------------------------------------------

/** Запись в хранилище `events` — локальная аналитика (см. МЕТРИКИ.md). */
export interface AppEvent {
  id: string
  type: string
  payload: Record<string, unknown>
  ts: string
}

/** Запись в хранилище `meta`: настройки и служебные значения. */
export interface MetaRecord {
  key: string
  value: unknown
  updated_at: string
}

/** Вектор идеи: `Float32Array` кладётся в IndexedDB как есть. */
export interface IdeaVector {
  idea_id: string
  vector: Float32Array
  updated_at: string
}