/**
 * CaptureService — единственная точка, где идея рождается в базе.
 *
 * Порядок важнее деталей:
 *   1. сначала сохраняем саму идею (текст + `captured_via`) — это то, что
 *      человек уже набрал, и это нельзя потерять ни при каком сбое;
 *   2. только потом прикладываем материалы.
 * Поэтому сбой на шаге 2 даёт предупреждение, а не потерю захвата.
 *
 * Файлов в запросе несколько — идей тоже несколько: по одной на файл, чтобы
 * каждый Reels можно было разложить и найти отдельно. За это отвечает
 * `captureMany`, и сбой на одном файле не отменяет остальные.
 *
 * Здесь нет ни сети, ни ИИ, ни ожидания обработки: захват обязан быть
 * мгновенным и работать офлайн (АРХИТЕКТУРА-PWA.md, разделы 3.2 и 4).
 */

import { ideaRepository, materialRepository } from '../data'
import { capturedViaFor, pluralRu, suggestBody, suggestTitle } from './logic'
import { saveMaterials } from './materials'
import { captureVideoPoster, needsPoster } from '../video/poster'
import type { Material as StoredMaterial } from '../data'
import type {
  CaptureBatchOutcome,
  CaptureChannel,
  CaptureFile,
  CaptureMaterialDraft,
  CaptureOutcome,
  CaptureRequest,
} from './types'

/**
 * Заготовки материалов по запросу: файлы канала плюс ссылка, если ею
 * поделились. Порядок — как пришло: файлы, потом ссылка.
 */
export function draftsFor(request: CaptureRequest): CaptureMaterialDraft[] {
  const drafts: CaptureMaterialDraft[] = []
  const files: readonly CaptureFile[] = request.files ?? []
  for (const file of files) {
    drafts.push(
      request.channel === 'voice'
        ? { kind: 'file', file, durationSec: request.durationSec ?? null }
        : { kind: 'file', file },
    )
  }
  const url = (request.url ?? '').trim()
  if (url) drafts.push({ kind: 'link', url, title: request.sourceTitle ?? null })
  return drafts
}

/** Есть ли что сохранять: пустая идея без текста и без файлов не создаётся. */
export function isEmptyCapture(request: CaptureRequest): boolean {
  const text = (request.text ?? '').trim()
  const url = (request.url ?? '').trim()
  const files = request.files ?? []
  return !text && !url && files.length === 0
}

/**
 * Сохраняет идею и, если получится, её материалы.
 *
 * Бросает только тогда, когда идею сохранить не удалось. Материалы — отдельная
 * попытка: их сбой возвращается в `warning`, а идея остаётся в базе.
 */
export async function capture(request: CaptureRequest): Promise<CaptureOutcome> {
  const files = request.files ?? []
  const channel: CaptureChannel = request.channel
  if (isEmptyCapture(request)) {
    throw new Error('Сохранять нечего: ни текста, ни файлов.')
  }

  const idea = await ideaRepository.create({
    title: suggestTitle({
      channel,
      text: request.text,
      sourceTitle: request.sourceTitle,
      url: request.url,
      files,
      durationSec: request.durationSec,
    }),
    body: suggestBody({ channel, text: request.text, url: request.url }),
    captured_via: capturedViaFor(channel, files),
  })

  let materials: CaptureOutcome['materials'] = []
  let warning: string | null = null
  try {
    materials = await saveMaterials(idea.id, draftsFor(request), channel)
  } catch (e) {
    const reason = e instanceof Error ? e.message : 'неизвестная ошибка хранилища'
    warning = `Идея сохранена, а материалы приложить не удалось: ${reason}`
  }

  // Обложки видео — В ФОНЕ и уже после ответа: захват не должен ждать
  // декодирования кадров. Человек видит идею сразу, картинка появляется
  // следом. Медленный файл или формат, который браузер не читает, ничего
  // не ломает: обложки просто не будет.
  void warmPosters(materials)

  return { idea, materials, warning }
}

/**
 * Делает и сохраняет обложки для свежих видео.
 *
 * Никогда не бросает: обложка — украшение списка, ради неё нельзя терять
 * ни материал, ни идею. Сбой здесь не показываем человеку — ему нечего
 * с этим делать, а список и без картинки работает.
 */
async function warmPosters(materials: readonly StoredMaterial[]): Promise<void> {
  for (const material of materials) await makePoster(material)
}

/**
 * Досоздаёт обложки для видео, снятых ДО появления этой возможности.
 *
 * Без этого список у того, кто уже пользуется приложением, остался бы
 * списком хешей навсегда: обложки делались только при новом захвате.
 * Первый же прогон после обновления приводит старую библиотеку в порядок.
 *
 * Работа бесплатная и локальная (никакого ИИ и сети), идёт в фоне по одному
 * файлу и никого не ждёт. Уже готовые пропускаются сразу, поэтому повторные
 * запуски почти ничего не стоят.
 */
export async function backfillPosters(materials: readonly StoredMaterial[]): Promise<number> {
  let made = 0
  for (const material of materials) {
    if (!needsPoster(material)) continue
    if (await makePoster(material)) made += 1
  }
  return made
}

/**
 * Делает и сохраняет одну обложку. Возвращает `true`, если получилось.
 *
 * Никогда не бросает: обложка — украшение списка, ради неё нельзя терять
 * ни материал, ни идею. Сбой здесь не показываем человеку — ему нечего
 * с этим делать, а список и без картинки работает.
 */
