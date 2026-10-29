/**
 * Как показать идею человеком, а не именем файла.
 *
 * Проблема, которую это решает: Instagram сохраняет ролики как
 * `d2c22f1839554659878d53511cc95316.mp4`, и весь список превращается
 * в список хешей. Человек не вспомнит, что было в `d2c22f18` — и разбор
 * из-за этого бессмысленен: решать нечего, когда не понимаешь, что это.
 *
 * Ключевая мысль: **имя файла — техническая подробность, а не название**.
 * Настоящее содержание у нас уже есть — это распознанный текст (расшифровка
 * речи, текст с картинки, описание) и слова самого человека. Их и надо
 * показывать первыми, а хеш — мелкой подписью внизу.
 *
 * Заголовок в базе при этом НЕ меняется: имя файла остаётся как есть, чтобы
 * ничего не терять и не путать выгрузку. Меняется только показ.
 */

import type { Idea, Material } from '../data'

/**
 * ⚠️ ПРАВИЛО ДЛЯ ЭТОГО ПРОЕКТА: в регулярках с русскими словами НЕЛЬЗЯ
 * использовать `\b`. В JavaScript граница слова считает словом только
 * латиницу, поэтому `/еда\b/` не находит «еда», а `/еда/` находит
 * «Р**еда**ктор». Русские слова сравниваем по основе (см. `select/logic.ts`)
 * либо ограничиваем явным `(?![\p{L}\p{N}])`.
 */

/** Похоже ли на имя файла, а не на название идеи. */
export function looksLikeFileName(value: string): boolean {
  const text = value.trim()
  if (text === '') return false
  // Хеш из букв и цифр с расширением: d2c22f18….mp4
  if (/^[0-9a-f]{12,}\.[a-z0-9]{2,5}$/i.test(text)) return true
  // Снимки и записи с телефона: IMG_3512.png, VID_20261029.mp4, PXL_2026….jpg
  if (/^(img|vid|pxl|dji|gopr|mvimg|screenshot)[-_ ]?\d/i.test(text)) return true
  // Просто файл с медиарасширением
  if (/\.(mp4|mov|webm|mkv|avi|m4a|mp3|ogg|wav|png|jpe?g|gif|webp|heic|pdf)$/i.test(text)) return true
  return false
}

/** Первая осмысленная строка текста: без титров, ссылок и мусора. */
export function firstMeaningfulLine(text: string, limit = 90): string {
  const lines = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line !== '')

  for (const line of lines) {
    // Титры, благодарности, призывы и реклама — не содержание.
    // ⚠️ Без `\b`: в JavaScript граница слова знает только латиницу, поэтому
    // `/субтитры\b/` не находит «Субтитры создавал» — «ы» для неё не буква.
    // На этих граблях уже стояли дважды, поэтому проверяем явно, что дальше
    // не идёт буква или цифра.
    if (/^(субтитры|редактор|корректор|перевод|озвуч|подписывайтесь|подпишись|ставьте лайк|реклама|источник|музыка|трек|song|music)(?![\p{L}\p{N}])/iu.test(line)) {
      continue
    }
    // Строка из одних ссылок или знаков — тоже не содержание.
    if (/^(https?:\/\/|\S+\.\S{2,4}\/?$)/.test(line)) continue
    // ЯРЛЫК, а не содержание: «Текст с картинки:», «Описание:», «Итог:».
    // Модель сама ставит такие подзаголовки, и брать их в название идеи
    // бессмысленно — человек увидит пустую формальность вместо смысла.
    if (line.length <= 42 && /:$/.test(line)) continue
    if (/^(текст с картинки|что на картинке|описание|итог|ответ|результат)\s*:?$/i.test(line)) {
      continue
    }
    if (line.replace(/[^\p{L}\p{N}]/gu, '').length < 8) continue
    return line.length > limit ? `${line.slice(0, limit)}…` : line
  }
  return ''
}

/** Весь распознанный текст идеи: материалы в порядке появления. */
export function recognizedText(materials: readonly Material[]): string {
  return materials
    .map((material) => (material.extracted_text ?? '').trim())
    .filter((text) => text !== '')
    .join('\n')
}

/** Свои слова человека обо всех материалах. */
export function ownWords(materials: readonly Material[]): string {
  return materials
    .map((material) => (material.comment ?? '').trim())
    .filter((text) => text !== '')
    .join('\n')
}

/**
 * Что показать как название идеи.
 *
 * Порядок такой: имя файла как название — это последнее, что стоит
 * показывать. Сначала пробуем то, что осмысленно:
 *   1. свои слова человека — он сам это написал, значит так и думает;
 *   2. распознанный текст (расшифровка, текст с картинки);
 *   3. настоящее название идеи, если оно не похоже на имя файла;
 *   4. и только потом само имя файла.
 */
export function meaningfulTitle(idea: Idea, materials: readonly Material[] = []): string {
  const title = idea.title.trim()

  // НАЗВАНИЕ, КОТОРОЕ ДАЛ ЧЕЛОВЕК, — ГЛАВНЕЕ ВСЕГО. Если оно не похоже
  // на имя файла, значит его поставил человек (или это первая строка
  // набранной идеи). Переименовал — значит так и надо показывать, даже
  // если распознанный текст длиннее и «умнее». Иначе переименование
  // не работало бы вовсе — что и случилось при первой проверке.
  if (title !== '' && !looksLikeFileName(title)) return title

  const own = firstMeaningfulLine(ownWords(materials))
  if (own !== '') return own

  const body = firstMeaningfulLine(idea.body)
  if (body !== '' && !looksLikeFileName(body)) return body

  const recognized = firstMeaningfulLine(recognizedText(materials))
  if (recognized !== '') return recognized

  if (body !== '') return body

  // Совсем ничего: честно говорим, что за запись, а не показываем хеш.
  if (materials.some((material) => material.kind === 'video')) return 'Видео без слов'
  if (materials.some((material) => material.kind === 'image')) return 'Картинка без текста'
  if (materials.length > 0) return 'Запись без слов'
  return title || 'Идея без названия'
}

/** Имя файла для мелкой подписи: показываем только если оно не совпало с названием. */
export function technicalName(idea: Idea, materials: readonly Material[] = []): string | null {
  const title = idea.title.trim()
  if (title === '') return null
  // Имя файла показываем подписью, только когда заголовок — не оно.
  if (looksLikeFileName(title)) return title
  const named = materials.find((material) => (material.title ?? '') !== '' && looksLikeFileName(material.title ?? ''))
  return named?.title ?? null
}

/** Похоже ли на то, что можно посмотреть: видео или картинка с файлом. */
export function canPreview(materials: readonly Material[]): boolean {
  return materials.some((material) => Boolean(material.blob) && (material.kind === 'video' || material.kind === 'image'))
}
