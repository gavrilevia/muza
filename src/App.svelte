<script lang="ts">
  /**
   * Каркас «Музы» — этап 0.
   *
   * Источник данных — IndexedDB через IdeaRepository (задача 1).
   * Временная заглушка на localStorage удалена: идеи читаются из базы
   * и переживают перезагрузку страницы.
   *
   * Захват (задача 3): «+» остаётся главным путём, а рядом живут каналы —
   * файл, камера, микрофон, буфер обмена и «Поделиться» из другого
   * приложения. Каналы ничего не решают про данные: они отдают запрос
   * в `captureMany`, а тот сначала сохраняет идеи и только потом материалы.
   * Файлов несколько — идей столько же, по одной на файл.
   */

  import { onMount } from 'svelte'
  import { directionStore, historyStore, ideaRepository, materialRepository } from './data'
  import type { Idea, Material } from './data'
  import {
    ARCHIVE_REASONS,
    appendIdeaNote,
    archiveIdea,
    downloadIdeaExport,
    editIdeaText,
    exportIdea,
    restoreIdea,
  } from './data'
  import {
    CaptureChannels,
    asCaptureFile,
    backfillPosters,
    captureMany,
    describeCaptureError,
    onPosterReady,
  } from './capture'
  import { clearSharedHandoff, peekSharedHandoff, pluralRu, shareReturnState, shouldAcceptShare } from './capture'
  import type { CaptureBatchOutcome, CaptureFile, CaptureRequest } from './capture'
  import { BackupPanel } from './backup'
  import { DirectionGrid, DirectionsPanel, ExpenseLog } from './directions'
  import { readApiKey, readMetaValue, writeMetaValue } from './directions/meta'
  import { SearchPanel, searchService } from './search'
  import {
    MOMENT_PRESETS,
    MomentPanel,
    dateInputValue,
    describeMoment,
    momentFromDateInput,
    momentFromDays,
    risingIdeas,
  } from './moments'
  import { TriagePanel, triageQueue } from './triage'
  import { relatedIdeas, whileAway } from './moments/triggers'
  import { PLACE_KEY, ideasAt, normalizePlace, placeOf, placesOf } from './moments/places'
  import { linkHelp } from './capture/links'
  import { PLACE_KEY as PLACE_KEY_FOR_WRITE } from './moments/places'
  import { SelectPanel } from './select'
  import { CompressButton, TranscribeButton } from './video'
  import {
    ImageButton,
    MaterialViewer,
    FreeSpace,
    autoProcessMaterials,
    meaningfulTitle,
    technicalName,
  } from './media'

  let text = $state('')
  let ideas = $state<Idea[]>([])
  /**
   * Материалы идей: нужны, чтобы показать «Расшифровать» там, где есть видео
   * или голос без текста, и чтобы показать готовую расшифровку.
   */
  let materials = $state<Record<string, Material[]>>({})
  /** Текст ошибки слоя данных: показываем вместо списка, если база недоступна. */
  let dbError = $state<string | null>(null)
  /** Идея, к которой пришли из поиска: её карточку подсвечиваем. */
  let highlightId = $state<string | null>(null)
  let highlightTimer: ReturnType<typeof setTimeout> | null = null
  /** Ошибка выгрузки или архива: показываем рядом со списком, а не молча. */
  let exitError = $state<string | null>(null)
  /**
   * Спокойное объяснение после захвата.
   *
   * Не ошибка, а подсказка: ссылку прочитать не вышло — вот что делать.
   * Молчать нельзя: человек видит адрес вместо названия и не понимает,
   * чья это вина.
   */
  let notice = $state<string | null>(null)
  /** Показан ли архив. По умолчанию нет — но он не спрятан бесследно. */
  let showArchive = $state(false)
  /** Идея, чьё тело раскрыто целиком. */
  let expandedId = $state<string | null>(null)
  /** Что человек смотрит: посмотреть запись можно прямо из списка. */
  let viewing = $state<Material | null>(null)
  /**
   * Какая идея раскрыта.
   *
   * Открыта ОДНА за раз: иначе список снова превращается в простыню,
   * а смысл был именно в том, чтобы список читался.
   */
  let openedId = $state<string | null>(null)
  /** Показан ли хвост приложения: копия, пояснения. По умолчанию спрятан. */
  let showMore = $state(false)

  /**
   * Экран. Их три, и это главное изменение вёрстки.
   *
   * Раньше ВСЁ лежало одной колонкой: до списка идей надо было листать
   * шесть разделов, а до захвата — возвращаться наверх. Человек перестал
   * хотеть этим пользоваться, и он прав: приложение должно показывать
   * ОДНУ вещь за раз.
   *
   *   «Сейчас» — что требует решения: моменты, разбор, подбор
   *   «Идеи»   — поиск и список
   *   «Ещё»    — направления, копия, пояснения
   *
   * Захват не экран, а шторка: он нужен в любой момент, а не на одном.
   */
  let tab = $state<'now' | 'ideas' | 'more'>('now')
  /** Открыта ли шторка захвата. */
  let captureOpen = $state(false)
  /**
   * Настроен ли ключ.
   *
   * Новичок открывает «Сейчас» и должен понимать, что делать: без ключа
   * записи не распознаются, а ошибка вылезала бы только после нажатия
   * на что-нибудь. `null` — ещё не знаем.
   */
  let hasKey = $state<boolean | null>(null)
  /**
   * Когда человек заходил в прошлый раз.
   *
   * Нужно для повода «по действию»: если он не заходил давно, стоит показать
   * то, что ждёт внимания. Без этого числа напоминание было бы навязчивым.
   */
  let lastSeenAt = $state<string | null>(null)
  /**
   * Какое направление рассматриваем.
   *
   * `null` — показываем все идеи. Выбор направления переводит на экран
   * «Идеи» с отбором: так «посмотреть подробнее» не требует второго списка.
   */
  let directionFilter = $state<string | null>(null)
  /** Какое место рассматриваем: `null` — все идеи. */
  let placeFilter = $state<string | null>(null)
  /**
   * Направления для выбора руками.
   *
   * Нужны ДВЕ вещи сразу. Первая: сейчас, если ИИ ошибся, человек не может
   * поправить — «Кухня» вместо «Дача» и всё, руками не переставить. Вторая:
   * каждая правка становится УРОКОМ для промпта, и он начинает говорить
   * языком этого человека.
   */
  let directionOptions = $state<{ id: string; name: string }[]>([])

  onMount(() => {
    void boot()
    // Обложки видео делаются В ФОНЕ после захвата. Когда кадр готов,
    // список обновляем сразу: иначе человек увидел бы картинку только
    // после перезагрузки и решил бы, что ничего не произошло.
    const off = onPosterReady((material) => applyMaterial(material))
    return off
  })

  /**
   * Запоминает, что человек зашёл СЕЙЧАС, сохраняя прошлый заход.
   *
   * Порядок важен: сначала читаем старое значение (по нему решаем, давно ли
   * он был), потом записываем новое. Наоборот — и мы всегда видели бы «только
   * что заходил», а повод по действию не срабатывал бы никогда.
   */
  async function touchLastSeen(): Promise<void> {
    try {
      const previous = await readMetaValue('last_seen_at')
      lastSeenAt = typeof previous === 'string' ? previous : null
      await writeMetaValue('last_seen_at', new Date().toISOString())
    } catch {
      lastSeenAt = null
    }
  }

  /** Направления для выбора: читаем вместе с идеями. */
  async function loadDirections(): Promise<void> {
    try {
      directionOptions = (await directionStore.list()).map((d) => ({ id: d.id, name: d.name }))
    } catch {
      directionOptions = []
    }
  }

  /**
   * Человек сам ставит направление — и это же становится уроком.
   *
   * Пишем в историю не «что-то случилось», а именно ПАРУ «какой текст —
   * какое направление человек выбрал». Из таких пар промпт и учится:
   * без них он мог бы учиться только на своих же догадках, то есть
   * закреплял бы собственные ошибки.
   */
  async function changeDirection(idea: Idea, directionId: string): Promise<void> {
    try {
      exitError = null
      const next = directionId === '' ? null : directionId
      if (next === idea.direction_id) return
      await ideaRepository.update(idea.id, { direction_id: next })
      const name = directionOptions.find((d) => d.id === next)?.name ?? null
      await historyStore.append({
        idea_id: idea.id,
        type: 'reformulation',
        actor: 'user',
        summary: name === null ? 'Направление снято человеком' : `Направление выбрано человеком: ${name}`,
        meta: {
          learned_direction: name,
          learned_text: `${idea.title} ${idea.body}`.trim().slice(0, 400),
        },
      })
      await load()
      await loadDirections()
    } catch (e) {
      exitError = e instanceof Error ? errorText(e) : String(e)
    }
  }

  /** Перечитывает, есть ли ключ: он ставится на экране «Ещё». */
  async function refreshKeyState(): Promise<void> {
    try {
      hasKey = (await readApiKey()) !== ''
    } catch {
      hasKey = false
    }
  }

  /** Загрузка и приём «Поделиться» — по очереди, чтобы входящие встали в список. */
  /**
   * Просим браузер НЕ ВЫТЕСНЯТЬ наши данные.
   *
   * Найдено на телефоне автора, и это причина пропавшего видео на 231 МБ:
   * без этой просьбы браузер считает данные «неценными» и молча удаляет их,
   * когда ему мало места. Отсюда чёрный плеер, «в записи нет речи» и
   * NotFoundError — три разных симптома одной причины.
   *
   * Браузер вправе отказать (он смотрит на «привычность» приложения), и это
   * не ошибка: отказ означает лишь, что защита не обещана. Молча — нельзя,
   * поэтому отказ мы показываем в журнале расходов и в проверке памяти.
   */
  async function requestPersistence(): Promise<void> {
    try {
      if (!navigator.storage?.persist || !navigator.storage.persisted) return
      if (await navigator.storage.persisted()) return
      await navigator.storage.persist()
    } catch {
      /* отказ браузера — не повод ломать запуск */
    }
  }

  async function boot() {
    await load()
    await loadDirections()
    await touchLastSeen()
    void requestPersistence()
    await refreshKeyState()
    await acceptShared()
    // Досоздаём обложки для роликов, снятых ДО появления этой возможности.
    // Иначе у того, кто уже пользуется приложением, список остался бы
    // списком хешей навсегда. Работа бесплатная, локальная и в фоне:
    // ждать её не нужно, карточки обновятся сами по мере готовности.
    void backfillPosters(Object.values(materials).flat()).catch(() => {
      /* обложки — украшение: сбой здесь ничего не ломает */
    })
    // И разбор материалов — тоже в фоне. К моменту, когда человек откроет
    // разбор, у записей уже будет текст, а значит, и осмысленные названия.
    void processAllMaterials()
  }

  /**
   * Расшифровка речи и понимание картинок — САМИ, без кнопок.
   *
   * Решение автора: нажимать «расшифровать» каждый раз — лишний труд,
   * а цена оказалась около копейки за запись. Поэтому разбор идёт сразу
   * после загрузки и при запуске, по одному файлу, в фоне.
   */
  async function processAllMaterials(): Promise<void> {
    try {
      await autoProcessMaterials(
        Object.values(materials).flat(),
        { ideas, onUpdated: (material) => applyMaterial(material) },
      )
    } catch {
      /* автоматика не должна ломать приложение */
    }
  }

  /**
   * Копию восстановили: список перечитываем, а поиск собираем заново.
   * Импорт мог добавить идеи и тексты мимо обычных путей сохранения.
   * Пересборку не ждём: она идёт в фоне, а экран поиска дождётся её сам.
   */
  async function onImported(): Promise<void> {
    await load()
    void searchService.build().catch(() => {
      /* идеи уже на месте; поиск соберётся при следующем обращении */
    })
  }

  /** Читает идеи и их материалы из IndexedDB. */
  async function load() {
    try {
      const list = await ideaRepository.list({ sortBy: 'captured_at', order: 'desc' })
      ideas = list
      materials = await loadMaterials(list)
      dbError = null
    } catch (e) {
      dbError = errorText(e)
    }
  }

  /**
   * Идеи делим надвое: в работе и в архиве.
   *
   * Архив — **место возврата**, а не свалка (РЕШЕНИЯ.md, вопрос 8). Поэтому
   * он не прячется бесследно: его видно отдельным списком, оттуда можно
   * вернуть. И поиск архивное тоже находит.
   */
  const activeIdeas = $derived(ideas.filter((idea) => idea.status !== 'archived'))
  /** Что видно в списке: всё или одно выбранное направление. */
  const visibleIdeas = $derived.by(() => {
    if (placeFilter !== null) return ideasAt(activeIdeas, placeFilter)
    if (directionFilter !== null) return activeIdeas.filter((idea) => idea.direction_id === directionFilter)
    return activeIdeas
  })

  /** Места, названные человеком: от частых к редким. */
  const places = $derived(placesOf(activeIdeas))
  const archivedIdeas = $derived(ideas.filter((idea) => idea.status === 'archived'))

  /** Выгружает одну идею файлом: zip с текстом и материалами. */
  async function exportOne(idea: Idea): Promise<void> {
    try {
      exitError = null
      const file = await exportIdea(idea.id)
      if (!file) {
        exitError = 'Идея не нашлась — возможно, её уже удалили.'
        return
      }
      downloadIdeaExport(file)
      await load()
    } catch (e) {
      exitError = `Не удалось выгрузить: ${errorText(e)} Оригиналы не тронуты.`
    }
  }

  /** Убирает идею в архив. Без причины нельзя — это и есть «осознанный архив». */
  async function toArchive(idea: Idea): Promise<void> {
    try {
      exitError = null
      // Спрашиваем причину: готовые варианты снимают трение, своя — не загоняет
      // человека в три чужие формулировки.
      const answer = window.prompt(
        `Почему идея уходит в архив?\n\nМожно выбрать готовое (${ARCHIVE_REASONS.join(' / ')}) или написать своё:`,
        ARCHIVE_REASONS[0],
      )
      if (answer === null) return
      await archiveIdea(idea.id, answer)
      await load()
    } catch (e) {
      exitError = errorText(e)
    }
  }

  /** Возвращает идею из архива: причина очищается, идея снова в работе. */
  async function fromArchive(idea: Idea): Promise<void> {
    try {
      exitError = null
      await restoreIdea(idea.id)
      await load()
    } catch (e) {
      exitError = `Не удалось вернуть: ${errorText(e)}`
    }
  }

  /** Идея, у которой сейчас выбирают срок, и выбранная дата. */
  let momentId = $state<string | null>(null)
  let momentDate = $state('')

  /**
   * Ставит момент: идея всплывёт сама за две недели до срока.
   *
   * Никакого дедлайна здесь нет (`АРХИТЕКТУРА.md`, раздел 7): момент — повод
   * вспомнить, а не срок сдачи. После срока идея просто возвращается в список.
   */
  async function setMoment(idea: Idea, at: string | null): Promise<void> {
    try {
      exitError = null
      await ideaRepository.update(idea.id, {
        moment_at: at,
        moment_rule: at ? 'manual' : null,
      })
      momentId = null
      await load()
    } catch (e) {
      exitError = errorText(e)
    }
  }

  async function saveMomentDate(idea: Idea): Promise<void> {
    const at = momentFromDateInput(momentDate)
    if (!at) {
      exitError = 'Не понял дату. Выберите день в календаре.'
      return
    }
    await setMoment(idea, at)
  }

  /**
   * Что открыто в карточке: дополнение или правка.
   *
   * Это две РАЗНЫЕ операции (src/data/edit.ts). Дополнение дописывает мысль
   * с датой и не трогает написанное; правка меняет текст, но прежнюю версию
   * сохраняет история. Смешивать их нельзя: иначе человек начнёт
   * переписывать первую мысль и потеряет то, с чего начинал.
   */
  let editingId = $state<string | null>(null)
  let editingMode = $state<'note' | 'edit'>('note')
  let editTitle = $state('')
  let editBody = $state('')
  let editBusy = $state(false)

  function openNote(idea: Idea): void {
    editingId = idea.id
    editingMode = 'note'
    editBody = ''
    exitError = null
  }

  function openEdit(idea: Idea): void {
    editingId = idea.id
    editingMode = 'edit'
    editTitle = idea.title
    editBody = idea.body
    exitError = null
  }

  async function saveEditing(idea: Idea): Promise<void> {
    editBusy = true
    exitError = null
    try {
      if (editingMode === 'note') {
        await appendIdeaNote(idea.id, editBody)
      } else {
        await editIdeaText(idea.id, { title: editTitle, body: editBody })
      }
      editingId = null
      await load()
      // Текст идеи изменился — поиск должен видеть новое сразу, а не после
      // перезагрузки страницы.
      const fresh = ideas.find((item) => item.id === idea.id)
      if (fresh) updateSearchIndex(searchService.indexIdea(fresh))
    } catch (e) {
      exitError = errorText(e)
    } finally {
      editBusy = false
    }
  }

  /**
   * Материалы всех идей. Читаем по идее, а не всё хранилище разом: в памяти
   * оказываются материалы одной идеи, а не все видео сразу. Сбой чтения
   * одной идеи не роняет список — просто у неё не будет кнопки.
   */
  async function loadMaterials(list: readonly Idea[]): Promise<Record<string, Material[]>> {
    const map: Record<string, Material[]> = {}
    await Promise.all(
      list.map(async (idea) => {
        try {
          map[idea.id] = await materialRepository.listByIdea(idea.id)
        } catch {
          map[idea.id] = []
        }
      }),
    )
    return map
  }

  /**
   * Человек сам называет место идеи.
   *
   * Пишем в СВОЙСТВА, а не в новое поле схемы: свойства для этого и есть —
   * короткие слова самого человека, по которым потом ищут.
   */
  async function setPlace(idea: Idea, value: string): Promise<void> {
    try {
      exitError = null
      const place = normalizePlace(value)
      const props = { ...(idea.props ?? {}) }
      if (place === '') delete props[PLACE_KEY_FOR_WRITE]
      else props[PLACE_KEY_FOR_WRITE] = place
      await ideaRepository.update(idea.id, { props })
      await load()
    } catch (e) {
      exitError = e instanceof Error ? e.message : String(e)
    }
  }

  /** Идеи рядом по смыслу: подсказка «а что я ещё про это думал». */
  function relatedFor(idea: Idea) {
    return relatedIdeas(idea, activeIdeas, materials, 3)
  }

  /** Видео идеи: только у них есть что сжимать. */
  function videos(idea: Idea): Material[] {
    return (materials[idea.id] ?? []).filter((material) => material.kind === 'video')
  }

  /** Материалы идеи, у которых может быть речь: видео и голосовые заметки. */
  function transcribable(idea: Idea): Material[] {
    return (materials[idea.id] ?? []).filter(
      (material) => material.kind === 'video' || material.kind === 'audio',
    )
  }

  /**
   * Картинки идеи. Показываем их отдельной кнопкой «Прочитать и описать»:
   * по нажатию модель прочитает текст (он попадёт в поиск) и опишет
   * изображение (смысл уйдёт в разбор направлений). Без нажатия — ничего:
   * это платная операция.
   *
   * Отдаём и материалы с готовым текстом: так результат виден и после
   * перезагрузки, а не только сразу после нажатия.
   */
  function images(idea: Idea): Material[] {
    return (materials[idea.id] ?? []).filter((material) => material.kind === 'image')
  }

  /** Материал изменился (появился текст или отметка об ошибке) — обновляем список. */
  function applyMaterial(updated: Material) {
    const list = materials[updated.idea_id] ?? []
    materials = {
      ...materials,
      [updated.idea_id]: list.map((material) => (material.id === updated.id ? updated : material)),
    }
    // Расшифровка готова: переиндексируем идею, иначе новый текст найдётся
    // только после перезагрузки страницы.
    updateSearchIndex(searchService.indexMaterial(updated))
  }

  /**
   * Обновление поискового индекса в фоне.
   *
   * Поиск не должен задерживать сохранение идеи или расшифровку. Сбой
   * индекса тоже не отменяет данные: идея и материал уже в базе, просто
   * поиск временно останется прежним.
   */
  function updateSearchIndex(work: Promise<void>): void {
    void work.catch(() => {
      /* идея и материал уже сохранены — это главное */
    })
  }

  /**
   * Переход из поиска к идее: прокрутка к карточке и короткая подсветка.
   * `false` — идеи в списке уже нет (например, индекс не успел обновиться);
   * тогда экран поиска покажет её содержимое сам.
   */
  function openIdea(id: string): boolean {
    // Идея живёт на экране «Идеи»: сначала переключаем экран, потом ищем.
    tab = 'ideas'
    const element = document.getElementById(`idea-${id}`)
    if (!element) return false
    element.scrollIntoView({ behavior: 'smooth', block: 'center' })
    highlightId = id
    if (highlightTimer) clearTimeout(highlightTimer)
    highlightTimer = setTimeout(() => {
      if (highlightId === id) highlightId = null
      highlightTimer = null
    }, 2600)
    return true
  }

  /** Первая строка текста — заголовок; всё остальное живёт в `body`. */
  function firstLine(value: string): string {
    return value.split('\n')[0].trim().slice(0, 120)
  }

  /** Заголовок для списка: он же запасной вариант, если заголовка нет. */
  /**
   * Название идеи для списка — СМЫСЛ, а не имя файла.
   *
   * Instagram сохраняет ролики как `d2c22f18….mp4`, и список превращался
   * в список хешей. Настоящее содержание у нас есть — распознанный текст, —
   * и показывать надо его. Имя файла остаётся мелкой подписью.
   */
  /** Идеи для повода «по действию»: пересчитываем при изменении списка. */
  const whileAwayIds = $derived(whileAway(activeIdeas, lastSeenAt))

  function display(idea: Idea): string {
    return meaningfulTitle(idea, materials[idea.id] ?? [])
  }

  /** Имя файла — техническая подробность. */
  function fileName(idea: Idea): string | null {
    return technicalName(idea, materials[idea.id] ?? [])
  }

  /** Материал для просмотра: видео или картинка с файлом. */
  function previewable(idea: Idea): Material | null {
    return (
      (materials[idea.id] ?? []).find(
        (material) =>
          Boolean(material.blob) && (material.kind === 'video' || material.kind === 'image'),
      ) ?? null
    )
  }

  /**
   * Тело идеи для карточки.
   *
   * Показываем, только когда есть заголовок: иначе тело уже видно как `display`.
   * Это важно из-за дополнений — они дописываются в конец тела, и без этого
   * человек не увидел бы, что идея выросла.
   */
  function bodyPreview(idea: Idea): string {
    const body = idea.body.trim()
    if (body === '') return ''
    if (expandedId === idea.id) return body
    return body.length > 260 ? `${body.slice(0, 260)}…` : body
  }

  /**
   * Кадр-обложка идеи: первый видео-материал с готовой обложкой.
   *
   * Именно она спасает список от имён вида `d2c22f18…`: по картинке человек
   * вспоминает, что было в ролике, а по хешу — нет.
   */
  function posterFor(idea: Idea): string | null {
    for (const material of materials[idea.id] ?? []) {
      if (material.poster) return material.poster
    }
    return null
  }

  /** Есть ли что прятать за «показать целиком». */
  function hasHiddenBody(idea: Idea): boolean {
    return idea.title.trim() !== '' && idea.body.trim().length > 260
  }

  async function add() {
    const t = text.trim()
    if (!t) return
    try {
      // «+» — текст, набранный вручную. Путь `typed` не привязан к устройству:
      // продукт начинается с телефона, и метрика «захват без открытия
      // приложения» не должна считать это десктопом.
      const idea = await ideaRepository.create({
        title: firstLine(t),
        body: t,
        captured_via: 'typed',
      })
      ideas = [idea, ...ideas]
      updateSearchIndex(searchService.indexIdea(idea))
      text = ''
      dbError = null
      // Идея сохранена — шторка больше не нужна. Оставлять её открытой
      // значит заставлять человека закрывать её вручную после каждого ввода.
      captureOpen = false
    } catch (e) {
      dbError = errorText(e)
    }
  }

  /**
   * Единая точка сохранения для всех каналов, кроме «+».
   *
   * Бросает только тогда, когда не сохранилось ничего: канал покажет
   * сообщение, а набранный текст останется в поле. Сбой на одном файле
   * из нескольких остальные не отменяет — об этом скажет `warning`.
   */
  async function saveCapture(request: CaptureRequest): Promise<CaptureBatchOutcome> {
    const batch = await captureMany(request)
    // Идеи встают в порядке файлов: первая идея — первый файл.
    ideas = [...batch.outcomes.map((outcome) => outcome.idea), ...ideas]
    // Материалы только что захваченных идей — сразу в список: у видео
    // и голосовой заметки тут же появится «Расшифровать», без перезагрузки.
    const added: Record<string, Material[]> = {}
    // Ссылку прочитать не удалось — говорим, что делать. Проверяем ДО
    // обновления списка, чтобы подсказка относилась к только что захваченному.
    const unreadLink = batch.outcomes
      .flatMap((outcome) => outcome.materials)
      .find((material) => material.kind === 'link' && !material.extracted_text && material.uri)
    notice = unreadLink?.uri ? linkHelp(unreadLink.uri) : null

    for (const outcome of batch.outcomes) {
      added[outcome.idea.id] = outcome.materials
      // Новая идея должна находиться поиском сразу, вместе с уже
      // приложенными к ней материалами.
      updateSearchIndex(searchService.indexIdea(outcome.idea))
    }
    materials = { ...materials, ...added }
    // Прошлая ошибка больше не «висит»: предупреждение о частичном сбое
    // вызывающий выставит сам, уже после этого.
    dbError = null

    // И сразу разбор — БЕЗ кнопок. Человек не должен нажимать «расшифровать»
    // на каждой записи: цена около копейки, а ручной шаг того не стоит.
    // Ждать этого тоже не нужно: работа идёт в фоне, карточки обновятся сами.
    void autoProcessMaterials(
      Object.values(added).flat(),
      { ideas, onUpdated: (material) => applyMaterial(material) },
    ).catch(() => {
      /* автоматика не должна ломать захват */
    })

    return batch
  }

  /** Поле очищаем только после успешного сохранения. */
  function consumeText() {
    text = ''
  }


  /**
   * Картинка, вставленная прямо в поле (Ctrl+V), — запасной путь для
   * браузеров, которые не дают читать буфер обмена программно (Firefox).
   * Обычный текст не трогаем: пусть вставляется как обычно.
   */
  function onPaste(event: ClipboardEvent) {
    const items = event.clipboardData?.items
    if (!items) return
    const files: CaptureFile[] = []
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i]
      if (item.kind !== 'file' || !item.type.startsWith('image/')) continue
      const file = item.getAsFile()
      if (file) files.push(asCaptureFile(file))
    }
    if (files.length === 0) return

    event.preventDefault()
    void saveCapture({ channel: 'clipboard', text: text.trim() || undefined, files })
      .then((batch) => {
        // Поле очищаем только если текст действительно уехал в идею.
        if (batch.textConsumed) text = ''
        dbError = null
      })
      .catch((e) => {
        dbError = describeCaptureError(e, 'clipboard')
      })
  }

  /**
   * Приём «Поделиться»: Service Worker сложил то, чем поделились, во входящие
   * и привёл сюда. Входящие стираем только после успешного сохранения —
   * иначе поделённое потерялось бы вместе со сбоем.
   */
  async function acceptShared() {
    let hasIncoming = false
    try {
      hasIncoming = await shouldAcceptShare(window.location.search)
    } catch (e) {
      dbError = errorText(e)
      return
    }
    if (!hasIncoming) return

    try {
      const handoff = await peekSharedHandoff()
      if (!handoff) {
        if (shareReturnState(window.location.search) === 'error') {
          dbError = 'Не удалось принять то, чем поделились. Попробуйте ещё раз или сохраните текстом.'
        }
        dropShareFlag()
        return
      }
      const batch = await saveCapture({
        channel: 'share',
        text: handoff.text,
        sourceTitle: handoff.title,
        url: handoff.url,
        files: handoff.files,
      })
      await clearSharedHandoff()
      dbError = batch.warning
    } catch (e) {
      // Входящие оставляем: попробуем снова при следующем открытии.
      dbError = describeCaptureError(e, 'share')
    } finally {
      dropShareFlag()
    }
  }

  /** Убирает `?share=1` из адреса, чтобы обновление страницы не повторяло приём. */
  function dropShareFlag() {
    if (!window.location.search) return
    try {
      window.history.replaceState(null, '', window.location.pathname)
    } catch {
      /* история недоступна — не критично */
    }
  }

  async function remove(id: string) {
    try {
      // Мягкое удаление: запись остаётся в базе со статусом `deleted`.
      await ideaRepository.remove(id)
      ideas = ideas.filter((i) => i.id !== id)
      updateSearchIndex(searchService.removeIdea(id))
      dbError = null
    } catch (e) {
      dbError = errorText(e)
    }
  }

  function errorText(e: unknown): string {
    return e instanceof Error ? e.message : 'Хранилище идей недоступно.'
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) add()
  }
