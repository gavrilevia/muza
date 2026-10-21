/**
 * Чистые преобразования записей: нормализация, проверка значений, слияние.
 *
 * Здесь нет ни IndexedDB, ни DOM — только данные. Это сделано намеренно:
 * такие функции можно проверять в Node отдельным скриптом (см. tools/),
 * а браузерная часть остаётся тонкой.
 *
 * Главные правила:
 *   - Нормализация приводит любую запись (из формы, из импортируемого файла,
 *     из старой базы) к одной полной форме: все поля есть, значения допустимые.
 *   - Слияние идёт ПО ID и идемпотентно: повторное применение того же набора
 *     не меняет результат.
 *   - Журнал истории — объединение по id: существующая запись не перетирается.
 */

import { ulid } from './ulid'
import type {
  Actor,
  CapturedVia,
  Direction,
  HistoryEntry,
  Idea,
  IdeaKind,
  IdeaProps,
  IdeaStatus,
  Material,
  MetaRecord,
  MomentRule,
} from './types'

/** Допустимые статусы идеи. */
export const IDEA_STATUSES: readonly IdeaStatus[] = [
  'inbox',
  'incubating',
  'dormant',
  'frozen',
  'archived',
  'exported',
  'deleted',
]

/** Допустимые типы идей. */
export const IDEA_KINDS: readonly IdeaKind[] = [
  'recipe',
  'purchase',
  'place',
  'gift',
  'read',
  'do',
  'note',
]

/** Допустимые правила момента. */
export const MOMENT_RULES: readonly MomentRule[] = ['date', 'season', 'event', 'price', 'manual']

/** Допустимые пути захвата. */
export const CAPTURED_VIA: readonly CapturedVia[] = [
  'share_sheet',
  'share_multiple',
  'files_save',
  'voice',
  'video_record',
  'widget',
  'quick_tile',
  'clipboard',
  'camera',
  'gallery_import',
  // «Набрано вручную»: путь не привязан к устройству — продукт начинается
  // с телефона, и доля захватов без открытия приложения не должна путать
  // телефон с десктопом.
  'typed',
  // Оставлены для будущего десктопного приложения, сейчас не используются.
  'desktop_text',
  'desktop_file',
]

/** Допустимые типы развилок. */
export const HISTORY_TYPES: readonly HistoryEntry['type'][] = [
  'origin',
  'development',
  'link',
  'reformulation',
  'doubt',
  'freeze',
  'archive',
  'export',
  'return',
  'materials',
]

/** Кто автор изменения. */
export const ACTORS: readonly Actor[] = ['user', 'ai', 'system']

/** Текущее время строкой ISO-8601 в UTC. */
export function nowIso(): string {
  return new Date().toISOString()
}

/** Приводит значение к ISO-8601 в UTC; при неудаче возвращает запасное значение. */
export function toIso(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.trim()) {
    const parsed = new Date(value)
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString()
    return fallback
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const parsed = new Date(value)
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString()
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString()
  return fallback
}

/** ISO-8601 или null. */
export function toIsoOrNull(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  const iso = toIso(value, '')
  return iso === '' ? null : iso
}

/** Строка для текстового поля (никогда не undefined). */
function toText(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

/** Непустая строка или null. */
function toTextOrNull(value: unknown): string | null {
  const text = toText(value).trim()
  return text === '' ? null : text
}

/** Значение из списка допустимых или запасное. */
function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback
}

/** Значение из списка допустимых или null. */
function pickEnumOrNull<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null
}

/** Свойства идеи: только простой объект, не массив и не null. */
function toProps(value: unknown): IdeaProps {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return JSON.parse(JSON.stringify(value)) as IdeaProps
  }
  return {}
}

/** Объект meta: только простой объект. */
function toMeta(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>
  }
  return {}
}

/** Целое неотрицательное число или null. */
function toIntOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  return null
}

/**
 * Приводит запись идеи к полной форме.
 * Отсутствующие поля получают значения по умолчанию, мусор — отбрасывается.
 */
