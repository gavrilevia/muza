/**
 * MaterialRepository — CRUD материалов в IndexedDB.
 *
 * Материал — это файл, ссылка или текст, приложенный к идее. Байты файла
 * лежат в поле `blob` той же записи (см. types.ts): отдельного хранилища
 * для содержимого в схеме нет, а IndexedDB кладёт Blob как есть.
 *
 * Все методы асинхронные. Операции идемпотентны там, где это имеет смысл:
 * `create` с готовым id перезаписывает ту же запись, `remove` для уже
 * удалённого материала ничего не портит, `createMany` с теми же id
 * не создаёт дубликатов (ключ — id).
 *
 * Список по идее читается по индексу `by_idea`; остальные отборы, которым
 * индекса не хватает, идут одним проходом по хранилищу.
 */

import { StorageError, countAll, iterateStore, req, withTx } from './db'
import { normalizeMaterial } from './records'
import type { Material } from './types'

/** Поля, которые принимает `create`: id можно задать, остальное — по умолчанию. */
export type NewMaterial = Partial<Omit<Material, 'id'>> & { id?: string }

/**
 * Поля, которые можно менять через `update`: `id` неизменен.
 * `blob: null` явно стирает содержимое файла, `undefined` — «не трогать».
 */
export type MaterialPatch = Partial<Omit<Material, 'id' | 'blob'>> & { blob?: Blob | null }

/** Порядок записей при равных датах должен быть устойчивым. */
function compareAdded(a: Material, b: Material): number {
  if (a.added_at === b.added_at) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  return a.added_at < b.added_at ? -1 : 1
}

export class MaterialRepository {
  /**
   * Создаёт материал. Все поля, кроме `id`, необязательны и получают
   * значения по умолчанию; мусорные значения отбрасываются нормализацией.
   * Если передать существующий `id`, запись перезаписывается (идемпотентно).
   */
  async create(input: NewMaterial = {}): Promise<Material> {
    const material = normalizeMaterial(input)
    await withTx('materials', 'readwrite', (tx) => {
      tx.objectStore('materials').put(material)
    })
    return material
  }

  /**
   * Создаёт пачку материалов одной транзакцией: так быстрее, а захват
   * прикладывает к идее сразу несколько файлов.
   */
  async createMany(inputs: readonly NewMaterial[]): Promise<Material[]> {
    const materials = inputs.map((input) => normalizeMaterial(input))
    if (materials.length === 0) return []
    await withTx('materials', 'readwrite', (tx) => {
      const store = tx.objectStore('materials')
      for (const material of materials) store.put(material)
    })
    return materials
  }

  /** Возвращает материал по id или null. */
  async get(id: string): Promise<Material | null> {
    const material = await withTx('materials', 'readonly', (tx) =>
      req<Material | undefined>(tx.objectStore('materials').get(id)),
    )
    return material ?? null
  }

  /** Материалы идеи в порядке появления: сначала приложенные раньше. */
  async listByIdea(ideaId: string): Promise<Material[]> {
    const materials = await withTx('materials', 'readonly', (tx) =>
      req<Material[]>(tx.objectStore('materials').index('by_idea').getAll(IDBKeyRange.only(ideaId))),
    )
    return [...materials].sort(compareAdded)
  }

  /**
   * Меняет материал: читает текущую запись, накладывает патч, пишет обратно —
   * всё в одной транзакции. `id` изменить нельзя, он берётся из текущей записи.
   */
  async update(id: string, patch: MaterialPatch): Promise<Material> {
    const next = await withTx('materials', 'readwrite', async (tx) => {
      const store = tx.objectStore('materials')
      const current = await req<Material | undefined>(store.get(id))
      if (!current) throw new StorageError(`Материал ${id} не найден — обновлять нечего.`)

      const updated: Material = { ...current }
      if (patch.idea_id !== undefined) updated.idea_id = patch.idea_id
      if (patch.kind !== undefined) updated.kind = patch.kind
      if (patch.origin !== undefined) updated.origin = patch.origin
      if (patch.uri !== undefined) updated.uri = patch.uri
      if (patch.file !== undefined) updated.file = patch.file
      if (patch.title !== undefined) updated.title = patch.title
      // Свои слова человека: `null` — осознанное «стереть», `undefined` — «не трогать».
      if (patch.comment !== undefined) updated.comment = patch.comment
      if (patch.exif_at !== undefined) updated.exif_at = patch.exif_at
      if (patch.exif_place !== undefined) updated.exif_place = patch.exif_place
      if (patch.extracted_text !== undefined) updated.extracted_text = patch.extracted_text
      if (patch.extraction !== undefined) updated.extraction = patch.extraction
      if (patch.added_at !== undefined) updated.added_at = patch.added_at
      // Необязательные поля видео: `null` — осознанное «пусто», `undefined` — «не трогать».
      if (patch.duration_sec !== undefined) updated.duration_sec = patch.duration_sec
      if (patch.size_bytes !== undefined) updated.size_bytes = patch.size_bytes
      if (patch.poster !== undefined) updated.poster = patch.poster
      if (patch.frames !== undefined) updated.frames = patch.frames
      if (patch.transcript !== undefined) updated.transcript = patch.transcript
      if (patch.ocr_text !== undefined) updated.ocr_text = patch.ocr_text
      if (patch.compressed_at !== undefined) updated.compressed_at = patch.compressed_at
      if (patch.moved_to_blobs !== undefined) updated.moved_to_blobs = patch.moved_to_blobs
      if (patch.blob !== undefined) {
        if (patch.blob) updated.blob = patch.blob
        else delete updated.blob
      }

      store.put(updated)
      return updated
    })
    return next
  }

  /**
   * Удаляет материал по-настоящему: у материала нет статуса, «мягко»
   * удалять нечего. Повторный вызов ничего не портит.
   */
  async remove(id: string): Promise<void> {
    await withTx('materials', 'readwrite', (tx) => {
      tx.objectStore('materials').delete(id)
    })
  }

  /** Сколько всего материалов в хранилище. */
  async count(): Promise<number> {
    return countAll('materials')
  }

  /**
   * Материалы, у которых нет содержимого (`blob`): ссылки и тексты такие
   * и должны быть, а файл без `blob` — признак потерянного файла или
   * импорта старого JSON, где содержимого не было вовсе.
   *
   * Идём курсором, а не `getAll`: так в памяти оказывается одна запись,
   * а не все файлы идеи разом.
   */
  /**
   * Все материалы как есть: нужны, чтобы посчитать занятую память.
   *
   * `listWithoutBlob` для этого не годится — он отдаёт материалы БЕЗ файла,
   * то есть ровно те, что ничего не занимают.
   */
  async listAll(): Promise<Material[]> {
    const found: Material[] = []
    await withTx('materials', 'readonly', (tx) =>
      iterateStore<Material>(tx, 'materials', (material) => {
        found.push(material)
      }),
    )
    return found.sort(compareAdded)
  }

  async listWithoutBlob(): Promise<Material[]> {
    const found: Material[] = []
    await withTx('materials', 'readonly', (tx) =>
      iterateStore<Material>(tx, 'materials', (material) => {
        if (!material.blob) found.push(material)
      }),
    )
    return found.sort(compareAdded)
  }
}

/** Готовый экземпляр для приложения. */
export const materialRepository = new MaterialRepository()
