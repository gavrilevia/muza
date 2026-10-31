/**
 * Запись материалов идеи в IndexedDB.
 *
 * Вся работа с хранилищем `materials` идёт через `MaterialRepository`:
 * прямых `putMany('materials', …)` здесь больше нет, как и своей копии
 * правил записи. Захват только превращает заготовки в записи.
 *
 * Содержимое файла кладём в поле `blob` (тип `Material` его знает,
 * `normalizeMaterial` сохраняет настоящий Blob) — IndexedDB хранит Blob
 * как есть, и материал не теряется. Почему так, а не иначе, — в `types.ts`,
 * а как это переживает выгрузку — в `backup.ts`.
 */

import { materialRepository, normalizeMaterial } from '../data'
import { readExif } from './exif'
import { fetchLinkMeta, linkToText } from './links'
import { materialCanBeProcessed, materialKindFor, materialOriginFor } from './logic'
import type { CaptureChannel, CaptureMaterialDraft, StoredMaterial } from './types'

/**
 * Заготовка → запись материала.
 *
 * Имя файла пишем и в `file`, и в `title`: относительного пути у браузера нет,
 * а имя — единственное, что о файле известно наверняка.
 *
 * `extraction` у файлов — `pending`: захват сам ничего не читает и не
 * расшифровывает, он только помечает, что обработка нужна. Незнакомый
 * двоичный файл (архив, таблица) помечаем `skipped`, чтобы очередь не
 * крутила задачу, которую не умеет решить.
 */
export function materialFromDraft(
  ideaId: string,
  draft: CaptureMaterialDraft,
  channel: CaptureChannel,
): StoredMaterial {
  const origin = materialOriginFor(channel)

  if (draft.kind === 'link') {
    return normalizeMaterial({
      idea_id: ideaId,
      kind: 'link',
      origin,
      uri: draft.url,
      file: null,
      title: draft.title ?? draft.url,
      extracted_text: null,
      extraction: 'pending',
    })
  }

  if (draft.kind === 'text') {
    // Текст уже есть — искать по нему можно сразу.
    return normalizeMaterial({
      idea_id: ideaId,
      kind: 'text',
      origin,
      uri: null,
      file: null,
      title: draft.title ?? null,
      extracted_text: draft.text,
      extraction: 'done',
    })
  }

  const file = draft.file
  const material = normalizeMaterial({
    idea_id: ideaId,
    kind: materialKindFor(file),
    origin,
    uri: null,
    file: file.name,
    title: file.name,
    extracted_text: null,
    extraction: 'pending',
    size_bytes: file.size,
    duration_sec: draft.durationSec ?? null,
    blob: file.blob,
    mime: file.blob.type || null,
  })

  if (!materialCanBeProcessed(file)) material.extraction = 'skipped'
  return material
}

/**
 * Кладёт материалы одной транзакцией.
 *
 * Бросает наверх ошибку хранилища: вызывающий код решает, что важнее.
 * Идея к этому моменту уже сохранена, поэтому потеря материалов
 * не отменяет захват — текст и мысль остаются.
 */
export async function saveMaterials(
  ideaId: string,
  drafts: readonly CaptureMaterialDraft[],
  channel: CaptureChannel,
): Promise<StoredMaterial[]> {
  if (drafts.length === 0) return []
  const records = drafts.map((draft) => materialFromDraft(ideaId, draft, channel))

  // EXIF читаем здесь, а не в фоне: нужно всего 128 КБ с начала файла,
  // это мгновенно. Зато у идеи сразу правильная дата съёмки — и момент
  // можно поставить по ней, а не по дате загрузки.
  await Promise.all(
    records.map(async (material, index) => {
      const draft = drafts[index]
      // Черновик бывает трёх родов: файл, текст, ссылка. EXIF есть только у файла.
      if (!draft || draft.kind !== 'file') return
      const blob = draft.file.blob
      if (!blob || material.kind !== 'image') return
      const info = await readExif(blob)
      if (info.at) material.exif_at = info.at
      if (info.place) material.exif_place = info.place
    }),
  )

  // ССЫЛКА: пробуем узнать название через oEmbed.
  //
  // Прочитать саму страницу браузер не может — CORS. Но некоторые сервисы
  // сами отдают заголовок и автора, и это уже настоящий смысл: «Как жарить
  // курицу — рецепт» вместо адреса. Не получилось — идея всё равно
  // сохраняется: терять её из-за чужого сервиса нельзя.
  await Promise.all(
    records.map(async (material, index) => {
      const draft = drafts[index]
      if (!draft || draft.kind !== 'link') return
      const meta = await fetchLinkMeta(draft.url)
      const text = linkToText(meta)
      if (text !== '') {
        material.extracted_text = text
        material.extraction = 'done'
      }
      // Причину неудачи сохраняем рядом с адресом: человек должен знать,
      // что сервис закрыт или не ответил, а не гадать, почему пусто.
      material.title = draft.title ?? meta.title ?? draft.url
    }),
  )

  return materialRepository.createMany(records)
}
