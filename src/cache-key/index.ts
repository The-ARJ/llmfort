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
  try {
    // @ts-ignore — node:crypto is conditional; no @types/node at runtime
    const { createHash } = await import('node:crypto')
    return createHash('sha256').update(input).digest('hex')
  } catch { /* no-op */ }

  const g: any = typeof globalThis !== 'undefined' ? globalThis : {}
  if (g.crypto?.subtle) {
    const buf = new TextEncoder().encode(input)
    const hash = await g.crypto.subtle.digest('SHA-256', buf)
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('')
  }

  return 'fnv1a-' + fnv1a(input)
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']'
  const keys = Object.keys(v as object).sort()
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify((v as any)[k])).join(',') + '}'
}

function normalizeText(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/[ \t]+\n/g, '\n').trim()
}

function normalizeToolArgs(args: string): string {
  try {
    return stableStringify(JSON.parse(args))
  } catch {
    return args
  }
}

export interface CacheKeyInput {
  model: string
  messages?: unknown[]
  system?: string
  tools?: Array<{ name?: string; function?: { name?: string }; [k: string]: unknown }>
  response_format?: unknown
  params?: Record<string, unknown>
  namespace?: string
}

/** Canonical serialization without hashing. */
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
  return stableOrderObj(out)
}

function normalizeTool(t: any): { name?: string; payload: unknown } & Record<string, unknown> {
  const name = t?.name ?? t?.function?.name
  return { name, payload: stableOrderObj(t) }
}

function stableOrderObj(obj: any): any {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj
  const keys = Object.keys(obj).sort()
  const out: Record<string, unknown> = {}
  for (const k of keys) out[k] = obj[k]
  return out
}

/** SHA-256 hash of the canonical serialization. */
export async function cacheKey(input: CacheKeyInput): Promise<string> {
  return sha256(canonical(input))
}

/** Synchronous FNV-1a hash. 16 hex chars, non-cryptographic. */
export function cacheKeySync(input: CacheKeyInput): string {
  return fnv1a(canonical(input))
}
