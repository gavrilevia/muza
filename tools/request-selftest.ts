/**
 * Временная проверка: что реально уходит в запросе к модели.
 *
 * Причина появления: `deepseek/deepseek-v4.1-flash` — рассуждающая модель.
 * Без `reasoning_effort` она тратила бюджет на размышление и возвращала
 * пустой ответ. Здесь проверяем, что параметр уходит, а модель — с префиксом.
 */
import { LlmClient } from '../src/ai/LlmClient'
import { createLlmConfig, DEFAULT_MODEL } from '../src/ai/config'
import { checkApiKey } from '../src/directions/keyCheck'

let pass = 0
let fail = 0
const ok = (name: string, cond: unknown, extra = '') => {
  if (cond) { pass++; console.log(`  ✔ ${name}${extra ? ' — ' + extra : ''}`) }
  else { fail++; console.log(`  ✘ ${name}${extra ? ' — ' + extra : ''}`) }
}

type Seen = { url: string; body: Record<string, unknown> }

function makeClient(answer = 'работает', seen: Seen[] = []): { client: LlmClient; seen: Seen[] } {
  const fetchImpl = async (url: unknown, init: { body?: unknown } = {}): Promise<Response> => {
    seen.push({ url: String(url), body: JSON.parse(String(init.body ?? '{}')) })
    return new Response(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
        model: DEFAULT_MODEL,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  const config = createLlmConfig({ apiKey: 'test-key', retryDelayMs: 1 })
  return { client: new LlmClient(config, { fetch: fetchImpl as unknown as typeof fetch }), seen }
}

async function main() {
  // 1. Проверка ключа: ровно то, что падало на телефоне.
  {
    const { client, seen } = makeClient()
    const result = await checkApiKey(client)
    ok('проверка ключа прошла', result.ok, result.ok ? result.message : `${result.code}: ${result.message}`)
    const body = seen[0]?.body ?? {}
    ok('reasoning_effort отправлен', body.reasoning_effort === 'none', JSON.stringify(body.reasoning_effort))
    ok('модель с префиксом провайдера', body.model === 'deepseek/deepseek-v4.1-flash', String(body.model))
    ok('лимит токенов с запасом', Number(body.max_tokens) >= 32, String(body.max_tokens))
    ok('адрес верный', seen[0]?.url === 'https://polza.ai/api/v1/chat/completions', String(seen[0]?.url))
  }

  // 2. Разбор идеи: тот же параметр и режим JSON.
  {
    const { client, seen } = makeClient('{"title":"Тест"}')
    await client.chat([{ role: 'user', content: 'разложи' }], { task: 'classify', json: true })
    const body = seen[0]?.body ?? {}
    ok('в разборе reasoning_effort тоже есть', body.reasoning_effort === 'none', JSON.stringify(body.reasoning_effort))
    ok('режим JSON включён', JSON.stringify(body.response_format) === '{"type":"json_object"}', JSON.stringify(body.response_format))
  }

  // 3. Возможность отключить параметр (для моделей без поддержки).
  {
    const seen: Seen[] = []
    const fetchImpl = async (url: unknown, init: { body?: unknown } = {}) => {
      seen.push({ url: String(url), body: JSON.parse(String(init.body ?? '{}')) })
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 })
    }
    const config = createLlmConfig({ apiKey: 'k', reasoningEffort: null, retryDelayMs: 1 })
    const client = new LlmClient(config, { fetch: fetchImpl as unknown as typeof fetch })
    await client.chat([{ role: 'user', content: 'привет' }], { task: 'key_check' })
    ok('null — параметр не отправляется', !('reasoning_effort' in (seen[0]?.body ?? {})), JSON.stringify(seen[0]?.body))
  }

  // 4. Пустой ответ объясняется понятно.
  {
    const { client } = makeClient('')
    const result = await checkApiKey(client)
    ok('пустой ответ — понятный отказ', result.ok === false, `${result.code}: ${result.message}`)
  }

  console.log('--------------------------------------------')
  console.log(`Пройдено: ${pass}   Провалено: ${fail}`)
  process.exit(fail > 0 ? 1 : 0)
}

void main()