</script>

<svelte:window onkeydown={onKey} />

<header class="top">
  <div class="wrap">
    <div class="brand">
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M4 7h16M4 12h10M4 17h13" stroke="#ff8a5b" stroke-width="1.7" />
        <circle cx="18.5" cy="15" r="3.2" stroke="#5fd4a8" stroke-width="1.7" />
      </svg>
      Муза
    </div>
    <span class="stage">каркас · этап 0</span>
  </div>
</header>

<main class="wrap">
  <!-- Захват — ШТОРКА, а не раздел: он нужен в любой момент, а не на одном
       экране. Раньше до него надо было листать наверх — самое частое
       действие было самым далёким. -->
  {#if captureOpen}
    <div class="sheet-back" role="dialog" aria-modal="true" aria-label="Новая идея">
      <div class="sheet">
        <div class="sheet-bar">
          <span>Новая идея</span>
          <button type="button" class="sheet-close" onclick={() => (captureOpen = false)} aria-label="Закрыть">×</button>
        </div>
  <section class="capture">
    <label for="idea">Что надо будет сделать?</label>
    <textarea
      id="idea"
      bind:value={text}
      rows="3"
      placeholder="Например: аэрогриль на 5 литров — сравнить три варианта"
      onpaste={onPaste}
    ></textarea>
    <div class="row">
      <button class="btn" onclick={add} disabled={!text.trim()}>
        Сохранить идею
      </button>
      <span class="hint">Ctrl + Enter</span>
    </div>

    <CaptureChannels
      text={text}
      onCapture={async (request) => {
        // Канал (файл, камера, микрофон, вставка) сохранил — шторку закрываем,
        // иначе человек после каждого файла должен убирать её сам.
        const batch = await saveCapture(request)
        captureOpen = false
        return batch
      }}
      onTextConsumed={consumeText}
    />
  </section>
      </div>
    </div>
  {/if}

  <!-- ЭКРАН «СЕЙЧАС»: поиск в центре, направления вокруг него -->
  {#if tab === 'now'}
    <!-- Ссылку прочитать не вышло — говорим, что делать. Молчать нельзя:
         человек видит адрес вместо названия и не понимает, чья это вина. -->
    {#if notice}
      <p class="notice" role="status" aria-live="polite">
        {notice}
        <button type="button" class="notice-close" onclick={() => (notice = null)}>Понятно</button>
      </p>
    {/if}
    <!-- Поиск первым: это символ того, что ничего не забывается.
         Ищем по названиям, тексту, расшифровкам и картинкам. -->
    <SearchPanel {ideas} {materials} onOpenIdea={openIdea} />

    <!-- Направления — то, что уже сложилось из идей. Нажал и рассмотрел. -->
    <section class="directions-home">
      <h2>Направления</h2>
      <DirectionGrid
        ideas={activeIdeas}
        onPick={(direction) => {
          directionFilter = direction.id
          tab = 'ideas'
        }}
      />
    </section>

    <!-- Повод ПО МЕСТУ: слова самого человека, а не координаты.
         Работает без разрешений и не врёт пустым списком. -->
    {#if places.length > 0}
      <section class="places-home">
        <h2>По местам</h2>
        <div class="place-row">
          {#each places as entry (entry.place)}
            <button
              type="button"
              class="chip"
              onclick={() => {
                placeFilter = entry.place
                directionFilter = null
                tab = 'ideas'
              }}
            >
              {entry.place}
              <span class="count">{entry.count}</span>
            </button>
          {/each}
        </div>
        <p class="note">Так вы называете места сами — и по ним можно собрать идеи.</p>
      </section>
    {/if}

    <!-- Повод ПО ДЕЙСТВИЮ: человек не заходил давно — показываем то, что ждёт.
         Формулировка нарочно мягкая: лежащая идея это не долг и не провал. -->
    {#if whileAwayIds.length > 0}
      <section class="away">
        <h2>Пока вас не было</h2>
        <p class="note">
          Это не долги — просто идеи, которые ждут. Заходите, когда удобно.
        </p>
        <ul>
          {#each whileAwayIds as idea (idea.id)}
            <li>
              <button type="button" class="away-open" onclick={() => openIdea(idea.id)}>
                {display(idea)}
              </button>
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    <!-- Идеи, у которых момент близко: сначала приятное, не уборка. -->
    <MomentPanel ideas={risingIdeas(activeIdeas)} onChanged={load} />

    <!-- Разбор входящих: уборка, а не ценность. Три решения, один тап. -->
    <TriagePanel
      queue={triageQueue(activeIdeas)}
      allIdeas={activeIdeas}
      {materials}
      onChanged={load}
    />

    <!-- Главная функция: подбор «что сейчас кстати». Локально и бесплатно. -->
    <SelectPanel ideas={activeIdeas} {materials} onOpenIdea={(idea) => openIdea(idea.id)} />

    {#if hasKey === false}
      <!-- Без ключа ничего не распознаётся: записи останутся именами файлов,
           а разбор и подбор будут пустыми. Говорим об этом сразу, а не
           ошибкой после нажатия. -->
      <div class="need-key">
        <p>
          Чтобы Муза понимала записи — расшифровывала речь и читала картинки, — нужен
          ключ доступа к модели. Он хранится только в этом браузере.
        </p>
        <button type="button" class="ask-key" onclick={() => (tab = 'more')}>
          Настроить ключ
        </button>
      </div>
    {/if}

    {#if activeIdeas.length === 0}
      <p class="empty-hint">Пока пусто. Нажмите «+» снизу — и первая идея появится здесь.</p>
    {/if}
  {/if}

  <!-- ЭКРАН «ИДЕИ»: список, при необходимости — одного направления -->
  {#if tab === 'ideas'}
  {#if directionFilter || placeFilter}
    <button
      type="button"
      class="reset"
      onclick={() => {
        directionFilter = null
        placeFilter = null
      }}
    >
      ← Все идеи{#if placeFilter} · {placeFilter}{:else if directionFilter} · направление{/if}
    </button>
  {/if}

  <section class="list">
    <h2>
      {visibleIdeas.length}
      {pluralRu(visibleIdeas.length, 'идея', 'идеи', 'идей')}
    </h2>

    {#if exitError}
      <p class="exit-error" role="status" aria-live="polite">{exitError}</p>
    {/if}


    {#if visibleIdeas.length === 0}
      <p class="empty">
        {dbError ??
          'Пока пусто. Добавьте первую идею — она появится здесь и сохранится на этом устройстве.'}
      </p>
    {:else}
      {#if dbError}
        <p class="empty">{dbError}</p>
      {/if}
      <ul>
        {#each visibleIdeas as idea (idea.id)}
          <li id={`idea-${idea.id}`} class:found={highlightId === idea.id}>
            <div class="line">
              {#if posterFor(idea)}
                <!-- Кадр-обложка и вход в просмотр: по картинке человек
                     вспомнит ролик, по имени `d2c22f18…` — нет. -->
                <button
                  type="button"
                  class="shot"
                  onclick={() => {
                    const material = previewable(idea)
                    if (material) viewing = material
                  }}
                  aria-label="Посмотреть запись"
                >
                  <img class="poster" src={posterFor(idea)} alt="" loading="lazy" />
                  {#if previewable(idea)?.kind === 'video'}<span class="play" aria-hidden="true">▶</span>{/if}
                </button>
              {/if}
              <button
                type="button"
                class="open"
                onclick={() => (openedId = openedId === idea.id ? null : idea.id)}
                aria-expanded={openedId === idea.id}
              >
                <span class="txt">{display(idea)}</span>
                <span class="sub">
                  {openedId === idea.id ? 'Свернуть' : 'Подробнее'}
                  {#if fileName(idea)}<span class="file">{fileName(idea)}</span>{/if}
                </span>
              </button>
              <button
                class="del"
                onclick={() => remove(idea.id)}
                aria-label="Удалить"
                title="Удалить"
              >
                ×
              </button>
            </div>

            <!-- Подробности скрыты, пока идея не открыта. Раньше каждая
                 карточка показывала всё сразу: 168 строк на идею, и с
                 двадцатью идеями страница превращалась в бесконечную
                 простыню. Список должен читаться глазами, а не листаться. -->
            {#if openedId === idea.id}
              <div class="detail">
            {#each images(idea) as material (material.id)}
              <ImageButton {material} onChanged={applyMaterial} />
            {/each}
            {#each transcribable(idea) as material (material.id)}
              <TranscribeButton {material} onChanged={applyMaterial} />
            {/each}
            <!-- Сжатие — по кнопке и с предупреждением: единственное место,
                 где оригинал заменяется. Память телефона кончится сама. -->
            {#each videos(idea) as material (material.id)}
              <CompressButton {material} onChanged={applyMaterial} />
            {/each}
            {#if idea.title.trim() !== '' && idea.body.trim() !== ''}
              <!-- Тело видно: дополнения дописываются в конец, и без этого
                   человек не заметил бы, что идея выросла. -->
              <p class="body">{bodyPreview(idea)}</p>
              {#if hasHiddenBody(idea)}
                <button
                  type="button"
                  class="link"
                  onclick={() => (expandedId = expandedId === idea.id ? null : idea.id)}
                >
                  {expandedId === idea.id ? 'Свернуть' : 'Показать целиком'}
                </button>
              {/if}
            {/if}

            {#if momentId === idea.id}
              <div class="editor">
                <p class="hint">
                  Идея сама появится в «Что сейчас кстати» за две недели до этого дня.
                  Никаких дедлайнов — после срока она просто вернётся в список.
                </p>
                <div class="exit">
                  {#each MOMENT_PRESETS as preset (preset.days)}
                    <button
                      type="button"
                      class="link"
                      onclick={() => void setMoment(idea, momentFromDays(preset.days))}
                    >
                      {preset.label}
                    </button>
                  {/each}
                </div>
                <label class="field">
                  <span>Или выберите день</span>
                  <input type="date" bind:value={momentDate} aria-label="День напоминания" />
                </label>
                <div class="exit">
                  <button type="button" class="save" onclick={() => void saveMomentDate(idea)}>
                    Запомнить день
                  </button>
                  {#if idea.moment_at}
                    <button type="button" class="link" onclick={() => void setMoment(idea, null)}>
                      Убрать напоминание
                    </button>
                  {/if}
                  <button type="button" class="link" onclick={() => (momentId = null)}>
                    Отмена
                  </button>
                </div>
              </div>
            {/if}

            {#if editingId === idea.id}
              <div class="editor">
                {#if editingMode === 'edit'}
                  <label class="field">
                    <span>Заголовок</span>
                    <input bind:value={editTitle} aria-label="Заголовок идеи" />
                  </label>
                {/if}
                <label class="field">
                  <span>{editingMode === 'note' ? 'Что добавить' : 'Текст идеи'}</span>
                  <textarea
                    bind:value={editBody}
                    rows={editingMode === 'note' ? 3 : 6}
                    placeholder={editingMode === 'note'
                      ? 'Например: на даче не хватит розетки, нужен удлинитель'
                      : ''}
                    aria-label={editingMode === 'note' ? 'Дополнение к идее' : 'Текст идеи'}
                  ></textarea>
                </label>
                {#if editingMode === 'note'}
                  <p class="hint">
                    Дополнение допишется с датой и не тронет то, что вы написали раньше.
                  </p>
                {:else}
                  <p class="hint">Прежняя версия останется в истории идеи: исправление не стирает.</p>
                {/if}
                <div class="exit">
                  <button
                    type="button"
                    class="save"
                    onclick={() => void saveEditing(idea)}
                    disabled={editBusy}
                  >
                    {editBusy ? 'Сохраняю…' : 'Сохранить'}
                  </button>
                  <button
                    type="button"
                    class="link"
                    onclick={() => (editingId = null)}
                    disabled={editBusy}
                  >
                    Отмена
                  </button>
                </div>
              </div>
            {/if}

            <!-- Повод ПО СВЯЗИ: рядом лежат идеи про то же. Считается
                 локально, по распознанному тексту, а не по именам файлов. -->
            {#if relatedFor(idea).length > 0}
              <div class="related">
                <span class="related-head">Рядом по смыслу</span>
                {#each relatedFor(idea) as near (near.idea.id)}
                  <button type="button" class="link" onclick={() => openIdea(near.idea.id)}>
                    {display(near.idea)}
                  </button>
                {/each}
              </div>
            {/if}

            <!-- Место своими словами: «Дача», «Леруа», «гараж».
                 Хранится в свойствах, работает без разрешений. -->
            <label class="place-pick">
              <span>Место</span>
              <input
                type="text"
                aria-label="Место идеи"
                placeholder="Например: Дача"
                value={placeOf(idea) ?? ''}
                onchange={(event) => void setPlace(idea, event.currentTarget.value)}
              />
            </label>

            <!-- Направление руками: если ИИ ошибся, человек должен мочь
                 поправить. И эта же правка — урок для промпта. -->
            {#if directionOptions.length > 0}
              <label class="dir-pick">
                <span>Направление</span>
                <select
                  aria-label="Направление идеи"
                  value={idea.direction_id ?? ''}
                  onchange={(event) => void changeDirection(idea, event.currentTarget.value)}
                >
                  <option value="">Без направления</option>
                  {#each directionOptions as option (option.id)}
                    <option value={option.id}>{option.name}</option>
                  {/each}
                </select>
              </label>
            {/if}

            <!-- Выход идеи: она уходит только выгрузкой или осознанным архивом.
                 Это обещание продукта, поэтому кнопки стоят в каждой карточке. -->
            <div class="exit">
              <button type="button" class="link" onclick={() => openNote(idea)}>
                Дополнить
              </button>
              <button type="button" class="link" onclick={() => openEdit(idea)}>
                Изменить
              </button>
              <button
                type="button"
                class="link"
                onclick={() => {
                  momentId = momentId === idea.id ? null : idea.id
                  momentDate = dateInputValue(idea.moment_at)
                }}
              >
                {idea.moment_at ? `Вспомнить ${describeMoment(idea.moment_at)}` : 'Когда вспомнить'}
              </button>
              <button type="button" class="link" onclick={() => void exportOne(idea)}>
                Выгрузить файлом
              </button>
              <button type="button" class="link" onclick={() => void toArchive(idea)}>
                В архив
              </button>
            </div>
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}

    <!-- Архив — место возврата, а не свалка: он виден и оттуда возвращают. -->
    {#if archivedIdeas.length > 0}
      <div class="archive">
        <button
          type="button"
          class="archive-toggle"
          onclick={() => (showArchive = !showArchive)}
          aria-expanded={showArchive}
        >
          {showArchive ? 'Свернуть архив' : 'Архив'} ({archivedIdeas.length})
        </button>
        {#if showArchive}
          <p class="archive-note">
            Идеи в архиве не потеряны: их находит поиск, и любую можно вернуть в работу.
          </p>
          <ul>
            {#each archivedIdeas as idea (idea.id)}
              <li class="archived">
                <div class="line">
                  <span class="txt">{display(idea)}</span>
                </div>
                <p class="archive-reason">Причина: {idea.archived_reason ?? 'не указана'}</p>
                <div class="exit">
                  <button type="button" class="link" onclick={() => void fromArchive(idea)}>
                    Вернуть в работу
                  </button>
                  <button type="button" class="link" onclick={() => void exportOne(idea)}>
                    Выгрузить файлом
                  </button>
                </div>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    {/if}
  </section>

  {/if}

  <!-- ЭКРАН «ЕЩЁ»: направления, память, копия, пояснения -->
  {#if tab === 'more'}
  <!-- Память: файлы лежат на телефоне ДВАЖДЫ — в галерее и внутри Музы.
       Экран снимает тревогу «я не помню, что уже перенёс». -->
  <FreeSpace />

  <!-- Расходы: не одна цифра, а разбор — попадает ли промпт в кэш. -->
  <ExpenseLog />
  <!-- Ключевой экран продукта: идеи сами собираются в направления. -->
  <DirectionsPanel {ideas} onIdeasChanged={load} />

  <!-- Копия и пояснения нужны редко — внутри «Ещё» они ещё и свёрнуты,
       чтобы экран не превращался в простыню. -->
  <button
    type="button"
    class="more-toggle"
    onclick={() => (showMore = !showMore)}
    aria-expanded={showMore}
  >
    {showMore ? 'Свернуть' : 'Копия идей и пояснения'}
  </button>

  {#if showMore}
  <section class="backup">
    <h2>Копия идей</h2>
    <BackupPanel ideasCount={ideas.length} onImported={onImported} />
  </section>

  <section class="next">
    <h2>Что дальше</h2>
    <p>
      Идеи и материалы живут в IndexedDB на устройстве и переживают
      перезагрузку. Копия идей сохраняется одним файлом: zip-архив со всеми
      идеями и материалами.
    </p>
    <p>
      <strong>Как получить из идеи смысл.</strong> У видео и голосовых заметок
      нажмите <strong>«Расшифровать»</strong> — речь станет текстом, и по нему
      заработает поиск. Русская речь распознаётся русской моделью, нерусская —
      общей; стоимость видна после каждой расшифровки.
    </p>
    <p>
      У картинок и скриншотов есть кнопка
      <strong>«Прочитать и описать»</strong>: модель прочитает текст с
      изображения и коротко опишет его. Текст попадёт в поиск, а описание —
      в разбор направлений. Как и расшифровка, это платно и запускается только
      по нажатию.
    </p>
    <p>
      Потом нажмите <strong>«Разложить по направлениям»</strong> — идеи
      соберутся в 5–9 понятных групп. По одному имени файла модель ничего не
      поймёт, поэтому расшифровка идёт первой. Ключ хранится только в этом
      браузере.
    </p>
  </section>
  {/if}
  {/if}
</main>

<!-- Четыре гнезда. До любого экрана — ОДНО нажатие, и все видны сразу:
     меню-гамбургер прятало бы варианты, а тут прятать нечего.
     Захват — крупная кнопка: это самое частое действие. -->
<nav class="tabs" aria-label="Экраны">
  <button
    type="button"
    class="tab"
    class:on={tab === 'now'}
    onclick={() => (tab = 'now')}
    aria-current={tab === 'now' ? 'page' : undefined}
  >
    Сейчас{#if triageQueue(activeIdeas).length > 0}<span class="badge">{triageQueue(activeIdeas).length}</span>{/if}
  </button>
  <button
    type="button"
    class="tab"
    class:on={tab === 'ideas'}
    onclick={() => (tab = 'ideas')}
    aria-current={tab === 'ideas' ? 'page' : undefined}
  >
    Идеи
  </button>
  <button type="button" class="add" onclick={() => (captureOpen = true)} aria-label="Новая идея">
    +
  </button>
  <button
    type="button"
    class="tab"
    class:on={tab === 'more'}
    onclick={() => (tab = 'more')}
    aria-current={tab === 'more' ? 'page' : undefined}
  >
    Ещё
  </button>
</nav>

{#if viewing}
  <MaterialViewer
    material={viewing}
    idea={ideas.find((item) => item.id === viewing?.idea_id) ?? null}
    onClose={() => (viewing = null)}
    onIdeaChanged={async () => {
      await load()
      const fresh = ideas.find((item) => item.id === viewing?.idea_id)
      if (fresh) updateSearchIndex(searchService.indexIdea(fresh))
    }}
  />
{/if}

<style>
  :global(body) {
    margin: 0;
    background: #0a0d14;
    color: #e8ecf2;
    font: 16px/1.55 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
  }

  .wrap {
    max-width: 640px;
    margin: 0 auto;
    padding: 0 16px;
  }

  .top {
    position: sticky;
    top: 0;
    z-index: 5;
    background: #0a0d14;
    /* Без размытия и без нижней границы: при прокрутке они читались как
       широкая полоса-нашлёпка над содержимым. Фон непрозрачный — так
       содержимое не просвечивает и полоса не нужна. */
    padding-top: env(safe-area-inset-top);
  }

  .top .wrap {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    /* Было 52 — шапка выглядела толстой полосой. Заголовку хватает 40. */
    min-height: 40px;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 9px;
    font-weight: 650;
    letter-spacing: -0.01em;
  }

  .brand svg {
    width: 21px;
    height: 21px;
    flex: none;
  }

  .stage {
    font-size: 12px;
    color: #7c879c;
    white-space: nowrap;
  }

  main {
    padding-bottom: calc(48px + env(safe-area-inset-bottom));
  }

  .capture {
    margin: 22px 0 26px;
  }

  .capture label {
    display: block;
    font-size: 14px;
    color: #97a3b8;
    margin-bottom: 8px;
  }

  textarea {
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
    padding: 13px 14px;
    border-radius: 12px;
    border: 1px solid #232a3b;
    background: #111725;
    color: #e8ecf2;
    font: inherit;
  }

  textarea:focus {
    outline: none;
    border-color: #ff8a5b;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 10px;
    flex-wrap: wrap;
  }

  .btn {
    padding: 11px 18px;
    border: none;
    border-radius: 11px;
    background: #ff8a5b;
    color: #17110d;
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }

  .btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .hint {
    font-size: 12px;
    color: #66718a;
  }

  h2 {
    margin: 0 0 12px;
    font-size: 15px;
    font-weight: 600;
    color: #97a3b8;
  }

  .empty {
    color: #66718a;
    font-size: 14px;
    margin: 0;
  }

  /* Выход идеи. Это тихие ссылки, а не яркие кнопки: главное действие на
     экране — захват, а выгрузка и архив — решения, а не призывы. */
  .exit {
    display: flex;
    flex-wrap: wrap;
    gap: 14px;
    margin-top: 9px;
  }

  .link {
    background: none;
    border: 0;
    padding: 0;
    font: inherit;
    font-size: 13px;
    color: #5eead4;
    text-decoration: underline;
    cursor: pointer;
  }

  .link:hover {
    color: #99f6e4;
  }

  /* Тело идеи в карточке: дополнения видны, иначе рост незаметен. */
  .body {
    margin: 7px 0 0;
    color: #a9b4c9;
    font-size: 14px;
    line-height: 1.45;
    white-space: pre-wrap;
  }

  .editor {
    margin-top: 10px;
    padding: 11px;
    border-radius: 10px;
    background: #0d1320;
    border: 1px solid #1b2130;
    display: flex;
    flex-direction: column;
    gap: 9px;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  .field span {
    color: #66718a;
    font-size: 12px;
  }

  .editor input,
  .editor textarea {
    width: 100%;
    box-sizing: border-box;
    background: #111725;
    border: 1px solid #1d2433;
    border-radius: 8px;
    color: #e7edf7;
    font: inherit;
    font-size: 14px;
    padding: 8px 10px;
  }

  .editor textarea {
    resize: vertical;
  }

  .editor input:focus,
  .editor textarea:focus {
    outline: none;
    border-color: #2f6f63;
  }

  .hint {
    margin: 0;
    color: #66718a;
    font-size: 12px;
  }

  .save {
    background: #1f6f5c;
    border: 0;
    border-radius: 9px;
    color: #ecfdf5;
    font: inherit;
    font-size: 14px;
    padding: 8px 14px;
    cursor: pointer;
  }

  .save:disabled {
    opacity: 0.6;
  }

  .exit-error {
    margin: 0 0 10px;
    color: #fca5a5;
    font-size: 13px;
  }

  /* Архив — место возврата: виден, объяснён, но не мешает работе. */
  .archive {
    margin-top: 18px;
  }

  .archive-toggle {
    background: #111725;
    border: 1px solid #1d2433;
    border-radius: 10px;
    color: #c7d2e5;
    font: inherit;
    font-size: 14px;
    padding: 9px 13px;
    cursor: pointer;
    width: 100%;
    text-align: left;
  }

  .archive-note {
    margin: 8px 0 10px;
    color: #66718a;
    font-size: 13px;
  }

  li.archived {
    background: #0d1320;
  }

  .archive-reason {
    margin: 6px 0 0;
    color: #66718a;
    font-size: 13px;
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  li {
    padding: 12px 13px;
    border-radius: 11px;
    background: #111725;
    border: 1px solid #1d2433;
    transition: border-color 0.2s ease, box-shadow 0.2s ease, background 0.2s ease;
  }

  /* Идея, к которой пришли из поиска: заметно, но не навсегда. */
  li.found {
    border-color: #ff8a5b;
    background: #171b26;
    box-shadow: 0 0 0 2px rgba(255, 138, 91, 0.18);
  }

  .line {
    display: flex;
    align-items: flex-start;
    gap: 10px;
  }

  /* Обложка в списке: маленькая и не тянет внимание на себя — она
     подсказка, а не главное. */
  .shot {
    position: relative;
    flex: none;
    width: 56px;
    height: 56px;
    padding: 0;
    border: 0;
    background: none;
    cursor: pointer;
  }

  .shot .play {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #ffffff;
    font-size: 16px;
    text-shadow: 0 1px 5px rgba(0, 0, 0, 0.85);
  }

  .file {
    display: block;
    margin-top: 4px;
    color: #4d5769;
    font-size: 11px;
    overflow-wrap: anywhere;
  }

  /* Заголовок — кнопка: нажал и раскрыл. Так строка списка остаётся
     короткой, а подробности появляются только там, где нужны. */
  .open {
    flex: 1;
    min-width: 0;
    background: none;
    border: 0;
    padding: 0;
    font: inherit;
    text-align: left;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    gap: 3px;
    color: inherit;
  }

  .sub {
    color: #5eead4;
    font-size: 12px;
  }

  /* Шторка захвата: выезжает снизу поверх экрана. Раньше стилей не было
     вовсе, и «шторка» рисовалась прямо в странице — как обычный раздел,
     только с крестиком. */
  .sheet-back {
    position: fixed;
    inset: 0;
    z-index: 60;
    background: rgba(4, 7, 14, 0.94);
    display: flex;
    align-items: flex-end;
    overflow-y: auto;
  }

  .sheet {
    width: 100%;
    background: #0d1320;
    border: 1px solid #1d2433;
    border-bottom: 0;
    border-radius: 16px 16px 0 0;
    padding: 14px 14px calc(16px + env(safe-area-inset-bottom));
    max-height: 92vh;
    overflow-y: auto;
  }

  .sheet-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
    color: #e7edf7;
    font-size: 16px;
  }

  .sheet-close {
    background: none;
    border: 0;
    color: #c7d2e5;
    font-size: 24px;
    line-height: 1;
    cursor: pointer;
    padding: 0 6px;
  }

  /* Нижняя панель: всегда под рукой, уважает жестовую полосу снизу. */
  .tabs {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 40;
    display: grid;
    grid-template-columns: 1fr 1fr auto 1fr;
    align-items: center;
    gap: 4px;
    padding: 6px 10px calc(6px + env(safe-area-inset-bottom));
    background: rgba(10, 14, 23, 0.96);
    border-top: 1px solid #1d2433;
    backdrop-filter: blur(8px);
  }

  .tab {
    position: relative;
    background: none;
    border: 0;
    color: #66718a;
    font: inherit;
    font-size: 13px;
    padding: 10px 4px;
    cursor: pointer;
    border-radius: 9px;
  }

  .tab.on {
    color: #5eead4;
    background: #111725;
  }

  .badge {
    margin-left: 5px;
    color: #0a0e17;
    background: #5eead4;
    border-radius: 9px;
    padding: 1px 6px;
    font-size: 11px;
  }

  .add {
    background: #f97316;
    border: 0;
    border-radius: 50%;
    color: #0a0e17;
    font-size: 26px;
    font-weight: 700;
    line-height: 1;
    width: 52px;
    height: 52px;
    margin: 0 6px;
    cursor: pointer;
  }

  /* Место под панель, иначе последняя карточка прячется за ней. */
  .wrap {
    padding-bottom: calc(92px + env(safe-area-inset-bottom));
  }

  .dir-pick {
    display: flex;
    align-items: center;
    gap: 9px;
    margin-top: 12px;
  }

  .dir-pick span {
    color: #66718a;
    font-size: 13px;
  }

  .dir-pick select {
    flex: 1;
    min-width: 0;
    background: #111725;
    border: 1px solid #1d2433;
    border-radius: 8px;
    color: #e7edf7;
    font: inherit;
    font-size: 14px;
    padding: 8px 10px;
  }

  .places-home {
    margin-top: 18px;
  }

  .places-home h2 {
    margin: 0 0 10px;
    font-size: 16px;
    color: #e7edf7;
  }

  .places-home .note {
    margin: 10px 0 0;
    color: #66718a;
    font-size: 13px;
  }

  .place-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .place-row .chip {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    background: #111725;
    border: 1px solid #1d2433;
    border-radius: 999px;
    color: #e7edf7;
    font: inherit;
    font-size: 14px;
    padding: 9px 14px;
    cursor: pointer;
  }

  .place-row .count {
    color: #5eead4;
    font-size: 13px;
  }

  .place-pick {
    display: flex;
    align-items: center;
    gap: 9px;
    margin-top: 12px;
  }

  .place-pick span {
    color: #66718a;
    font-size: 13px;
  }

  .place-pick input {
    flex: 1;
    min-width: 0;
    background: #111725;
    border: 1px solid #1d2433;
    border-radius: 8px;
    color: #e7edf7;
    font: inherit;
    font-size: 14px;
    padding: 8px 10px;
  }

  .away {
    margin-top: 18px;
    padding: 14px;
    border-radius: 12px;
    background: #131a2a;
    border: 1px solid #26324a;
  }

  .away h2 {
    margin: 0 0 6px;
    font-size: 16px;
    color: #e7edf7;
  }

  .away .note {
    margin: 0 0 10px;
    color: #66718a;
    font-size: 13px;
  }

  .away-open {
    width: 100%;
    text-align: left;
    background: none;
    border: 0;
    padding: 7px 0;
    color: #c7d2e5;
    font: inherit;
    font-size: 14px;
    cursor: pointer;
    border-bottom: 1px solid #1d2433;
  }

  .related {
    margin-top: 12px;
    padding-top: 10px;
    border-top: 1px solid #1d2433;
    display: flex;
    flex-direction: column;
    gap: 6px;
    align-items: flex-start;
  }

  .related-head {
    color: #66718a;
    font-size: 12px;
  }

  .directions-home {
    margin-top: 18px;
  }

  .directions-home h2 {
    margin: 0 0 10px;
    font-size: 16px;
    color: #e7edf7;
  }

  .reset {
    margin-bottom: 10px;
    background: #111725;
    border: 1px solid #1d2433;
    border-radius: 9px;
    color: #c7d2e5;
    font: inherit;
    font-size: 14px;
    padding: 8px 13px;
    cursor: pointer;
  }

  .need-key {
    margin-top: 14px;
    padding: 13px;
    border-radius: 12px;
    background: #131a2a;
    border: 1px solid #26324a;
  }

  .need-key p {
    margin: 0 0 10px;
    color: #a9b4c9;
    font-size: 14px;
  }

  .ask-key {
    background: #1f6f5c;
    border: 0;
    border-radius: 9px;
    color: #ecfdf5;
    font: inherit;
    font-size: 14px;
    padding: 9px 15px;
    cursor: pointer;
  }

  .empty-hint {
    margin: 16px 0 0;
    color: #66718a;
    font-size: 14px;
  }

  .more-toggle {
    margin-top: 18px;
    width: 100%;
    background: #111725;
    border: 1px solid #1d2433;
    border-radius: 10px;
    color: #c7d2e5;
    font: inherit;
    font-size: 14px;
    padding: 11px;
    cursor: pointer;
  }

  .detail {
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px solid #1d2433;
  }

  .poster {
    flex: none;
    width: 56px;
    height: 56px;
    object-fit: cover;
    border-radius: 8px;
    background: #0d1320;
    border: 1px solid #1d2433;
  }

  .txt {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .del {
    flex: none;
    width: 26px;
    height: 26px;
    border: none;
    border-radius: 7px;
    background: transparent;
    color: #66718a;
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
  }

  .del:hover {
    background: #1d2433;
    color: #ff8a5b;
  }

  .backup {
    margin-top: 30px;
    padding-top: 20px;
    border-top: 1px solid #1b2130;
  }

  .next {
    margin-top: 34px;
    padding-top: 20px;
    border-top: 1px solid #1b2130;
  }

  .next p {
    margin: 0 0 10px;
    font-size: 14px;
    color: #8b96ab;
  }
</style>
