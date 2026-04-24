# @the-arj/ai-kit

> AI toolkit for Node.js — tool schema generation, prompt safety, and cost guardrails.

Three focused modules, zero shared runtime dependencies, full TypeScript types.  
Works with **Claude**, **ChatGPT / GPT-4o**, **Gemini**, **DeepSeek**, **Llama**, **Mistral**, and any OpenAPI-compatible LLM.

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

No compiler plugins. No decorators. No build-step changes. Describe your tool once and get the exact JSON Schema each model expects.

**Works with:** ChatGPT / GPT-4o (OpenAI), Claude (Anthropic), Gemini (Google), Groq, Mistral, DeepSeek, any OpenAPI-compatible LLM.

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

// Same tool, all providers at once:
const { openai, anthropic, gemini, generic } = toolSchemaAll(meta)
```

#### Output format per provider

| Provider key | Model family | Output shape |
|---|---|---|
| `'openai'` | ChatGPT, GPT-4o, o3, o4-mini | `{ type: 'function', function: { name, description, parameters } }` |
| `'anthropic'` | Claude 3.5, Claude Sonnet, Claude Opus | `{ name, description, input_schema }` |
| `'gemini'` | Gemini 2.5 Pro, Gemini Flash | `{ functionDeclarations: [{ name, description, parameters }] }` |
| `'generic'` | DeepSeek, Llama, Mistral, custom | `{ name, description, parameters }` |

---

### `prompt-safe` — Prompt injection, jailbreak, and PII detection

Runs **client-side before any API call**. No network requests, no telemetry. Works with any LLM.

```ts
import { promptSafe, PromptViolationError } from '@the-arj/ai-kit/prompt-safe'

// Scan and inspect violations
const result = promptSafe(userInput)
// { safe: false, violations: [{ type: 'injection', label: 'ignore_instructions', match: '...' }] }

// Redact PII in-place (emails, phones, SSNs, API keys, ...)
const clean = promptSafe.redact(userInput)
// "Contact [REDACTED_EMAIL] or call [REDACTED_PHONE]"

// Throw on any violation — useful in middleware
promptSafe.assert(userInput)  // throws PromptViolationError if unsafe
```

#### Detection coverage

| Category | Patterns detected |
|---|---|
| **Injection** | `ignore previous instructions`, `system: you are`, prompt leak, translate-leak, XML token injection (`<\|im_start\|>`), unicode direction smuggling, context extraction |
| **Jailbreak** | DAN, `do anything now`, `no restrictions`, base64 payloads, opposite/evil mode, grandma/persona exploit, simulation framing, token overflow attacks |
| **PII** | Email, US phone, SSN, credit card (Visa/MC/Amex), IPv4, passport numbers, API keys (OpenAI `sk-`, Google `AIza`, AWS `AKIA`) |

```ts
// Fine-grained control — disable categories you don't need
promptSafe(text, { injection: true, jailbreak: false, pii: true })
```

---

### `cost-guard` — Pre-call cost estimation and budget enforcement

Estimate token cost before sending to any LLM. Enforce per-call and session budgets. Track real spend after each call.

```ts
import { costGuard, CostLimitError } from '@the-arj/ai-kit/cost-guard'

const guard = costGuard({
  model: 'gpt-4o',
  budget: {
    perCall: 0.05,   // max $0.05 per request
    session: 0.50,   // max $0.50 for the whole session
  },
})

// Before each LLM call — throws CostLimitError if over budget:
await guard.check(prompt)

// After the call, record real usage from the API response:
guard.record(response.usage.prompt_tokens, response.usage.completion_tokens)

// Cumulative stats:
console.log(guard.summary())
// { calls: 3, spent: 0.12, remaining: 0.38, totalInputTokens: 48000, ... }
```

#### Supported models (accurate pricing built-in)

| Family | Models |
|---|---|
| **ChatGPT / GPT** | `gpt-4o`, `gpt-4o-mini`, `gpt-4.5-preview`, `gpt-4-turbo`, `o1`, `o3`, `o3-mini`, `o4-mini` |
| **Claude** | `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5`, `claude-3-5-sonnet-20241022`, `claude-3-5-haiku`, `claude-3-opus` |
| **Gemini** | `gemini-2.5-pro`, `gemini-2.0-flash`, `gemini-1.5-pro`, `gemini-1.5-flash` |
| **DeepSeek** | `deepseek-chat`, `deepseek-reasoner` |
| **Llama / Groq** | `llama-3.3-70b-versatile`, `llama-3.1-8b-instant`, `llama-3.1-70b-versatile`, `mixtral-8x7b-32768` |
| **Mistral** | `mistral-large-latest`, `mistral-small-latest`, `codestral-latest` |

Unknown models fall back to a conservative estimate so cost checks never silently skip.

---

## Full integration example

```ts
import { promptSafe }  from '@the-arj/ai-kit/prompt-safe'
import { costGuard }   from '@the-arj/ai-kit/cost-guard'
import Anthropic from '@anthropic-ai/sdk'

const guard  = costGuard({ model: 'claude-sonnet-4-6', budget: { session: 1.00 } })
const claude = new Anthropic()

async function chat(userMessage: string) {
  // 1. Block injection / jailbreak / PII before it reaches Claude
  promptSafe.assert(userMessage)

  // 2. Enforce cost budget before the API call
  await guard.check(userMessage)

  // 3. Call Claude
  const res = await claude.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{ role: 'user', content: userMessage }],
  })

  // 4. Record real usage so session budget stays accurate
  guard.record(res.usage.input_tokens, res.usage.output_tokens)
  return res.content[0]
}
```

Works the same way with ChatGPT/GPT-4o, Gemini, DeepSeek, or any other provider — swap the model name and SDK, keep the safety + cost layer identical.

---

## API Reference

### `toolSchema(meta, provider?)`

| Param | Type | Description |
|---|---|---|
| `meta.name` | `string` | Tool name (default: `'tool'`) |
| `meta.description` | `string` | What the tool does |
| `meta.params` | `Record<string, ParamMeta>` | Parameter definitions |
| `provider` | `'openai' \| 'anthropic' \| 'gemini' \| 'generic'` | Output format |

**ParamMeta fields:** `type`, `description`, `enum`, `required` (default `true`), `items`, `minimum`, `maximum`, `default`.

### `promptSafe(text, options?)`

| Option | Default | Description |
|---|---|---|
| `injection` | `true` | Detect prompt injection |
| `jailbreak` | `true` | Detect jailbreak patterns |
| `pii` | `true` | Detect PII |

Returns `{ safe: boolean, violations: Violation[] }`.  
`promptSafe.redact(text)` — returns string with PII replaced.  
`promptSafe.assert(text, options?)` — throws `PromptViolationError` if unsafe.

### `costGuard(options)`

| Option | Type | Description |
|---|---|---|
| `model` | `string` | Model ID (e.g. `'claude-sonnet-4-6'`, `'gpt-4o'`) |
| `budget.perCall` | `number` | Max USD per call |
| `budget.session` | `number` | Max USD for session |
| `assumedOutputTokens` | `number` | Assumed output size for pre-call estimate (default: `256`) |

`guard.check(prompt)` — async, throws `CostLimitError` if over budget.  
`guard.estimate(prompt)` — sync, returns estimate without enforcing.  
`guard.record(inputTokens, outputTokens)` — update session totals from real API usage.  
`guard.summary()` — returns `{ calls, spent, remaining, totalInputTokens, totalOutputTokens }`.

---

## License

MIT © [The-ARJ](https://github.com/The-ARJ)
