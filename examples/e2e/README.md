# llmfort e2e example

Three runnable scripts that exercise every llmfort module against real Claude and OpenAI APIs.

| Script | Provider | Modules used |
|---|---|---|
| `review-claude.ts` | Anthropic | tool-schema, prompt-safe, cost-guard, cache-key, retry-llm, error-normalize, struct-out (with Claude pre-fill), context-trim |
| `review-openai.ts` | OpenAI | tool-schema, prompt-safe, cost-guard, cache-key, retry-llm, error-normalize, struct-out |
| `stream-tools-openai.ts` | OpenAI streaming | tool-schema, stream-tools |

## Setup

```sh
cd examples/e2e
npm install
```

## Run

```sh
ANTHROPIC_API_KEY=sk-ant-... npm run start:claude
OPENAI_API_KEY=sk-...        npm run start:openai
OPENAI_API_KEY=sk-...        npm run stream:openai
```

Pass a custom prompt as an argument:

```sh
ANTHROPIC_API_KEY=... npm run start:claude -- "Review the new MacBook Pro"
```

## Testing against your local checkout

To run these against an unpublished local version of llmfort:

```sh
# From the project root:
npm pack
cd examples/e2e
npm install ../../the-arj-llmfort-*.tgz
```
