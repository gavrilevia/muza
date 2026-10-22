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
