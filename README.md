# @the-arj/ai-kit

> AI toolkit for Node.js — tool schema generation, prompt safety, and cost guardrails.

Three focused modules, zero shared runtime dependencies, full TypeScript types.

```ts
import { toolSchema }  from '@the-arj/ai-kit/tool-schema'
import { promptSafe }  from '@the-arj/ai-kit/prompt-safe'
import { costGuard }   from '@the-arj/ai-kit/cost-guard'
```

---

## Install

```sh
npm install @the-arj/ai-kit
```

Requires **Node.js ≥ 18**.

---

## Modules

### `tool-schema` — Generate LLM function-calling schemas

No compiler plugins. No decorators. No build-step changes. Describe your tool in a plain object and get the exact JSON Schema each provider expects.

**Works with:** OpenAI, Anthropic, Google Gemini, Groq, Mistral, any OpenAPI-compatible LLM.

```ts
import { toolSchema, toolSchemaAll } from '@the-arj/ai-kit/tool-schema'

const schema = toolSchema({
  name: 'get_weather',
  description: 'Get current weather for a city',
  params: {
    city: { type: 'string', description: 'City name' },
    unit: { type: 'string', enum: ['C', 'F'], required: false },
  },
}, 'openai')

// → { type: 'function', function: { name, description, parameters: { ... } } }
```

Generate for all providers at once:

```ts
const { openai, anthropic, gemini, generic } = toolSchemaAll(meta)
```

#### Supported providers

| Provider | Output shape |
|---|---|
| `'openai'` | `{ type: 'function', function: { name, description, parameters } }` |
| `'anthropic'` | `{ name, description, input_schema }` |
| `'gemini'` | `{ functionDeclarations: [{ name, description, parameters }] }` |
| `'generic'` | `{ name, description, parameters }` |

---

### `prompt-safe` — Prompt injection, jailbreak, and PII detection

Runs **client-side before any API call**. No network requests, no telemetry.

**Works with:** Any LLM — runs before you send the prompt.

```ts
import { promptSafe, PromptViolationError } from '@the-arj/ai-kit/prompt-safe'

// Scan
const result = promptSafe(userInput)
// { safe: false, violations: [{ type: 'injection', label: 'ignore_instructions', match: '...' }] }

// Redact PII in-place
const clean = promptSafe.redact(userInput)
// "Contact [REDACTED_EMAIL] or call [REDACTED_PHONE]"

// Throw on violation
promptSafe.assert(userInput)  // throws PromptViolationError if unsafe
```

#### Detection coverage

| Category | Examples |
|---|---|
| Injection | `ignore previous instructions`, `system: you are`, prompt leak attempts |
| Jailbreak | DAN, `do anything now`, `no restrictions`, base64 payloads |
| PII | Email, US phone, SSN, credit card, IPv4 |

```ts
// Fine-grained control
promptSafe(text, { injection: true, jailbreak: false, pii: true })
```

---

### `cost-guard` — Pre-call cost estimation and budget enforcement

Estimate token cost before sending to the LLM. Enforce per-call and session budgets. Track real spend after each call.

**Works with:** OpenAI, Anthropic, Google Gemini, Groq, Mistral, Cohere.

```ts
import { costGuard, CostLimitError } from '@the-arj/ai-kit/cost-guard'

const guard = costGuard({
  model: 'gpt-4o',
  budget: {
    perCall: 0.05,   // max $0.05 per request
    session: 0.50,   // max $0.50 for the whole session
  },
})

// Before each LLM call:
await guard.check(prompt)           // throws CostLimitError if over budget

// After the call completes, record real usage:
guard.record(response.usage.prompt_tokens, response.usage.completion_tokens)

// Inspect cumulative stats:
console.log(guard.summary())
// { calls: 3, spent: 0.12, remaining: 0.38, totalInputTokens: 48000, ... }
```

#### Supported models (with accurate pricing)

OpenAI `gpt-4o`, `gpt-4o-mini`, `gpt-4-turbo`, `o1`, `o3-mini` · Anthropic `claude-sonnet-4-6`, `claude-opus-4-7`, `claude-haiku-4-5` · Google `gemini-1.5-pro`, `gemini-2.0-flash` · Groq `llama-3.3-70b-versatile` · Mistral `mistral-large-latest`

Unknown models fall back to a conservative estimate.

#### Full integration example

```ts
import OpenAI from 'openai'
import { promptSafe, costGuard } from '@the-arj/ai-kit/prompt-safe'
// Note: import each from its subpath
import { costGuard } from '@the-arj/ai-kit/cost-guard'

const guard = costGuard({ model: 'gpt-4o', budget: { session: 1.00 } })
const client = new OpenAI()

async function chat(userMessage: string) {
  // 1. Safety check
  promptSafe.assert(userMessage)

  // 2. Cost check
  await guard.check(userMessage)

  // 3. Call LLM
  const res = await client.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: userMessage }],
  })

  // 4. Record real usage
  guard.record(res.usage!.prompt_tokens, res.usage!.completion_tokens)
  return res.choices[0]!.message.content
}
```

---

## API Reference

### `toolSchema(meta, provider?)`

| Param | Type | Description |
|---|---|---|
| `meta.name` | `string` | Tool name (default: `'tool'`) |
| `meta.description` | `string` | What the tool does |
| `meta.params` | `Record<string, ParamMeta>` | Parameter definitions |
| `provider` | `'openai' \| 'anthropic' \| 'gemini' \| 'generic'` | Output format |

### `promptSafe(text, options?)`

| Option | Default | Description |
|---|---|---|
| `injection` | `true` | Detect prompt injection |
| `jailbreak` | `true` | Detect jailbreak patterns |
| `pii` | `true` | Detect PII |

Returns `{ safe: boolean, violations: Violation[] }`.

### `costGuard(options)`

| Option | Type | Description |
|---|---|---|
| `model` | `string` | Model ID (e.g. `'gpt-4o'`) |
| `budget.perCall` | `number` | Max USD per call |
| `budget.session` | `number` | Max USD for session |
| `assumedOutputTokens` | `number` | Assumed output size for pre-call estimate (default: `256`) |

---

## License

MIT © [The-ARJ](https://github.com/The-ARJ)
