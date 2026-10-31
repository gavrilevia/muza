/**
 * EXIF: когда снят файл и где.
 *
 * Зачем: `added_at` — это когда файл попал в Музу, а идея часто родилась
 * **раньше**. Снимок из отпуска, загруженный через месяц, должен помнить,
 * что он из отпуска, — иначе момент не поставить, а «древо» врёт о времени.
 *
 * Читаем **сами**, без библиотек: нужны всего две вещи — дата съёмки и
 * координаты, — а тащить ради этого зависимость в приложение, которое
 * обещает работать офлайн, неразумно.
 *
 * Ничего не бросаем: нет EXIF, битый файл, не JPEG — просто `null`.
 * Отсутствие даты не повод терять идею.
 */

/** Что удалось прочитать из файла. */
export interface ExifInfo {
  /** Когда снят: ISO-строка. */
  at: string | null
  /** Где снят: координаты. Название места не спрашиваем — это уже сеть. */
  place: { lat: number; lon: number } | null
}

const EMPTY: ExifInfo = { at: null, place: null }

/** Читает EXIF из картинки. Для не-картинок и при любой ошибке — пусто. */
export async function readExif(blob: Blob): Promise<ExifInfo> {
  try {
    // Хватает первых 128 КБ: EXIF лежит в начале файла. Читать целое
    // фото с телефона (10 МБ) ради пары тегов незачем.
    const head = await blob.slice(0, 131_072).arrayBuffer()
    return parseExif(new DataView(head))
  } catch {
    return EMPTY
  }
}

/** Разбирает JPEG: ищет APP1 с «Exif» и читает нужные теги. */
export function parseExif(view: DataView): ExifInfo {
  // JPEG начинается с FFD8.
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return EMPTY

  let offset = 2
  while (offset + 4 <= view.byteLength) {
    if (view.getUint8(offset) !== 0xff) break
    const marker = view.getUint8(offset + 1)
    // Конец изображения или начало сжатых данных — дальше EXIF не ищем.
    if (marker === 0xda || marker === 0xd9) break
    const size = view.getUint16(offset + 2)
    if (size < 2) break

    if (marker === 0xe1 && matchesExifHeader(view, offset + 4)) {
      return readTiff(view, offset + 10)
    }
    offset += 2 + size
  }
  return EMPTY
}

/** Проверяет сигнатуру «Exif\0\0» в начале APP1. */
function matchesExifHeader(view: DataView, at: number): boolean {
  if (at + 6 > view.byteLength) return false
  return (
    view.getUint8(at) === 0x45 && // E
    view.getUint8(at + 1) === 0x78 && // x
    view.getUint8(at + 2) === 0x69 && // i
    view.getUint8(at + 3) === 0x66 && // f
    view.getUint8(at + 4) === 0x00 &&
    view.getUint8(at + 5) === 0x00
  )
}

/** Читает TIFF-заголовок и два нужных IFD: съёмку и координаты. */
function readTiff(view: DataView, start: number): ExifInfo {
  if (start + 8 > view.byteLength) return EMPTY
  const order = view.getUint16(start)
  // «II» — младший байт вперёд, «MM» — старший.
  const little = order === 0x4949
  if (!little && order !== 0x4d4d) return EMPTY

  const u16 = (at: number): number => view.getUint16(at, little)
  const u32 = (at: number): number => view.getUint32(at, little)
  if (u16(start + 2) !== 42) return EMPTY

  const ifd0 = start + u32(start + 4)
  let at: string | null = null
  let place: { lat: number; lon: number } | null = null

  for (const entry of entries(view, ifd0, u16, u32)) {
    // 0x8769 — указатель на IFD со съёмочными данными.
    if (entry.tag === 0x8769) {
      for (const sub of entries(view, start + entry.value, u16, u32)) {
        if (sub.tag === 0x9003) at = readAscii(view, start, sub, little)
      }
    }
    // 0x8825 — указатель на IFD с координатами.
    if (entry.tag === 0x8825) {
      place = readGps(view, start, start + entry.value, u16, u32)
    }
  }

  return { at: normalizeDate(at), place }
}