async function makePoster(material: StoredMaterial): Promise<boolean> {
  try {
    const blob = material.blob
    if (!blob) return false
    const poster = await captureVideoPoster(blob)
    if (!poster) return false
    const updated = await materialRepository.update(material.id, { poster })
    // Обложка появляется ПОЗЖЕ: без этого уведомления список показал бы её
    // только после перезагрузки страницы, хотя в базе она уже есть.
    // Человек решил бы, что ничего не произошло.
    for (const listener of posterListeners) {
      try {
        listener(updated)
      } catch {
        /* подписчик не важнее обложки */
      }
    }
    return true
  } catch {
    return false
  }
}

/** Подписчики на готовую обложку: список обновляется без перезагрузки. */
const posterListeners = new Set<(material: StoredMaterial) => void>()

/**
 * Сообщать о готовых обложках.
 *
 * Возвращает функцию отписки — её нужно звать при размонтировании, иначе
 * подписчик останется держать состояние приложения.
 */
export function onPosterReady(listener: (material: StoredMaterial) => void): () => void {
  posterListeners.add(listener)
  return () => posterListeners.delete(listener)
}

// --- Один файл — одна идея --------------------------------------------------

/**
 * Разбивает запрос на «одна идея — один файл».
 *
 * Когда человек выбирает несколько файлов, каждый из них — отдельная мысль:
 * пятнадцать Reels нельзя разложить по направлениям, найти и выгрузить
 * по отдельности, если они лежат одной кучей в одной идее. Поэтому запрос
 * с несколькими файлами превращается в столько же запросов, сколько файлов.
 * Порядок сохраняется: первая заготовка — про первый файл.
 *
 * «Поделиться» из другого приложения не разбиваем: там файлы приходят одним
 * предметом, вместе с одним заголовком и одной ссылкой (для этого в схеме
 * есть `share_multiple`). Одиночный файл и запрос без файлов тоже остаются
 * как есть — это привычный путь.
 *
 * Текст человека и заголовок источника достаются первой заготовке: если её
 * сохранить не удалось, `captureMany` передаст их следующей. Молча терять
 * набранное нельзя ни при каком сбое.
 */
export function ideaRequestsFor(request: CaptureRequest): CaptureRequest[] {
  const files = request.files ?? []
  if (request.channel === 'share' || files.length <= 1) return [request]
  return files.map((file, index) => ({
    ...request,
    files: [file],
    text: index === 0 ? request.text : null,
    sourceTitle: index === 0 ? request.sourceTitle : null,
    url: index === 0 ? request.url : null,
  }))
}

/** Был ли в запросе текст, который человек набрал сам. */
function hasText(request: CaptureRequest): boolean {
  return Boolean((request.text ?? '').trim())
}

/**
 * Сохраняет запрос целиком.
 *
 * Файлов несколько — идей тоже несколько, по одной на файл. Сохраняем
 * по очереди и считаем неудачи: сбой на одном файле не отменяет остальные,
 * а человек узнаёт, сколько прошло. Если не прошёл ни один — бросаем ошибку,
 * как при одиночном захвате: текст останется в поле, причина будет видна.
 */
export async function captureMany(request: CaptureRequest): Promise<CaptureBatchOutcome> {
  const requests = ideaRequestsFor(request)

  if (requests.length === 1) {
    const outcome = await capture(request)
    return {
      outcomes: [outcome],
      failed: 0,
      warning: outcome.warning,
      textConsumed: hasText(request),
    }
  }

  const outcomes: CaptureOutcome[] = []
  let failed = 0
  let firstError: unknown = null
  /**
   * Текст и заголовок источника ждут первой удачной идеи: если первый файл
   * не сохранился, их подхватит следующий. Так набранное человеком не
   * пропадает из-за сбоя одного файла.
   */
  let pendingText = hasText(request) ? (request.text ?? null) : null
  let pendingSourceTitle = request.sourceTitle ?? null
  let pendingUrl = request.url ?? null

  for (const sub of requests) {
    try {
      const outcome = await capture({
        ...sub,
        text: pendingText ?? sub.text,
        sourceTitle: pendingSourceTitle ?? sub.sourceTitle,
        url: pendingUrl ?? sub.url,
      })
      outcomes.push(outcome)
      pendingText = null
      pendingSourceTitle = null
      pendingUrl = null
    } catch (e) {
      if (firstError === null) firstError = e
      failed += 1
    }
  }

  if (outcomes.length === 0) {
    throw firstError instanceof Error
      ? firstError
      : new Error('Не удалось сохранить ни один файл.')
  }

  return {
    outcomes,
    failed,
    warning: batchWarning(outcomes, failed),
    textConsumed: hasText(request) && pendingText === null,
  }
}

/**
 * Что сказать человеку, если прошло не всё.
 * Молчать нельзя: без этого часть файлов пропала бы незаметно.
 */
function batchWarning(outcomes: readonly CaptureOutcome[], failed: number): string | null {
  const notes: string[] = []

  if (failed > 0) {
    const saved = outcomes.length
    notes.push(`Сохранено ${saved} из ${saved + failed}: ${failedFilesPhrase(failed)}.`)
  }

  // Материалы могли не приложиться к части идей — например, кончилось место.
  // Об этом тоже нельзя молчать. Одна неудача говорит сама за себя, о
  // нескольких честнее сказать числом, чем повторять один и тот же текст.
  const broken = outcomes.flatMap((outcome) => (outcome.warning ? [outcome.warning] : []))
  if (broken.length === 1) {
    notes.push(broken[0])
  } else if (broken.length > 1) {
    notes.push(
      `Материалы приложились не ко всем идеям: у ${broken.length} из ${outcomes.length} не получилось.`,
    )
  }

  return notes.length > 0 ? notes.join(' ') : null
}

/** «один файл», «два файла»… — для одного без цифры, так человечнее. */
function failedFilesPhrase(count: number): string {
  if (count === 1) return 'один файл не удалось сохранить'
  return `${count} ${pluralRu(count, 'файл', 'файла', 'файлов')} не удалось сохранить`
}
