/**
 * Выход идеи: выгрузка файлом и архив с причиной.
 *
 * Это ядро продукта, а не украшение. Обещание с самого начала: идея уходит
 * только двумя путями — **выгрузка** или **осознанный архив с причиной**.
 * Метрика успеха ровно об этом: доля идей, дошедших до выгрузки или архива.
 *
 * Почему именно так (решения автора, РЕШЕНИЯ.md, вопрос 8):
 * - выгрузка — **файлом на телефон**: его человек контролирует сам, откроет
 *   без приложения и не потеряет, если приложение исчезнет;
 * - архив — **место возврата**, а не свалка: идея остаётся в поиске и может
 *   вернуться;
 * - причина архива обязательна: без неё это не «осознанный архив», а просто
 *   захламление.
 *
 * ⚠️ **Текст расшифровок, OCR и описаний картинок обязан попасть в выгрузку.**
 * Иначе человек получит файлы без того, что мы распознали, — и потеряет
 * половину ценности идеи. Поэтому `extracted_text` каждого материала едет
 * в `.md` рядом с описанием этого материала.
 */

import { strToU8, zip } from 'fflate'
import type { AsyncZippable } from 'fflate'
import { ideaRepository } from './IdeaRepository'
import { materialRepository } from './MaterialRepository'
import { directionStore } from './DirectionStore'
import { historyStore } from './HistoryStore'
import type { Idea, Material } from './types'

/**
 * Готовые причины архива.
 *
 * Снимают трение: один тап вместо набора текста. Своя причина рядом —
 * чтобы человека не загоняло в три чужие формулировки.
 */
export const ARCHIVE_REASONS = ['устарело', 'сделано', 'передумал'] as const

/** Код направления «в архив» и обратно. */
export const ARCHIVE_STATUS = 'archived' as const
export const RETURN_STATUS = 'inbox' as const

/** Готовый файл выгрузки: байты и имя, под которым его сохранить. */
export interface IdeaExport {
  bytes: Uint8Array<ArrayBuffer>
  fileName: string
}

/**
 * Чистит имя для файловой системы, сохраняя кириллицу.
 *
 * Запрещённые символы заменяем на дефис, повторные дефисы схлопываем:
 * имя должно открываться и в Windows, и на телефоне. Кириллицу **не
 * трогаем** — она и есть смысл: человек ищет файл глазами.
 */
export function safeFileName(value: string, fallback: string): string {
  const cleaned = (value ?? '')
    // Управляющие символы и запрещённые в именах: / \ : * ? " < > |
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.\s]+|[-.\s]+$/g, '')
    .slice(0, 80)
    .trim()
  return cleaned === '' ? fallback : cleaned
}

/** Расширение по типу содержимого: без него файл не откроется двойным тапом. */
export function extensionFor(mime: string | null | undefined, kind: string): string {
  const map: Record<string, string> = {
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/webm': 'webm',
    'audio/ogg': 'ogg',
    'audio/wav': 'wav',
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'application/pdf': 'pdf',
  }
  const byMime = mime ? map[mime.toLowerCase()] : undefined
  if (byMime) return byMime
  // Неизвестный тип — даём хотя бы понятное расширение по роду материала.
  if (kind === 'video') return 'mp4'
  if (kind === 'audio' || kind === 'voice') return 'm4a'
  if (kind === 'image') return 'jpg'
  return 'bin'
}

/** Человеческое имя рода материала для `.md`. */
function kindLabel(kind: string): string {
  const map: Record<string, string> = {
    video: 'видео',
    audio: 'голосовая заметка',
    voice: 'голосовая заметка',
    image: 'картинка',
    pdf: 'документ',
    text: 'текст',
    link: 'ссылка',
    quote: 'цитата',
  }
  return map[kind] ?? kind
}

/** Дата в виде «26 октября 2026, 21:14» — человеку, а не машине. */
function humanDate(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  try {
    return new Intl.DateTimeFormat('ru-RU', { dateStyle: 'long', timeStyle: 'short' }).format(date)
  } catch {
    return date.toISOString()
  }
}

/**
 * Собирает `.md` идеи: то, что человек прочитает через год без приложения.
 *
 * Заголовок и текст идут первыми, распознанный текст — рядом с каждым
 * материалом, чтобы было понятно, к чему он относится.
 */