export function normalizeIdea(raw: Partial<Idea> | null | undefined): Idea {
  const source = (raw ?? {}) as Record<string, unknown>
  const capturedAt = toIso(source.captured_at, nowIso())
  const createdAt = toIso(source.created_at, capturedAt)

  return {
    id: typeof source.id === 'string' && source.id ? source.id : ulid(),
    title: toText(source.title),
    body: toText(source.body),
    status: pickEnum(source.status, IDEA_STATUSES, 'inbox'),
    captured_at: capturedAt,
    captured_via: pickEnum(source.captured_via, CAPTURED_VIA, 'typed'),
    sleep_at: toIsoOrNull(source.sleep_at),
    archived_reason: toTextOrNull(source.archived_reason),
    ai_opt_out: source.ai_opt_out === true,
    root_of: toTextOrNull(source.root_of),
    worked_on: source.worked_on === true,
    direction_id: toTextOrNull(source.direction_id),
    kind: pickEnumOrNull(source.kind, IDEA_KINDS),
    props: toProps(source.props),
    moment_at: toIsoOrNull(source.moment_at),
    moment_rule: pickEnumOrNull(source.moment_rule, MOMENT_RULES),
    created_at: createdAt,
    last_activity_at: toIso(source.last_activity_at, createdAt),
  }
}

/** Приводит запись направления к полной форме. */
export function normalizeDirection(
  raw: Partial<Direction> | null | undefined,
  fallbackOrder = 0,
): Direction {
  const source = (raw ?? {}) as Record<string, unknown>
  return {
    id: typeof source.id === 'string' && source.id ? source.id : ulid(),
    name: toText(source.name).trim(),
    icon: toTextOrNull(source.icon),
    review_hint: toTextOrNull(source.review_hint),
    order:
      typeof source.order === 'number' && Number.isFinite(source.order)
        ? Math.trunc(source.order)
        : fallbackOrder,
    window_days: toIntOrNull(source.window_days),
    created_at: toIso(source.created_at, nowIso()),
    last_reviewed_at: toIsoOrNull(source.last_reviewed_at),
  }
}

/** Приводит запись журнала к полной форме. */
export function normalizeHistoryEntry(
  raw: Partial<HistoryEntry> | null | undefined,
): HistoryEntry {
  const source = (raw ?? {}) as Record<string, unknown>
  return {
    id: typeof source.id === 'string' && source.id ? source.id : ulid(),
    idea_id: toText(source.idea_id),
    type: pickEnum(source.type, HISTORY_TYPES, 'development'),
    at: toIso(source.at, nowIso()),
    actor: pickEnum(source.actor, ACTORS, 'user'),
    summary: toText(source.summary),
    ai_reason: toTextOrNull(source.ai_reason),
    ref: toTextOrNull(source.ref),
    meta: toMeta(source.meta),
  }
}

/** Приводит запись меты к полной форме. */
export function normalizeMetaRecord(raw: Partial<MetaRecord> | null | undefined): MetaRecord {
  const source = (raw ?? {}) as Record<string, unknown>
  return {
    key: toText(source.key),
    value: source.value ?? null,
    updated_at: toIso(source.updated_at, nowIso()),
  }
}

/**
 * Blob ли это. Проверяем именно `instanceof`: строку, объект-заглушку
 * (например, `{}` — след от `JSON.stringify` над Blob) и `null` надо
 * отбросить, иначе в базу попадёт мусор вместо файла.
 * Конструктора `Blob` может не быть в окружении (старый Node) — не падаем.
 */
function asBlob(value: unknown): Blob | undefined {
  if (typeof Blob === 'undefined') return undefined
  return value instanceof Blob ? value : undefined
}

/**
 * Приводит материал к полной форме.
 * Нужен для импорта: материалы ездят в резервной копии вместе с идеями.
 */
