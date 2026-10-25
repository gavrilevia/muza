/**
 * Конфиг расшифровки речи: лимит отправки и параметры вырезания звука.
 *
 * Модель и цена распознавания живут в `src/ai/config.ts` (`transcribeModel`,
 * `transcribePricing`): они относятся к провайдеру, а не к видео. Здесь —
 * то, что относится к самому файлу: сколько провайдер принимает за раз и
 * как из видео вырезать звук, если файл больше лимита.
 *
 * ## Почему лимит именно такой
 *
 * «Муза» отправляет файл в polza.ai. Его документация
 * (polza.ai/docs/api-reference/audio/transcriptions) прямо говорит:
 * «Лимит размера тела — около 15 МБ. На больших файлах возможен 502».
 * Поэтому по умолчанию берём 15 МБ, а не привычные 25 МБ OpenAI напрямую:
 * 25 МБ — это лимит другого сервиса, и полагаться на него здесь нельзя.
 * Reels на 30 секунд (единицы мегабайт) проходят целиком; пятиминутное
 * видео — нет, и для него есть вырезание звука.
 *
 * Лимит — значение конфига, а не код: если провайдер поднимет планку,
 * правится одна строка.
 */

import type { TranscriptionLanguage } from './transcriptionTypes'

/** Сколько байт файла отправляем провайдеру за один раз. */
export const DEFAULT_MAX_UPLOAD_BYTES = 15 * 1024 * 1024

/**
 * Лимит OpenAI при обращении напрямую, байт. Справочно: у polza.ai
 * документация обещает ~15 МБ, и это значение здесь только для памяти.
 */
export const OPENAI_DIRECT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024

/**
 * Тип вырезанного звука: MPEG-4 audio (`.m4a`, кодек AAC) — из списка
 * форматов провайдера (MP3, WAV, M4A, FLAC, OGG, WebM). Именно m4a, а не
 * mp3: AAC-кодировщик уже используется модулем сжатия, то есть заведомо
 * есть в однопоточном ядре ffmpeg.
 */
export const TRANSCRIPTION_AUDIO_MIME = 'audio/mp4'

/** Имя вырезанного звука во внутренней файловой системе ffmpeg. */
export const TRANSCRIPTION_AUDIO_NAME = 'muza-audio.m4a'

/** Форматы ответа, которые нам действительно нужны. */
export type TranscriptionResponseFormat = 'verbose_json' | 'json'

/** Параметры расшифровки, которые не являются настройками модели. */
export interface TranscriptionSettings {
  /** Файл больше этого — сначала вырезаем звук. */
  maxUploadBytes: number
  /** Язык аудио, ISO-639-1. «ru» — заметки у нас бытовые и по-русски. */
  language: string
  /** Формат ответа: `verbose_json` отдаёт ещё и длительность. */
  responseFormat: TranscriptionResponseFormat
  /**
   * Сколько ждать ответа распознавания, мс. Отдельно от `timeoutMs` чата:
   * 30 секунд для загрузки звука и распознавания мало, а чат столько ждать
   * не должен.
   */
  requestTimeoutMs: number
  /** Сколько ждать вырезание звука, мс. */
  extractTimeoutMs: number
  /** Тип результата вырезания. */
  audioMimeType: string
  /** Имя результата вырезания. */
  audioFileName: string
  /** Кодек звука: AAC есть в однопоточном ядре. */
  audioCodec: string
  /** Битрейт звука, кбит/с: для речи 64 кбит/с моно — с запасом. */
  audioBitrateKbps: number
  /** Частота дискретизации, Гц: 16 кГц достаточно для распознавания речи. */
  audioSampleRate: number
  /** Число каналов: моно вдвое меньше и не мешает распознаванию. */
  audioChannels: number
}