interface Entry {
  tag: number
  type: number
  count: number
  value: number
}

/** Разбирает таблицу тегов IFD. */
function entries(
  view: DataView,
  at: number,
  u16: (at: number) => number,
  u32: (at: number) => number,
): Entry[] {
  if (at + 2 > view.byteLength) return []
  const count = u16(at)
  const result: Entry[] = []
  for (let i = 0; i < count; i += 1) {
    const base = at + 2 + i * 12
    if (base + 12 > view.byteLength) break
    result.push({
      tag: u16(base),
      type: u16(base + 2),
      count: u32(base + 4),
      // Значение: если не влезает в 4 байта — это смещение.
      value: u32(base + 8),
    })
  }
  return result
}

/** Строка ASCII по смещению. */
function readAscii(view: DataView, tiffStart: number, entry: Entry, little: boolean): string {
  const length = entry.count
  const at =
    length <= 4 ? tiffStart : tiffStart + (little ? entry.value : entry.value)
  // Значение длиной до 4 байт лежит прямо в записи — но для даты
  // («2026:10:12 14:30:00» — 19 байт) это всегда смещение.
  const start = length <= 4 ? 0 : at
  if (length <= 4) return ''
  let text = ''
  for (let i = 0; i < length; i += 1) {
    const index = start + i
    if (index >= view.byteLength) break
    const code = view.getUint8(index)
    if (code === 0) break
    text += String.fromCharCode(code)
  }
  return text
}

/** Координаты: три дроби и буква полушария. */
function readGps(
  view: DataView,
  tiffStart: number,
  gpsAt: number,
  u16: (at: number) => number,
  u32: (at: number) => number,
): { lat: number; lon: number } | null {
  if (gpsAt + 2 > view.byteLength) return null
  let lat: number | null = null
  let lon: number | null = null
  let latRef = 'N'
  let lonRef = 'E'

  const list = entries(view, gpsAt, u16, u32)
  for (const entry of list) {
    if (entry.tag === 1 || entry.tag === 3) {
      const text = readGpsString(view, entry, tiffStart)
      if (entry.tag === 1 && text !== '') latRef = text
      if (entry.tag === 3 && text !== '') lonRef = text
    }
    if (entry.tag === 2) lat = readGpsDegrees(view, entry, tiffStart)
    if (entry.tag === 4) lon = readGpsDegrees(view, entry, tiffStart)
  }

  if (lat === null || lon === null) return null
  if (latRef.toUpperCase() === 'S') lat = -lat
  if (lonRef.toUpperCase() === 'W') lon = -lon
  // Мусорные координаты отбрасываем: ноль-ноль — это Атлантика, а не место.
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null
  return { lat, lon }
}

function readGpsString(view: DataView, entry: Entry, tiffStart: number): string {
  // Смещения внутри GPS считаются от НАЧАЛА TIFF, а не от начала файла.
  const at = tiffStart + entry.value
  if (at >= view.byteLength) return ''
  const code = view.getUint8(at)
  return code === 0 ? '' : String.fromCharCode(code)
}

/** Три рациональных числа: градусы, минуты, секунды. */
function readGpsDegrees(view: DataView, entry: Entry, tiffStart: number): number | null {
  const at = tiffStart + entry.value
  if (at + 24 > view.byteLength) return null
  const parts: number[] = []
  for (let i = 0; i < 3; i += 1) {
    const base = at + i * 8
    const numerator = view.getUint32(base)
    const denominator = view.getUint32(base + 4)
    if (denominator === 0) return null
    parts.push(numerator / denominator)
  }
  const [degrees = 0, minutes = 0, seconds = 0] = parts
  return degrees + minutes / 60 + seconds / 3600
}

/** «2026:10:12 14:30:00» → ISO. Некорректную строку отбрасываем. */
export function normalizeDate(raw: string | null): string | null {
  if (!raw) return null
  const match = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(raw.trim())
  if (!match) return null
  const [, year, month, day, hour, minute, second] = match
  // Местное время съёмки без часового пояса: камера его не пишет.
  const date = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  )
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString()
}
