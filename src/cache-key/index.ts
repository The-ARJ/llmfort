/**
 * Stable cache-key builder for LLM requests.
 *
 * Why: prompt-caching hit rate depends on byte-stable prefixes. Teams break
 * their own cache by reordering tools, reshuffling JSON keys in `arguments`,
 * whitespace drift in system prompts, or injecting a timestamp into the first
 * user message. This module normalizes all of that into a single hash so
 * you can key a local cache or a Redis cache or a Vercel KV lookup by it.
 *
 * Zero-dep. Uses Node's built-in `crypto.createHash('sha256')` when available,
 * falls back to a pure-JS FNV-1a for browser/Edge runtimes that don't expose
 * Node crypto (rare but happens in Cloudflare Workers without nodejs_compat).
 */

/** FNV-1a 64-bit — small, fast, not cryptographic. Used only as browser fallback. */
function fnv1a(str: string): string {
  let h1 = 0xcbf29ce4, h2 = 0x84222325
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i)
    h1 ^= c
    h2 ^= c
    h1 = Math.imul(h1, 0x01000193)
    h2 = Math.imul(h2, 0x01000193)
  }
  return ((h1 >>> 0).toString(16).padStart(8, '0')
        + (h2 >>> 0).toString(16).padStart(8, '0'))
}

async function sha256(input: string): Promise<string> {
  // Node: crypto.createHash('sha256')
  try {
    // @ts-ignore — runtime-only import
    const { createHash } = await import('node:crypto')
    return createHash('sha256').update(input).digest('hex')
  } catch { /* fall through */ }

  // Browser/Edge: SubtleCrypto
  const g: any = typeof globalThis !== 'undefined' ? globalThis : {}
  if (g.crypto?.subtle) {
    const buf = new TextEncoder().encode(input)
    const hash = await g.crypto.subtle.digest('SHA-256', buf)
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('')
  }

  // Last-resort: fnv1a (not cryptographic — good enough for a cache key).
  return 'fnv1a-' + fnv1a(input)
}

/** Recursive stable stringify: sorts object keys, preserves array order. */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']'
  const keys = Object.keys(v as object).sort()
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify((v as any)[k])).join(',') + '}'
}

/** Normalize whitespace that models tolerate but caches don't. */
function normalizeText(s: string): string {
  // Collapse runs of whitespace but NOT newlines — newlines carry semantic
  // weight in system prompts / multi-example few-shot.
  return s.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/[ \t]+\n/g, '\n').trim()
}

/** Normalize a tool-call arguments string: if it's JSON, sort keys. */
function normalizeToolArgs(args: string): string {
  try {
    return stableStringify(JSON.parse(args))
  } catch {
    return args
  }
}

export interface CacheKeyInput {
  /** Model ID — part of the key so we don't cross-pollute caches across models. */
  model: string
  /**
   * Ordered messages. Content blocks + tool_calls + tool_call_ids are
   * normalized; ID-like fields (tool_call_id, name) are kept; `pinned` is
   * stripped (it's llmfort bookkeeping, not part of the wire request).
   */
  messages?: unknown[]
  /** Raw system prompt, for providers that carry it separately (Anthropic). */
  system?: string
  /** Tool definitions — order-sensitive on OpenAI/Anthropic; we sort them by name for stability. */
  tools?: Array<{ name?: string; function?: { name?: string }; [k: string]: unknown }>
  /** Response format / JSON schema / structured-output spec. */
  response_format?: unknown
  /** Any deterministic knobs you want in the key (temperature, top_p, max_tokens). */
  params?: Record<string, unknown>
  /** Free-form namespace prefix — e.g. workspace ID, user ID, tenant. */
  namespace?: string
}

/** Build the canonical serialization without hashing — useful for debugging. */
export function canonical(input: CacheKeyInput): string {
  const messages = Array.isArray(input.messages) ? input.messages.map(normalizeMessage) : []

  const tools = Array.isArray(input.tools)
    ? [...input.tools]
        .map(normalizeTool)
        .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
    : []

  const payload = {
    ns: input.namespace ?? null,
    model: input.model,
    system: input.system ? normalizeText(input.system) : null,
    messages,
    tools,
    response_format: input.response_format ?? null,
    params: input.params ? stableOrderObj(input.params) : null,
  }
  return stableStringify(payload)
}

function normalizeMessage(m: any): unknown {
  if (!m || typeof m !== 'object') return m
  const out: any = {}
  out.role = m.role
  // Content
  if (typeof m.content === 'string') out.content = normalizeText(m.content)
  else if (m.content === null) out.content = null
  else if (Array.isArray(m.content)) {
    out.content = m.content.map((b: any) => {
      if (!b || typeof b !== 'object') return b
      const block: any = { ...b }
      if (typeof block.text === 'string') block.text = normalizeText(block.text)
      if (typeof block.thinking === 'string') block.thinking = normalizeText(block.thinking)
      return stableOrderObj(block)
    })
  }
  if (m.name) out.name = m.name
  if (m.tool_call_id) out.tool_call_id = m.tool_call_id
  if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
    out.tool_calls = m.tool_calls.map((tc: any) => ({
      id: tc.id,
      type: tc.type ?? 'function',
      function: {
        name: tc.function?.name,
        arguments: typeof tc.function?.arguments === 'string'
          ? normalizeToolArgs(tc.function.arguments)
          : tc.function?.arguments,
      },
    }))
  }
  // `pinned` and `id` are llmfort bookkeeping — not part of the wire request.
  return stableOrderObj(out)
}

function normalizeTool(t: any): { name?: string; payload: unknown } & Record<string, unknown> {
  const name = t?.name ?? t?.function?.name
  // Normalize the whole tool descriptor with stable key order.
  const normalized = stableOrderObj(t)
  return { name, payload: normalized }
}

function stableOrderObj(obj: any): any {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj
  const keys = Object.keys(obj).sort()
  const out: Record<string, unknown> = {}
  for (const k of keys) out[k] = obj[k]
  return out
}

/** Hash the canonical serialization into a stable cache key. */
export async function cacheKey(input: CacheKeyInput): Promise<string> {
  return sha256(canonical(input))
}

/**
 * Synchronous variant using FNV-1a. 16 hex chars, non-cryptographic.
 * Fine for cache-lookup keys; don't use where collision resistance matters.
 */
export function cacheKeySync(input: CacheKeyInput): string {
  return fnv1a(canonical(input))
}