/** Значения по умолчанию. */
export const DEFAULT_TRANSCRIPTION_SETTINGS: TranscriptionSettings = {
  maxUploadBytes: DEFAULT_MAX_UPLOAD_BYTES,
  language: 'ru',
  responseFormat: 'verbose_json',
  requestTimeoutMs: 120_000,
  extractTimeoutMs: 5 * 60_000,
  audioMimeType: TRANSCRIPTION_AUDIO_MIME,
  audioFileName: TRANSCRIPTION_AUDIO_NAME,
  audioCodec: 'aac',
  audioBitrateKbps: 64,
  audioSampleRate: 16_000,
  audioChannels: 1,
}

function positive(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * Собирает параметры: значения по умолчанию + правки. Всё, что может прийти
 * из настроек, здесь причёсывается — дальше по коду значения уже валидные.
 */
export function resolveTranscriptionSettings(
  base: TranscriptionSettings = DEFAULT_TRANSCRIPTION_SETTINGS,
  overrides: Partial<TranscriptionSettings> = {},
): TranscriptionSettings {
  const merged: TranscriptionSettings = { ...base, ...overrides }
  const language = typeof merged.language === 'string' ? merged.language.trim() : ''
  return {
    ...merged,
    maxUploadBytes: positive(merged.maxUploadBytes, DEFAULT_MAX_UPLOAD_BYTES),
    language: language === '' ? DEFAULT_TRANSCRIPTION_SETTINGS.language : language,
    responseFormat: merged.responseFormat === 'json' ? 'json' : 'verbose_json',
    requestTimeoutMs: positive(merged.requestTimeoutMs, DEFAULT_TRANSCRIPTION_SETTINGS.requestTimeoutMs),
    extractTimeoutMs: positive(merged.extractTimeoutMs, DEFAULT_TRANSCRIPTION_SETTINGS.extractTimeoutMs),
    audioMimeType:
      typeof merged.audioMimeType === 'string' && merged.audioMimeType.trim() !== ''
        ? merged.audioMimeType.trim()
        : TRANSCRIPTION_AUDIO_MIME,
    audioFileName:
      typeof merged.audioFileName === 'string' && merged.audioFileName.trim() !== ''
        ? merged.audioFileName.trim()
        : TRANSCRIPTION_AUDIO_NAME,
    audioCodec:
      typeof merged.audioCodec === 'string' && merged.audioCodec.trim() !== ''
        ? merged.audioCodec.trim()
        : 'aac',
    audioBitrateKbps: positive(merged.audioBitrateKbps, 64),
    audioSampleRate: positive(merged.audioSampleRate, 16_000),
    audioChannels:
      merged.audioChannels === 2 ? 2 : DEFAULT_TRANSCRIPTION_SETTINGS.audioChannels,
  }
}

/**
 * Нужно ли вырезать звук: файл больше лимита отправки.
 * Чистая функция — проверяется без ffmpeg и без сети.
 */
export function shouldExtractAudio(sizeBytes: number, settings: TranscriptionSettings): boolean {
  const size = Number.isFinite(sizeBytes) && sizeBytes > 0 ? sizeBytes : 0
  return size > settings.maxUploadBytes
}

/**
 * Аргументы вырезания звука: только звуковая дорожка, моно, 16 кГц, AAC.
 *
 * Видео при этом не трогается вообще — мы работаем с копией внутри
 * виртуальной файловой системы ffmpeg.
 */
export function buildExtractAudioArgs(
  inputName: string,
  outputName: string,
  settings: TranscriptionSettings,
): string[] {
  return [
    '-hide_banner',
    '-y',
    '-i',
    inputName,
    // Видеодорожка не нужна: расшифровываем речь, а не картинку.
    '-vn',
    '-ac',
    String(settings.audioChannels),
    '-ar',
    String(settings.audioSampleRate),
    '-c:a',
    settings.audioCodec,
    '-b:a',
    `${settings.audioBitrateKbps}k`,
    outputName,
  ]
}

/**
 * Аргументы второй попытки: звук копируется как есть (`-c:a copy`).
 *
 * Перекодирование спасает не всегда: если кодека нет в сборке ffmpeg,
 * декодировать дорожку нечем. Копирование декодирования не требует —
 * AAC из mp4 в m4a переносится без потерь. Контейнер тот же, поэтому
 * `-ac`, `-ar` и `-b:a` не задаём: они относятся к перекодированию.
 */
export function buildCopyAudioArgs(inputName: string, outputName: string): string[] {
  return ['-hide_banner', '-y', '-i', inputName, '-vn', '-c:a', 'copy', outputName]
}

// --- Входной файл: смонтировать или скопировать в память ---------------------

/**
 * Файловая система ffmpeg.wasm, которая читает `File`/`Blob` по мере
 * надобности, а не копирует его целиком в кучу wasm.
 *
 * Зачем это нужно (не «упрощать» обратно к `writeFile`!): `fetchFile` +
 * `writeFile` читают весь ролик в память страницы и перекладывают его в кучу
 * wasm. На крупном Instagram-Reels куча кончается, файл во внутренней ФС
 * оказывается неполным — и ffmpeg отвечает `File could not be read! Code=8`
 * (живой случай с телефона). `WORKERFS` монтирует тот же `File` и отдаёт
 * байты демультиплексору по требованию, поэтому размер ролика больше не
 * ограничен кучей wasm.
 */
export const WORKER_FS_TYPE = 'WORKERFS'

/** Каталог, в который монтируется исходник. Создаётся перед монтированием. */
export const WORKER_FS_MOUNT_POINT = '/mnt'

/** Как входной файл попадает во внутреннюю ФС ffmpeg. */
export type AudioInputMode = 'mount' | 'copy'

/** Готовое решение: где лежит входной файл и как он туда попал. */
export interface AudioInputPlan {
  /** `mount` — WORKERFS без копии в кучу; `copy` — прежний `writeFile`. */
  mode: AudioInputMode
  /** Имя файла с настоящим расширением — по нему ffmpeg выбирает демультиплексор. */
  fileName: string
  /** Путь для `-i`: при монтировании `/mnt/<имя>`, при копировании `<имя>`. */
  inputPath: string
  /** Точка монтирования (нужна и для `unmount`). */
  mountPoint: string
}

/**
 * Решение «монтировать или копировать» — чистая функция, проверяется без ffmpeg.
 *
 * Имя берётся из `inputFileNameFor` и сохраняет расширение (`.mp4`, `.webm`,
 * `.mov`): WORKERFS строит путь по `File.name`, а демультиплексору ffmpeg
 * расширение нужно, чтобы понять контейнер. Поэтому имя не «оптимизируем»:
 * монтируем ровно под тем именем, которое вернул `inputFileNameFor`.
 *
 * `mountAvailable === false` — запасной путь: `writeFile`, как раньше. Он
 * нужен, если ядро без WORKERFS, если `mount` бросил исключение или вернул
 * `false`, и если в среде нет конструктора `File` (WORKERFS требует `File`
 * с именем).
 */
export function planAudioInput(
  inputName: string,
  mountAvailable: boolean,
  mountPoint: string = WORKER_FS_MOUNT_POINT,
): AudioInputPlan {
  // Оставляем только имя файла: путь внутри точки монтирования задаёт WORKERFS,
  // а случайный слэш в имени сделал бы путь неверным.
  const base = (inputName ?? '').split(/[\\/]/).pop() ?? ''
  const fileName = base.trim() === '' ? 'muza-input.mp4' : base
  const root = (mountPoint || WORKER_FS_MOUNT_POINT).replace(/\/+$/, '')
  if (!mountAvailable) {
    return { mode: 'copy', fileName, inputPath: fileName, mountPoint: root || '/' }
  }
  return {
    mode: 'mount',
    fileName,
    inputPath: root === '' ? `/${fileName}` : `${root}/${fileName}`,
    mountPoint: root === '' ? '/' : root,
  }
}

/**
 * Похоже на то, что файл вообще не удалось прочитать браузеру.
 *
 * Так выглядит исчерпание памяти при `fetchFile`/WORKERFS: `File could not be
 * read! Code=8` (FileReader, NotReadableError). Это не про кодек и не про
 * контейнер, поэтому человеку нельзя показывать этот текст как причину —
 * сообщение должно объяснять, что ролик слишком велик для браузера.
 */
export function looksLikeUnreadableFileFailure(text: string): boolean {
  return /file could not be read|notreadableerror|code=8\b|the requested file could not be read/i.test(
    text ?? '',
  )
}

// --- Лог ffmpeg: причина отказа ----------------------------------------------

/** Сколько строк лога показываем человеку: больше на телефоне не читается. */
export const FFMPEG_LOG_TAIL_LINES = 3

/** Предел длины одной строки лога в сообщении. */
export const FFMPEG_LOG_LINE_LIMIT = 160

/** Сколько осмысленных строк лога держим в памяти за одну попытку. */
export const FFMPEG_LOG_KEEP = 200

/** Устойчивые признаки того, что ffmpeg объясняет причину отказа. */
const FFMPEG_REASON_RE =
  /(error|fail|invalid|unsupported|unknown|not found|not support|no such|missing|corrupt|truncat|cannot|unable|denied|refused|does not contain|no audio|out of memory|moov atom|end of file|malformed)/i

/** Общая концовка лога: сама по себе ничего не объясняет. */
const FFMPEG_TRAILER_RE = /^conversion failed!?$/i

/** Строка прогресса (`frame=… fps=… time=…`): для причины бесполезна. */
export function isFfmpegProgressLine(line: string): boolean {
  const text = (line ?? '').trim()
  if (text === '') return true
  if (/^(frame|size)=/.test(text)) return true
  return /time=\d+:\d{2}:\d{2}/.test(text) && /(bitrate|speed|fps)=/.test(text)
}

/**
 * Служебная строка ffmpeg: баннер, карта потоков, метаданные контейнера.
 * В причину отказа такие строки не идут — человеку они ничего не объясняют.
 */
export function isFfmpegNoiseLine(line: string): boolean {
  const text = (line ?? '').trim()
  if (text === '') return true
  if (isFfmpegProgressLine(text)) return true
  return (
    /^ffmpeg version/i.test(text) ||
    /^built with/i.test(text) ||
    /^configuration:/i.test(text) ||
    /^lib(av|sw|postproc)/i.test(text) ||
    /^press \[q\]/i.test(text) ||
    /^stream mapping:/i.test(text) ||
    /^(input|output) #/i.test(text) ||
    /^(metadata|duration|stream #|chapter #|encoder|handler_name|vendor_id|major_brand|minor_version|compatible_brands|creation_time|title|artist|comment|album|genre|track|language|rotate|displaymatrix|side data|attached pic|start|bitrate)/i.test(
      text,
    ) ||
    /^\[out#\d+[^\]]*\]\s*(video|audio|subtitle|other|muxing)/i.test(text) ||
    /^last message repeated/i.test(text)
  )
}

/** Осмысленная строка лога: её стоит помнить и показать при сбое. */
export function isMeaningfulFfmpegLine(line: string): boolean {
  return !isFfmpegNoiseLine(line)
}

/** Обрезает строку лога до читаемого на телефоне вида и убирает адрес модуля. */
export function trimFfmpegLine(line: string, limit = FFMPEG_LOG_LINE_LIMIT): string {
  const text = (line ?? '').trim()
  const withoutAddress = text.replace(/^\[[^\]]*\s@\s0x[0-9a-f]+\]\s*/i, '')
  const compact = withoutAddress.replace(/\s+/g, ' ').trim()
  return compact.length > limit ? `${compact.slice(0, limit)}…` : compact
}

/**
 * Последние осмысленные строки лога — те, где ffmpeg объясняет причину.
 *
 * Сначала берём строки с признаками ошибки; если таких нет — просто
 * последние осмысленные. Общую концовку `Conversion failed!` не показываем,
 * когда есть что-то содержательнее. Больше `limit` строк не отдаём:
 * человек читает это на телефоне.
 */
export function pickFfmpegReasonLines(
  lines: readonly string[],
  limit = FFMPEG_LOG_TAIL_LINES,
): string[] {
  const max = Math.max(1, Math.floor(limit))
  const clean: string[] = []
  for (const raw of lines ?? []) {
    const line = trimFfmpegLine(raw)
    if (line === '' || isFfmpegNoiseLine(line)) continue
    if (!clean.includes(line)) clean.push(line)
  }
  const reasons = clean.filter((line) => FFMPEG_REASON_RE.test(line))
  const informative = reasons.filter((line) => !FFMPEG_TRAILER_RE.test(line))
  const picked = informative.length > 0 ? informative : reasons.length > 0 ? reasons : clean
  return picked.slice(-max)
}

/** Похоже на нехватку памяти: повторять бессмысленно, ядро уже негодное. */
export function looksLikeMemoryFailure(text: string): boolean {
  return /out of memory|cannot enlarge memory|allocation failed|memory access out of bounds|failed to allocate|aborted\(/i.test(
    text ?? '',
  )
}

/** Понятная причина отказа по строкам лога — без технического жаргона. */
export function describeFfmpegFailure(lines: readonly string[]): string {
  const text = (lines ?? []).join(' ')
  if (looksLikeMemoryFailure(text)) return 'браузеру не хватило памяти'
  if (/does not contain any stream|matches no streams|no audio stream|output file is empty/i.test(text)) {
    return 'в файле не нашлась звуковая дорожка'
  }
  if (
    /unsupported codec|decoder .*not found|encoder .*not found|unknown decoder|no decoder|not supported|does not support/i.test(
      text,
    )
  ) {
    return 'ffmpeg не умеет кодек звука в этом файле'
  }
  if (
    /moov atom not found|invalid data found|unknown format|could not find codec parameters|error opening input|no such file|end of file|corrupt|truncated|invalid argument/i.test(
      text,
    )
  ) {
    return 'ffmpeg не понял формат файла — возможно, он повреждён или записан в необычном формате'
  }
  return 'ffmpeg не смог обработать запись'
}

/**
 * Готовое сообщение о сбое вырезания: понятная причина и — отдельной
 * строкой — то, что сказал ffmpeg. Код выхода остаётся для диагностики,
 * но перестаёт быть единственным объяснением.
 */
export function buildExtractFailureMessage(
  lines: readonly string[],
  exitCode: number | null = null,
): string {
  const reason = pickFfmpegReasonLines(lines)
  const hint = describeFfmpegFailure(reason)
  const code = exitCode === null ? '' : ` (код ${exitCode})`
  const head =
    reason.length > 0
      ? `Не удалось вырезать звук: ${hint}.`
      : `Не удалось вырезать звук: ${hint}${code}.`
  const detail = reason.length > 0 ? `\nПричина${code}: ${reason.join(' · ')}` : ''
  return (
    `${head} Оригинал не тронут — идея и файл на месте. ` +
    `Можно отправить голосовую заметку.${detail}`
  )
}

// --- Решение о второй попытке ------------------------------------------------

/** Из-за чего попытка вырезания не удалась: от этого зависит повтор. */
export interface ExtractionFailure {
  /** Работу отменил вызывающий код. */
  aborted: boolean
  /** Вырезание не уложилось в отведённое время. */
  timedOut: boolean
  /** Браузеру не хватило памяти. */
  outOfMemory: boolean
}

/**
 * Стоит ли после неудачного перекодирования пробовать копирование дорожки.
 *
 * При отмене, таймауте и нехватке памяти — нет: состояние ядра ffmpeg
 * негодное, и повтор только съест время. Копирование декодирования
 * не требует, поэтому при отказе из-за кодека или контейнера оно осмысленно.
 */
export function canRetryExtractionWithCopy(failure: ExtractionFailure): boolean {
  return !failure.aborted && !failure.timedOut && !failure.outOfMemory
}

// --- Язык записи: русская речь или нет ---------------------------------------

/**
 * Сколько букв должно быть в тексте, чтобы вообще судить о языке.
 *
 * Порог 20. Меньше — доля кириллицы случайна: в «Привет» её 100%, в
 * «USB» — 0%, и по такому тексту решение о языке было бы гаданием.
 * Пока букв мало, считаем запись русской: это основной случай, и
 * ошибиться в сторону «не тратить лишний запрос» безопаснее.
 */
export const LANGUAGE_MIN_LETTERS = 20

/**
 * Доля кириллицы среди букв, ниже которой запись считается нерусской.
 *
 * GigaAM на английской речи выдаёт **латиницу**, а не кириллицу
 * («you don't nee to pay…»), поэтому нерусский текст виден сразу.
 * Порог 20%, а не «ровно ноль»: одно русское имя или слово в английской
 * речи не должны переключать модель — из-за этого мы бы платили дважды
 * за русские записи с латинскими терминами.
 */
export const LANGUAGE_CYRILLIC_MIN_SHARE = 0.2

/** Все буквы текста, любой письменности: цифры и знаки не считаются. */
const LETTER_RE = /\p{L}/gu

/** Буквы кириллицы: по ним и решается, русская ли речь. */
const CYRILLIC_RE = /\p{Script=Cyrillic}/gu

/**
 * Сколько в тексте букв и сколько из них кириллица.
 *
 * Считаем именно буквы, а не символы: «1 000 ₽» и «!!!» о языке не говорят
 * ничего, и в долю они попадать не должны.
 */
export function countTextLetters(text: string): { letters: number; cyrillic: number } {
  const value = typeof text === 'string' ? text : ''
  return {
    letters: value.match(LETTER_RE)?.length ?? 0,
    cyrillic: value.match(CYRILLIC_RE)?.length ?? 0,
  }
}

/**
 * Язык записи по тексту основной модели.
 *
 * Порядок «сначала расшифровать, потом решать» выбран намеренно: чтобы
 * узнать язык, текст всё равно нужен, а русская речь — основной случай.
 * Так русский путь не платит за определение языка вообще ничего.
 */
export function detectTranscriptionLanguage(text: string): TranscriptionLanguage {
  const { letters, cyrillic } = countTextLetters(text)
  if (letters < LANGUAGE_MIN_LETTERS) return 'unknown'
  return cyrillic / letters < LANGUAGE_CYRILLIC_MIN_SHARE ? 'other' : 'ru'
}

/**
 * Человеческое имя модели распознавания — без идентификаторов провайдера.
 *
 * Сработавшую модель показываем человеку: «русская модель» или «общая
 * модель» понятнее, чем `ai-sage/gigaam-v3`. Незнакомую модель называем
 * её именем: выдумывать ей описание нечестно.
 */
export function describeTranscriptionModel(
  model: string,
  language: TranscriptionLanguage,
  usedFallback: boolean,
): string {
  const id = typeof model === 'string' ? model.trim() : ''
  const name =
    id === ''
      ? 'модель распознавания'
      : /gigaam/i.test(id)
        ? 'русская модель'
        : /whisper/i.test(id)
          ? 'общая модель'
          : `модель ${id}`
  if (usedFallback) return `Распознано: ${name} — речь не на русском.`
  if (language === 'other') return `Распознано: ${name} — возможно, речь не на русском.`
  return `Распознано: ${name}.`
}
