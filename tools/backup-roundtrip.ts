/**
 * Проверка выгрузки файлов в zip: байты и тип обязаны пережить круг.
 *
 * Запуск:
 *   node_modules/.bin/rolldown tools/backup-roundtrip.ts -o node_modules/.tmp/backup.mjs --format esm
 *   node node_modules/.tmp/backup.mjs
 *
 * Зачем отдельно от `data-selftest.ts`: это регрессия на **потерю данных**.
 * Раньше при выгрузке `Blob` превращался в `{}` — файлы пользователя
 * (фото, голосовые заметки) уничтожались молча, а в архиве оставался мусор.
 * Проверка держит этот случай закрытым.
 *
 * IndexedDB здесь не нужна: проверяются чистые функции формата архива.
 */

import {
  buildBackup,
  buildBackupZip,
  normalizeMaterial,
  parseBackupZip,
} from '../src/data'
import type { BackupData } from '../src/data'

let passed = 0
const failures: string[] = []

function check(name: string, condition: boolean, extra = ''): void {
  if (condition) {
    passed++
    console.log(`  ✔ ${name}${extra ? ' — ' + extra : ''}`)
  } else {
    failures.push(name)
    console.log(`  ✘ ${name}${extra ? ' — ' + extra : ''}`)
  }
}

function equal(name: string, got: unknown, want: unknown): void {
  check(name, Object.is(got, want), got === want ? String(want) : `получено ${String(got)}, ожидалось ${String(want)}`)
}

/** Данные для архива: одна идея и один материал с настоящим файлом. */
function makeData(): BackupData {
  const bytes = new Uint8Array(256)
  for (let i = 0; i < bytes.length; i++) bytes[i] = i

  const material = normalizeMaterial({
    idea_id: 'idea-1',
    kind: 'image',
    title: 'фото.png',
    blob: new Blob([bytes], { type: 'image/png' }),
  })

  return {
    ideas: [],
    directions: [],
    history: [],
    materials: [material],
    meta: [],
  }
}

// --- Проверка ---------------------------------------------------------------

console.log('\n== Тип файла выводится из самого файла')

const data = makeData()
const material = data.materials[0]

equal('mime взят у Blob', material.mime, 'image/png')
check('содержимое на месте', material.blob instanceof Blob, `${material.blob?.size} байт`)

console.log('\n== Архив')

const file = buildBackup(data, '2026-10-21T00:00:00.000Z')
const archive = await buildBackupZip(file)

check(
  'это zip по сигнатуре PK',
  archive[0] === 0x50 && archive[1] === 0x4b,
  `байты: ${archive[0]},${archive[1]}`,
)
check('архив не пустой', archive.length > 200, `${archive.length} байт`)

const asLatin = new TextDecoder('latin1').decode(archive)
check('в архиве НЕТ мусорного поля "blob"', !asLatin.includes('"blob"'))
check('записи материалов лежат отдельно', asLatin.includes('materials.json'))
check('имя файла-блоба есть в архиве', asLatin.includes(`blobs/${material.id}`))

console.log('\n== Обратное чтение')

const restored = await parseBackupZip(archive)
const back = restored.materials[0]

check('материал вернулся', !!back)
check('blob восстановлен как Blob', back?.blob instanceof Blob)
equal('размер совпал', back?.blob?.size, 256)
equal('тип в записи сохранён', back?.mime, 'image/png')
equal('тип у самого Blob', back?.blob?.type, 'image/png')

if (back?.blob) {
  const original = new Uint8Array(await (material.blob as Blob).arrayBuffer())
  const got = new Uint8Array(await back.blob.arrayBuffer())
  let same = got.length === original.length
  let firstDiff = -1
  for (let i = 0; same && i < got.length; i++) {
    if (got[i] !== original[i]) {
      same = false
      firstDiff = i
    }
  }
  check(
    'БАЙТЫ СОВПАЛИ ПОЛНОСТЬЮ (все 256 значений)',
    same,
    firstDiff >= 0 ? `расхождение на ${firstDiff}` : 'совпали',
  )
}

console.log('\n== Мусор вместо файла не проходит')

const junk = normalizeMaterial({ idea_id: 'idea-2', kind: 'text', blob: {} as unknown as Blob })
check('объект вместо Blob отброшен', junk.blob === undefined)
check('и mime не выдуман', !junk.mime)

// --- Итог -------------------------------------------------------------------

console.log(`\n${'-'.repeat(60)}`)
if (failures.length > 0) {
  console.log(`ПРОВАЛЕНО: ${failures.length}, пройдено: ${passed}`)
  for (const failure of failures) console.log(`  • ${failure}`)
  process.exit(1)
} else {
  console.log(`Все проверки пройдены: ${passed}`)
}