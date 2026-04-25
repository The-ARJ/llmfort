export type LLMErrorKind =
  | 'rate_limited'
  | 'context_overflow'
  | 'content_filtered'
  | 'schema_invalid'
  | 'auth'
  | 'billing'
  | 'bad_request'
  | 'server_error'
  | 'network'
  | 'transient'
  | 'aborted'
  | 'unknown'

export interface NormalizedError {
  kind: LLMErrorKind
  message: string
  status?: number
  raw: unknown
  provider?: 'openai' | 'anthropic' | 'gemini'
  retryable: boolean
}

function firstString(...vs: unknown[]): string | undefined {
  for (const v of vs) if (typeof v === 'string' && v.length > 0) return v
  return undefined
}

function inferProvider(e: Record<string, any>): NormalizedError['provider'] {
  if (e.error?.type && typeof e.error.type === 'string' && e.error.type.endsWith('_error')) return 'anthropic'
  if (e.type && typeof e.type === 'string' && e.type.endsWith('_error')) return 'anthropic'
  if (e.error?.code !== undefined || e.error?.param !== undefined) return 'openai'
  const grpc = e.error?.status ?? e.response?.data?.error?.status
  if (typeof grpc === 'string' && /^[A-Z_]+$/.test(grpc)) return 'gemini'
  return undefined
}

export function normalizeError(err: unknown): NormalizedError {
  if (err && typeof err === 'object' && 'kind' in err && 'retryable' in err && 'raw' in err) {
    return err as NormalizedError
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

  if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ECONNREFUSED'
      || code === 'EAI_AGAIN' || code === 'UND_ERR_SOCKET') {
    return mk('network', msg, status, err, provider, true)
  }

  // Anthropic's `permission_error` is a 403 that means content-policy refused,
  // not invalid-key. Must classify before the generic 401/403 → auth branch.
  if (type === 'permission_error') return mk('content_filtered', msg, status, err, provider, false)
  if (status === 401 || status === 403) return mk('auth', msg, status, err, provider, false)
  if (status === 402 || code === 'insufficient_quota' || code === 'billing_not_active') {
    return mk('billing', msg, status, err, provider, false)
  }

  if (status === 429 || type === 'rate_limit_error' || grpc === 'RESOURCE_EXHAUSTED'
      || code === 'rate_limit_exceeded') {
    return mk('rate_limited', msg, status, err, provider, true)
  }

  if (code === 'context_length_exceeded' || code === 'string_above_max_length'
      || status === 413
      || /context[\s_-]*length|context[\s_-]*window|maximum context|too many tokens|max_tokens/i.test(msg)) {
    return mk('context_overflow', msg, status, err, provider, false)
  }

  if (code === 'content_policy_violation' || code === 'content_filter'
      || type === 'permission_error' || /content[\s_-]*(?:policy|filter)|safety/i.test(msg)) {
    return mk('content_filtered', msg, status, err, provider, false)
  }

  if (code === 'invalid_function_parameters' || code === 'invalid_schema'
      || /json[\s_-]*schema|tool[\s_-]*call|function[\s_-]*call.*invalid/i.test(msg)) {
    return mk('schema_invalid', msg, status, err, provider, false)
  }

  if (type === 'overloaded_error' || type === 'api_error'
      || grpc === 'UNAVAILABLE' || grpc === 'INTERNAL' || grpc === 'DEADLINE_EXCEEDED') {
    return mk('server_error', msg, status, err, provider, true)
  }
  if (typeof status === 'number' && status >= 500 && status < 600) {
    return mk('server_error', msg, status, err, provider, true)
  }

  if (status === 400 || type === 'invalid_request_error') {
    return mk('bad_request', msg, status, err, provider, false)
  }

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

export function isRetryable(err: unknown): boolean {
  return normalizeError(err).retryable
}
