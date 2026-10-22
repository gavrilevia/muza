/**
 * Типы сервиса направлений (задача 5, АГЕНТЫ-РАЗРАБОТКИ.md).
 *
 * Сервис отвечает за одно: разложить бытовые идеи по понятным направлениям
 * и не потерять при этом ни одной идеи. Модель — только советчик: если она
 * не уверена, идея остаётся в инбоксе и ждёт человека.
 */

import type { LlmClient, LlmErrorCode, LlmUsage, MetaStore } from '../ai'
import type { Direction, DirectionStore, IdeaRepository } from '../data'

/**
 * Чем закончилась обработка одной идеи.
 *
 * `failed` и `low_confidence` — НЕ потеря: идея как была в базе, так и
 * осталась, просто без направления.
 */
export type AssignStatus =
  /** Направление присвоено (возможно, направление создано). */
  | 'assigned'
  /** Направление у идеи уже было — модель не звали. */
  | 'already'
  /** Уверенность модели ниже порога (0.5) — направление не присваиваем. */
  | 'low_confidence'
  /** Текста нет — классифицировать нечего, запрос не уходит. */
  | 'empty'
  /** ИИ отключён для этой идеи (`ai_opt_out`) или идея удалена. */
  | 'skipped'
  /** Достигнут лимит направлений, а похожего среди них не нашлось. */
  | 'limit'
  /** Модель, сеть, ключ или схема ответа — идея не тронута. */
  | 'failed'

/** Что сервис знает про одну обработанную идею. */
export interface AssignOutcome {
  idea_id: string
  status: AssignStatus
  /** Итоговое направление: id или null. */
  direction_id: string | null
  /** Имя направления — чтобы интерфейс показал его без второго чтения базы. */
  direction_name: string | null
  /** Что предлагала модель, даже если уверенность ниже порога. */
  suggested_direction: string | null
  /** true — направление завели в этой же обработке. */
  created_direction: boolean
  /** Уверенность модели (до порога); null — модель не отвечала. */
  confidence: number | null
  /** Расход именно этой обработки. */
  usage: LlmUsage
  costRub: number
  error_code: LlmErrorCode | null
  error_message: string | null
  /** Одна фраза для журнала и интерфейса: почему так вышло. */
  reason: string
  /**
   * Сколько раз обратились к модели по этой идее: 0 или 1.
   * Больше одного раза на идею сервис не ходит (АГЕНТЫ-РАЗРАБОТКИ.md, задача 5).
   */
  requests: number
}

/** Необязательные условия одной обработки. */
export interface AssignOptions {
  /**
   * Заранее прочитанный список направлений.
   * Пакетная обработка читает его один раз, а не на каждую идею.
   */
  directions?: readonly Direction[]
  /** Отмена: текущая идея дойдёт до конца, следующие не начнутся. */
  signal?: AbortSignal
  /** Свой таймаут на запрос, мс. */
  timeoutMs?: number
  /** Переспросить модель, даже если направление уже есть. */
  force?: boolean
}

/** Прогресс пакетной обработки — для строки «разложено 3 из 10». */
export interface AssignmentProgress {
  done: number
  total: number
  assigned: number
  costRub: number
  last: AssignOutcome
}

/** Почему пакетная обработка остановилась досрочно. */
export type AssignStopReason = 'no_key' | 'budget' | 'aborted' | null

/** Итог пакетной обработки: цифры для экрана и расходы. */
export interface AssignManyResult {
  outcomes: AssignOutcome[]
  total: number
  assigned: number
  lowConfidence: number
  skipped: number
  failed: number
  /** Сколько новых направлений завели. */
  createdDirections: number
  /** Расход всей обработки, ₽. */
  costRub: number
  /** Сколько идей осталось без направления после обработки. */
  unassigned: number
  stopped: boolean
  stopReason: AssignStopReason
  /** Что сделал `enforceLimits` в конце обработки; null — лимиты не проверяли. */
  limits: EnforceLimitsResult | null
}

/** Итог слияния двух направлений. */
export interface MergeResult {
  ok: boolean
  from: string
  into: string
  /** Сколько идей переехало; если слияние оборвалось — сколько успело. */
  movedIdeas: number
  /** Сколько идей переехать не удалось (они остались в прежнем направлении). */
  failedIdeas: number
  /** Удалено ли исходное направление (только если переехали все идеи). */
  removed: boolean
  reason: string
}

/** Что сделал `enforceLimits`. */
export interface EnforceLimitsResult {
  ok: boolean
  /** Сколько направлений осталось. */
  directionCount: number
  /** Удалённые пустые направления (id). */
  removed: string[]
  /** Слияния сверх лимита. */
  merged: Array<{ from: string; into: string; movedIdeas: number }>
  movedIdeas: number
  reason: string
}

/** Предложение нового направления — кандидат, а не готовая запись. */
export interface SuggestNewResult {
  ok: boolean
  name: string | null
  reasoning: string
  confidence: number | null
  usage: LlmUsage
  costRub: number
  error_code: LlmErrorCode | null
  reason: string
}

/** Всё, что сервис берёт из внешнего мира. Всё необязательно: по умолчанию — боевые. */
export interface DirectionServiceOptions {
  /** Репозиторий идей (слой данных). */
  ideas?: IdeaRepository
  /** Хранилище направлений (слой данных). */
  directions?: DirectionStore
  /** Хранилище настроек `meta` — оттуда берётся ключ. */
  store?: MetaStore
  /**
   * Клиент ИИ или функция, которая его собирает.
   * Функция вызывается заново перед каждой обработкой: если пользователь
   * заменил ключ, следующий запуск возьмёт уже новый.
   */
  client?: LlmClient | (() => Promise<LlmClient>)
  /** Максимум направлений (по умолчанию 9). */
  maxDirections?: number
}