export function normalizeMaterial(raw: Partial<Material> | null | undefined): Material {
  const source = (raw ?? {}) as Record<string, unknown>
  const material: Material = {
    id: typeof source.id === 'string' && source.id ? source.id : ulid(),
    idea_id: toText(source.idea_id),
    kind: pickEnum(
      source.kind,
      ['link', 'pdf', 'image', 'video', 'audio', 'text', 'quote'] as const,
      'text',
    ),
    origin: pickEnum(source.origin, ['user', 'shared', 'imported'] as const, 'user'),
    uri: toTextOrNull(source.uri),
    file: toTextOrNull(source.file),
    title: toTextOrNull(source.title),
    extracted_text: toTextOrNull(source.extracted_text),
    extraction: pickEnum(
      source.extraction,
      ['pending', 'done', 'failed', 'skipped'] as const,
      'pending',
    ),
    added_at: toIso(source.added_at, nowIso()),
  }
  if ('duration_sec' in source) material.duration_sec = toIntOrNull(source.duration_sec)
  if ('size_bytes' in source) material.size_bytes = toIntOrNull(source.size_bytes)
  if ('poster' in source) material.poster = toTextOrNull(source.poster)
  if (Array.isArray(source.frames)) material.frames = source.frames.map((f) => toText(f))
  if ('transcript' in source) material.transcript = toTextOrNull(source.transcript)
  if ('ocr_text' in source) material.ocr_text = toTextOrNull(source.ocr_text)
  if ('compressed_at' in source) material.compressed_at = toIsoOrNull(source.compressed_at)
  if ('moved_to_blobs' in source) material.moved_to_blobs = source.moved_to_blobs === true
  // Содержимое файла: только настоящий Blob, всё остальное отбрасываем.
  const blob = asBlob(source.blob)
  if (blob) material.blob = blob
  // Тип содержимого нужен после импорта: в zip едут только байты.
  // Поэтому если явного `mime` нет — берём его у самого файла.
  if ('mime' in source) material.mime = toTextOrNull(source.mime)
  if (!material.mime && material.blob?.type) material.mime = material.blob.type
  return material
}

/** Глубокое сравнение значений: порядок ключей не важен, массивы и типизированные массивы — важны. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null || typeof a !== 'object') return false

  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
    if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b)) return false
    const left = a as unknown as { length: number; [i: number]: number }
    const right = b as unknown as { length: number; [i: number]: number }
    if (left.length !== right.length) return false
    for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return false
    return true
  }

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false
    return true
  }

  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  for (const key of leftKeys) {
    if (!Object.prototype.hasOwnProperty.call(right, key)) return false
    if (!deepEqual(left[key], right[key])) return false
  }
  return true
}

/** Итог слияния: что получилось и что именно произошло. */
export interface MergeOutcome<T> {
  /** Итоговый набор (порядок: сперва существующие, затем новые). */
  items: T[]
  /** Сколько записей добавилось. */
  added: number
  /** Сколько существующих записей заменено входящей версией. */
  updated: number
  /** Сколько записей совпало полностью (повторный импорт того же файла). */
  unchanged: number
  /** Сколько входящих версий отклонено в пользу местной (она новее). */
  kept: number
}

/**
 * Слияние двух наборов по ключу, который достаёт `keyOf`.
 *
 * `preferIncoming(местная, входящая)` решает, чья версия записи остаётся при
 * совпадении ключа. Если наборы идентичны, результат равен исходному, а все
 * записи попадают в `unchanged` — это и есть идемпотентность.
 */
export function mergeByKey<T>(
  current: readonly T[],
  incoming: readonly T[],
  keyOf: (item: T) => string,
  preferIncoming: (local: T, incoming: T) => boolean,
): MergeOutcome<T> {
  const items = [...current]
  const positions = new Map<string, number>()
  for (let i = 0; i < items.length; i++) positions.set(keyOf(items[i]), i)

  let added = 0
  let updated = 0
  let unchanged = 0
  let kept = 0

  for (const candidate of incoming) {
    const key = keyOf(candidate)
    const at = positions.get(key)
    if (at === undefined) {
      positions.set(key, items.length)
      items.push(candidate)
      added++
      continue
    }
    const local = items[at]
    if (deepEqual(local, candidate)) {
      unchanged++
      continue
    }
    if (preferIncoming(local, candidate)) {
      items[at] = candidate
      updated++
    } else {
      kept++
    }
  }

  return { items, added, updated, unchanged, kept }
}

