# llmfort e2e example

Three runnable scripts that exercise every llmfort module against real Claude and OpenAI APIs.

| Script | Modules used | Provider |
|---|---|---|
| `review-claude.ts` | tool-schema (+ lint), prompt-safe, cost-guard, cache-key, retry-llm, error-normalize, struct-out (+ Claude pre-fill), context-trim | Anthropic |
| `review-openai.ts` | tool-schema, prompt-safe, cost-guard, cache-key, retry-llm, error-normalize, struct-out | OpenAI |
| `stream-tools-openai.ts` | tool-schema, stream-tools | OpenAI streaming |

## Setup

```sh
cd examples/e2e
npm install
```

This example resolves `@the-arj/llmfort` from npm. To test against your local checkout instead:

```sh
# From the project root, link the workspace:
cd ../..
npm pack
cd examples/e2e
npm install ../../the-arj-llmfort-0.6.0.tgz
```

## Run

```sh
# Anthropic
ANTHROPIC_API_KEY=sk-ant-... npm run start:claude

# OpenAI
OPENAI_API_KEY=sk-... npm run start:openai

# Streaming tool calls
OPENAI_API_KEY=sk-... npm run stream:openai
```

You can pass a custom prompt:

```sh
ANTHROPIC_API_KEY=... npm run start:claude -- "Review the new MacBook Pro"
```

## What the scripts demonstrate

Each `review-*` script wraps a single LLM call in the full llmfort pipeline:

1. **Schema lint** runs against the tool definition.
2. **`promptSafe.assert`** rejects user input with detected injection / PII.
3. **`cacheKey`** computes a stable hash for the request.
4. **`costGuard.check`** enforces a per-call + session + reasoning budget.
5. **`retryLLM`** wraps the API call with provider-aware backoff.
6. **`normalizeError`** classifies any failure.
7. **`structOut`** extracts, parses, validates the response. On failure, the repair callback issues another model call with a surgical fix prompt.
8. **`contextTrim`** (Claude only) bounds the conversation history with a cache breakpoint set on the first user turn.
9. **`costGuard.record`** is called after each model call with the provider-specific usage fields, so the session summary reflects real spend including reasoning tokens and cache savings.

The OpenAI script uses `response_format: { type: 'json_schema', strict: true }` directly. The Claude script uses `structOut.prefillForClaude()` to pre-fill `{` into the assistant turn.
