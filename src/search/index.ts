/**
 * Точка входа модуля поиска.
 *
 * Интерфейсу нужен только сервис:
 *
 *   import { searchService } from './search'
 *
 *   const hits = await searchService.search('аэрогриль')
 *   // [{ id, title, status, score, terms, fields }, …]
 *
 * Индекс живёт в памяти и хранится в `meta` под ключом `search.index.v1`.
 * При первом обращении сервис сам читает сохранённый индекс, а если его нет,
 * он устарел или битый — собирает заново. Перезагрузка страницы пересборки
 * не требует.
 *
 * После создания, правки и удаления идеи сервис надо позвать — тогда индекс
 * обновится по одной записи, без полной пересборки:
 *
 *   const idea = await ideaRepository.create({ title: 'Аэрогриль' })
 *   await searchService.indexIdea(idea)
 *
 *   const updated = await ideaRepository.update(idea.id, { title: 'Аэрогриль XL' })
 *   await searchService.indexIdea(updated)
 *
 *   await ideaRepository.remove(idea.id)
 *   await searchService.removeIdea(idea.id)
 *
 * `build()` — полная пересборка: смена версии индекса, импорт копии,
 * «данные и индекс разошлись». `indexMaterial` / `removeMaterial` — то же
 * для `extracted_text` материалов.
 *
 * Ни сети, ни ИИ здесь нет: это поиск по слову (АРХИТЕКТУРА-PWA.md,
 * раздел 3.3).
 */

export { SEARCH_INDEX_KEY, SEARCH_INDEX_VERSION, SearchService, searchService } from './SearchService'
export type {
  SearchCombine,
  SearchField,
  SearchFuzzyRule,
  SearchHit,
  SearchPrefixRule,
  SearchQueryOptions,
  SearchStats,
} from './types'
