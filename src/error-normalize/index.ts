/**
 * Normalize errors from OpenAI, Anthropic, and Gemini SDKs into a single
 * tagged union so callers don't write the same if/else tower 10 times.
 *
 * Why: every provider shape is different. Anthropic uses `error.type`,
 * OpenAI uses `error.code`, Gemini uses gRPC-style `error.status`. Status
 * codes also overlap with different meanings. A tagged union of 9 kinds
 * covers 95% of production handling.
 *
 * Zero-dep. Idempotent — passing an already-normalized error returns it.
 */

export type LLMErrorKind =
  | 'rate_limited'        // 429; back off and retry
  | 'context_overflow'    // request exceeds context window (413 / "context_length_exceeded")
  | 'content_filtered'    // provider's safety layer refused ("content_policy_violation")
  | 'schema_invalid'      // function-call / JSON-schema rejection from strict-mode
  | 'auth'                // 401 / 403 — invalid key, missing scope, billing disabled
  | 'billing'             // 402 — out of credits, spend cap hit
  | 'bad_request'         // 400 — malformed request (not schema, not context)
  | 'server_error'        // 5xx — transient, retryable
  | 'network'             // fetch/socket level — ECONNRESET etc.
  | 'transient'           // retryable but cause unclear
  | 'aborted'             // AbortSignal fired
  | 'unknown'             // nothing we recognize; inspect raw

export interface NormalizedError {
  kind: LLMErrorKind
  /** Short human-readable summary. */
  message: string
  /** HTTP status, if the error surfaced one. */
  status?: number
  /** The original provider error — inspect for provider-specific fields. */
  raw: unknown
  /** Which provider this looks like. Best-effort. */
  provider?: 'openai' | 'anthropic' | 'gemini'
  /** True if automatic retry is safe. */
  retryable: boolean
}

function firstString(...vs: unknown[]): string | undefined {
  for (const v of vs) if (typeof v === 'string' && v.length > 0) return v
  return undefined
}

function inferProvider(e: Record<string, any>): NormalizedError['provider'] {
  // Anthropic SDK: APIError with `error.type` in { 'invalid_request_error', 'rate_limit_error', 'overloaded_error', ... }
  if (e.error?.type && typeof e.error.type === 'string' && e.error.type.endsWith('_error')) return 'anthropic'
  if (e.type && typeof e.type === 'string' && e.type.endsWith('_error')) return 'anthropic'

  // OpenAI SDK: APIError with `error.code` string and `error.param`
  if (e.error?.code !== undefined || e.error?.param !== undefined) return 'openai'

  // Gemini: gRPC-style `error.status` in ALL_CAPS
  const grpc = e.error?.status ?? e.response?.data?.error?.status
  if (typeof grpc === 'string' && /^[A-Z_]+$/.test(grpc)) return 'gemini'

  return undefined
}

export function normalizeError(err: unknown): NormalizedError {
  if (err && typeof err === 'object' && 'kind' in err && 'retryable' in err && 'raw' in err) {
    return err as NormalizedError // already normalized
  }

  if (err instanceof Error && err.name === 'AbortError') {
    return { kind: 'aborted', message: err.message || 'aborted', retryable: false, raw: err }
  }
  if (err instanceof Error && err.message === 'aborted') {
    return { kind: 'aborted', message: 'aborted', retryable: false, raw: err }
  }

  if (!err || typeof err !== 'object') {
    return {
      kind: 'unknown',
      message: String(err),
      retryable: false,
      raw: err,
    }
  }

  const e = err as Record<string, any>
  const provider = inferProvider(e)
  const status: number | undefined =
    (typeof e.status === 'number' ? e.status : undefined) ??
    (typeof e.statusCode === 'number' ? e.statusCode : undefined) ??
    (typeof e.response?.status === 'number' ? e.response.status : undefined)

  const msg = firstString(
    e.message,
    e.error?.message,
    e.response?.data?.error?.message,
    e.response?.statusText,
  ) ?? 'Unknown LLM error'

  const code = firstString(e.code, e.error?.code, e.cause?.code) ?? ''
  const type = firstString(e.type, e.error?.type) ?? ''
  const grpc = firstString(e.error?.status, e.response?.data?.error?.status) ?? ''

  // ---- network ----
  if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ECONNREFUSED'
      || code === 'EAI_AGAIN' || code === 'UND_ERR_SOCKET') {
    return mk('network', msg, status, err, provider, true)
  }

  // ---- auth / billing ----
  // Anthropic's `permission_error` is a 403 that means "content refused by
  // policy", not "invalid key". Check it before the generic 401/403 → auth.
  if (type === 'permission_error') return mk('content_filtered', msg, status, err, provider, false)
  if (status === 401 || status === 403) return mk('auth', msg, status, err, provider, false)
  if (status === 402 || code === 'insufficient_quota' || code === 'billing_not_active') {
    return mk('billing', msg, status, err, provider, false)
  }

  // ---- rate limit ----
  if (status === 429 || type === 'rate_limit_error' || grpc === 'RESOURCE_EXHAUSTED'
      || code === 'rate_limit_exceeded') {
    return mk('rate_limited', msg, status, err, provider, true)
  }

  // ---- context overflow ----
  if (code === 'context_length_exceeded' || code === 'string_above_max_length'
      || status === 413
      || /context[\s_-]*length|context[\s_-]*window|maximum context|too many tokens|max_tokens/i.test(msg)) {
    return mk('context_overflow', msg, status, err, provider, false)
  }

  // ---- content filtered ----
  if (code === 'content_policy_violation' || code === 'content_filter'
      || type === 'permission_error' || /content[\s_-]*(?:policy|filter)|safety/i.test(msg)) {
    return mk('content_filtered', msg, status, err, provider, false)
  }

  // ---- schema / tool-call validation ----
  if (code === 'invalid_function_parameters' || code === 'invalid_schema'
      || /json[\s_-]*schema|tool[\s_-]*call|function[\s_-]*call.*invalid/i.test(msg)) {
    return mk('schema_invalid', msg, status, err, provider, false)
  }

  // ---- server / overloaded ----
  if (type === 'overloaded_error' || type === 'api_error'
      || grpc === 'UNAVAILABLE' || grpc === 'INTERNAL' || grpc === 'DEADLINE_EXCEEDED') {
    return mk('server_error', msg, status, err, provider, true)
  }
  if (typeof status === 'number' && status >= 500 && status < 600) {
    return mk('server_error', msg, status, err, provider, true)
  }

  // ---- bad request (explicitly 400) ----
  if (status === 400 || type === 'invalid_request_error') {
    return mk('bad_request', msg, status, err, provider, false)
  }

  // Unclassified retryable hint (e.g. 408 Request Timeout)
  if (status === 408 || status === 425) return mk('transient', msg, status, err, provider, true)

  return mk('unknown', msg, status, err, provider, false)
}

function mk(
  kind: LLMErrorKind,
  message: string,
  status: number | undefined,
  raw: unknown,
  provider: NormalizedError['provider'],
  retryable: boolean,
): NormalizedError {
  const out: NormalizedError = { kind, message, raw, retryable }
  if (status !== undefined) out.status = status
  if (provider !== undefined) out.provider = provider
  return out
}

/** Convenience: is this error safe to automatically retry? */
export function isRetryable(err: unknown): boolean {
  return normalizeError(err).retryable
}