/** Слияние двух наборов сущностей по `id`. */
export function mergeById<T extends { id: string }>(
  current: readonly T[],
  incoming: readonly T[],
  preferIncoming: (local: T, incoming: T) => boolean,
): MergeOutcome<T> {
  return mergeByKey(current, incoming, (item) => item.id, preferIncoming)
}

/**
 * Чья версия идеи остаётся при совпадении id.
 * Правило: у кого позже `last_activity_at`, тот и прав. При равенстве берём
 * входящую — тогда повторный импорт того же файла не меняет данные.
 */
export function preferIncomingIdea(local: Idea, incoming: Idea): boolean {
  if (incoming.last_activity_at > local.last_activity_at) return true
  if (incoming.last_activity_at < local.last_activity_at) return false
  return true
}

/** Чья версия направления остаётся: свежее по «последнему просмотру». */
export function preferIncomingDirection(local: Direction, incoming: Direction): boolean {
  const localAt = local.last_reviewed_at ?? local.created_at
  const incomingAt = incoming.last_reviewed_at ?? incoming.created_at
  if (incomingAt > localAt) return true
  if (incomingAt < localAt) return false
  return true
}

/** Слияние идей по id. */
export function mergeIdeas(current: readonly Idea[], incoming: readonly Idea[]): MergeOutcome<Idea> {
  return mergeById(current, incoming, preferIncomingIdea)
}

/** Слияние направлений по id. */
export function mergeDirections(
  current: readonly Direction[],
  incoming: readonly Direction[],
): MergeOutcome<Direction> {
  return mergeById(current, incoming, preferIncomingDirection)
}

/**
 * Чья версия материала остаётся при совпадении id.
 *
 * Правило простое и щадящее:
 *   - входящий файл заполняет пустое место (материал был без содержимого);
 *   - уже лежащий файл не перетирается: повторный импорт архива не должен
 *     заново писать 240 МБ, а метаданные материала при слиянии не важнее файла.
 */
export function preferIncomingMaterial(local: Material, incoming: Material): boolean {
  return !!incoming.blob && !local.blob
}

/** Слияние материалов по id. */
export function mergeMaterials(
  current: readonly Material[],
  incoming: readonly Material[],
): MergeOutcome<Material> {
  return mergeById(current, incoming, preferIncomingMaterial)
}

/**
 * Слияние журналов истории: объединение по id.
 *
 * Существующая запись никогда не перетирается — журнал append-only.
 * Совпадение id при разном содержимом невозможно по построению (id = ULID),
 * но если файл собран вручную, побеждает уже лежащая запись.
 */
export function mergeHistory(
  current: readonly HistoryEntry[],
  incoming: readonly HistoryEntry[],
): MergeOutcome<HistoryEntry> {
  return mergeById(current, incoming, () => false)
}

/** Слияние произвольного числа журналов: union по id. */
export function unionHistory(...journals: readonly HistoryEntry[][]): HistoryEntry[] {
  let items: HistoryEntry[] = []
  for (const journal of journals) items = mergeHistory(items, journal).items
  return items
}

/** Настройки: существующие ключи не перетираем, недостающие — добавляем. */
export function mergeMeta(
  current: readonly MetaRecord[],
  incoming: readonly MetaRecord[],
): MergeOutcome<MetaRecord> {
  return mergeByKey(current, incoming, (record) => record.key, () => false)
}

/** Убирает повторяющиеся id внутри одного набора (защита от битого файла). */
export function dedupeById<T extends { id: string }>(
  items: readonly T[],
): { items: T[]; duplicates: number } {
  const seen = new Map<string, T>()
  let duplicates = 0
  for (const item of items) {
    if (seen.has(item.id)) duplicates++
    else seen.set(item.id, item)
  }
  return { items: [...seen.values()], duplicates }
}

/** Журнал по времени: сначала старые. При равном времени — устойчиво по id. */
export function sortHistory(entries: readonly HistoryEntry[]): HistoryEntry[] {
  return [...entries].sort((a, b) => (a.at === b.at ? (a.id < b.id ? -1 : 1) : a.at < b.at ? -1 : 1))
}