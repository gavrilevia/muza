/**
 * «Проверить ключ» — один дешёвый запрос к модели.
 *
 * Проверка не должна стоить как разбор идей, поэтому ответ просим короткий.
 *
 * ⚠️ Но `max_tokens` не должен быть крошечным: `deepseek/deepseek-v4.1-flash`
 * — рассуждающая модель, и при 8 токенах она тратила весь бюджет на
 * внутреннее рассуждение, возвращая **пустой ответ**. Рассуждение мы теперь
 * выключаем (`reasoningEffort: 'none'`), а лимит держим с запасом — 256 токенов
 * стоят доли копейки и снимают этот отказ целиком.
 *
 * Рабочий ключ отличается от нерабочего по коду ошибки: 401/403 приходят
 * как `http` с текстом провайдера, обрыв сети — как `network`, отсутствие
 * ключа — как `no_key` (запрос не уходит).
 */

import type { LlmClient, LlmErrorCode } from '../ai'

/** Итог проверки: годится ли ключ и сколько это стоило. */
export interface KeyCheckResult {
  ok: boolean
  code: LlmErrorCode | null
  message: string
  costRub: number
}

/** Один дешёвый запрос. Сеть не трогается, если ключа нет. */
export async function checkApiKey(
  client: LlmClient,
  options: { timeoutMs?: number } = {},
): Promise<KeyCheckResult> {
  if (!client.hasKey()) {
    return {
      ok: false,
      code: 'no_key',
      message: 'Ключ не задан: вставьте ключ polza.ai и сохраните его.',
      costRub: 0,
    }
  }

  try {
    const result = await client.chat([{ role: 'user', content: 'Ответь одним словом: работает' }], {
      task: 'key_check',
      maxTokens: 256,
      temperature: 0,
      timeoutMs: options.timeoutMs ?? 15_000,
    })

    if (result.ok) {
      return {
        ok: true,
        code: null,
        message: 'Ключ работает: модель ответила.',
        costRub: result.usage.costRub,
      }
    }
    return {
      ok: false,
      code: result.error.code,
      message: result.error.message,
      costRub: result.usage.costRub,
    }
  } catch (e) {
    // Клиент не должен бросать, но проверка ключа не имеет права уронить экран.
    return {
      ok: false,
      code: 'network',
      message: e instanceof Error ? `Сбой проверки: ${e.message}` : 'Сбой проверки ключа.',
      costRub: 0,
    }
  }
}
