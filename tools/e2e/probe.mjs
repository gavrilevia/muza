/**
 * Проверка того, что ЛЕГЛО В БАЗУ, а не того, что написано на экране.
 *
 * ЗАЧЕМ ЭТО ПОЯВИЛОСЬ. В одной сессии я ТРИ РАЗА получил «зелёные» тесты
 * при неработающей функции: тест искал текст на странице, находил его —
 * и считал, что всё хорошо. А материал в базу не записывался. Человек
 * видел бы пустое место, тест — «успех».
 *
 * Отсюда правило: браузерная проверка утверждает о ДАННЫХ и о ФАКТЕ
 * ПОЯВЛЕНИЯ элемента, а не о формулировках. Текст меняется по десять раз
 * на дню и ничего не доказывает.
 *
 * Что считается хорошей проверкой:
 *   ✔ material записался в базу и у него есть uri
 *   ✔ блок появился в разметке
 *   ✔ кнопка сработала: статус идеи изменился
 *
 * Что считается плохой:
 *   ✖ на странице есть слова «Запишите экран»
 *   ✖ абзац совпадает с ожидаемой строкой
 *   ✖ заголовок называется ровно так
 */

/** Открывает базу Музы в странице и забирает содержимое хранилищ. */
export async function readDb(page, stores = ['ideas', 'materials', 'meta', 'history']) {
  return page.evaluate(async (names) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('muza')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const result = {}
    for (const name of names) {
      if (!db.objectStoreNames.contains(name)) {
        result[name] = []
        continue
      }
      result[name] = await new Promise((resolve) => {
        const request = db.transaction(name, 'readonly').objectStore(name).getAll()
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => resolve([])
      })
    }
    return result
  }, stores)
}

/**
 * Ждёт, пока условие по базе выполнится.
 *
 * Нужен, потому что запись асинхронная: сразу после нажатия в базе ещё
 * пусто, и проверка «сразу» даёт ложный провал. Ждём ФАКТА, а не паузы
 * наугад — `waitForTimeout(2000)` и медленно, и ненадёжно.
 */
export async function waitForDb(page, predicate, { timeoutMs = 8000, intervalMs = 200 } = {}) {
  const started = Date.now()
  let last = null
  while (Date.now() - started < timeoutMs) {
    last = await readDb(page)
    try {
      if (predicate(last)) return last
    } catch {
      /* условие может упасть на промежуточном состоянии — это нормально */
    }
    await page.waitForTimeout(intervalMs)
  }
  return last
}

/** Сколько записей в хранилище. */
export function count(db, store) {
  return Array.isArray(db?.[store]) ? db[store].length : 0
}

/** Первый материал, подходящий под условие. */
export function findMaterial(db, predicate = () => true) {
  return (db?.materials ?? []).find(predicate) ?? null
}

/** Первая идея, подходящая под условие. */
export function findIdea(db, predicate = () => true) {
  return (db?.ideas ?? []).find(predicate) ?? null
}