export function buildIdeaMarkdown(
  idea: Idea,
  materials: readonly Material[],
  directionName: string | null,
): string {
  const lines: string[] = []
  lines.push(`# ${idea.title.trim() || 'Идея без названия'}`)
  lines.push('')
  if (idea.body.trim() !== '') {
    lines.push(idea.body.trim())
    lines.push('')
  }

  lines.push('---')
  lines.push('')
  lines.push('## Сведения')
  lines.push('')
  lines.push(`- Когда пришла: ${humanDate(idea.captured_at)}`)
  lines.push(`- Направление: ${directionName ?? 'не разобрано'}`)
  lines.push(`- Момент: ${idea.moment_at ? humanDate(idea.moment_at) : 'не задан'}`)
  if (idea.archived_reason) lines.push(`- В архиве, причина: ${idea.archived_reason}`)
  lines.push(`- Состояние: ${idea.status}`)
  lines.push(`- Идентификатор: ${idea.id}`)
  lines.push('')

  if (materials.length === 0) {
    lines.push('## Материалы')
    lines.push('')
    lines.push('Материалов нет — идея состоит только из текста.')
    lines.push('')
    return lines.join('\n')
  }

  lines.push(`## Материалы (${materials.length})`)
  lines.push('')
  materials.forEach((material, index) => {
    const name = safeFileName(material.title ?? '', `материал-${index + 1}`)
    const ext = extensionFor(material.mime, material.kind)
    lines.push(`### ${index + 1}. ${name}.${ext} (${kindLabel(material.kind)})`)
    lines.push('')
    const comment = (material.comment ?? '').trim()
    if (comment !== '') {
      lines.push(`**Свои слова:** ${comment}`)
      lines.push('')
    }
    const text = (material.extracted_text ?? '').trim()
    if (text !== '') {
      // Распознанное — самое ценное в выгрузке: без него останутся только
      // нечитаемые файлы. Поэтому оно здесь, а не «где-то в базе».
      lines.push(text)
    } else if (material.blob) {
      lines.push('_Текст не распознан. Файл лежит рядом, в папке `материалы`._')
    } else {
      lines.push('_Файл не сохранился: в базе осталась только запись о нём._')
    }
    lines.push('')
  })

  return lines.join('\n')
}

/**
 * Собирает zip одной идеи: `.md` плюс оригиналы материалов.
 *
 * Байты кладём без сжатия (`level: 0`): фото, видео и голос уже сжаты,
 * а повторный deflate только тратит время на телефоне. Текст `.md` жмём.
 */
export async function buildIdeaExport(id: string): Promise<IdeaExport | null> {
  const idea = await ideaRepository.get(id)
  if (!idea) return null

  const materials = await materialRepository.listByIdea(id)
  const direction = idea.direction_id ? await directionStore.get(idea.direction_id) : null

  const baseName = safeFileName(
    idea.title,
    `идея-${(idea.captured_at || idea.created_at).slice(0, 10)}`,
  )

  const entries: AsyncZippable = {
    [`${baseName}.md`]: strToU8(buildIdeaMarkdown(idea, materials, direction?.name ?? null)),
  }

  // Обычный цикл, а не forEach: внутри нужен `await` на чтение байтов.
  for (let index = 0; index < materials.length; index += 1) {
    const material = materials[index]!
    const blob = material.blob
    if (!blob) continue
    const name = safeFileName(material.title ?? '', `материал-${index + 1}`)
    const ext = extensionFor(material.mime, material.kind)
    entries[`материалы/${String(index + 1).padStart(2, '0')}-${name}.${ext}`] = [
      new Uint8Array(await blob.arrayBuffer()),
      { level: 0 },
    ]
  }

  const bytes = await new Promise<Uint8Array>((resolve, reject) => {
    zip(entries, { level: 6 }, (error, data) => {
      if (error) reject(error)
      else resolve(data)
    })
  })

  // Копируем в обычный ArrayBuffer: тип нужен для Blob без лишних приведений.
  const copy = new Uint8Array(bytes.length)
  copy.set(bytes)
  return { bytes: copy as Uint8Array<ArrayBuffer>, fileName: `${baseName}.zip` }
}

/**
 * Скачивает файл на телефон.
 *
 * Приём тот же, что у общей копии: ссылка освобождается не сразу, иначе
 * Safari не успевает прочитать blob после клика.
 */
export function downloadIdeaExport(file: IdeaExport): void {
  const blob = new Blob([file.bytes], { type: 'application/zip' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = file.fileName
  link.rel = 'noopener'
  link.style.display = 'none'
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** Выгрузка + запись в историю: факт выхода идеи должен быть виден. */
export async function exportIdea(id: string): Promise<IdeaExport | null> {
  const file = await buildIdeaExport(id)
  if (!file) return null
  await historyStore.append({
    idea_id: id,
    type: 'export',
    actor: 'user',
    summary: 'Идея выгружена файлом',
    ref: file.fileName,
  })
  return file
}

/**
 * Убирает идею в архив — с причиной.
 *
 * Пустая причина недопустима: тогда это не «осознанный архив», а свалка.
 * Ошибку лучше показать, чем тихо записать идею в никуда.
 */
export async function archiveIdea(id: string, reason: string): Promise<Idea> {
  const clean = (reason ?? '').trim()
  if (clean === '') {
    throw new Error('Нужна причина: без неё архив превращается в свалку.')
  }
  const idea = await ideaRepository.update(id, {
    status: ARCHIVE_STATUS,
    archived_reason: clean,
  })
  await historyStore.append({
    idea_id: id,
    type: 'archive',
    actor: 'user',
    summary: `Идея в архиве: ${clean}`,
    meta: { reason: clean },
  })
  return idea
}

/** Возвращает идею из архива. Причина очищается: она относилась к уходу. */
export async function restoreIdea(id: string): Promise<Idea> {
  const idea = await ideaRepository.update(id, {
    status: RETURN_STATUS,
    archived_reason: null,
  })
  await historyStore.append({
    idea_id: id,
    type: 'return',
    actor: 'user',
    summary: 'Идея вернулась из архива',
  })
  return idea
}
