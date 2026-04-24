/**
 * Wrap an LLM call with provider-aware retry: 429 rate limits, 5xx transient
 * errors, and network flakes. Reads the provider's own reset/retry-after
 * headers where available, falls back to exponential backoff with jitter.
 *
 * Zero-dep. Works with OpenAI, Anthropic, Gemini, and any fetch-based SDK.
 *
 * @example
 * const res = await retryLLM(
 *   () => openai.chat.completions.create({ ... }),
 *   { maxAttempts: 5, baseDelayMs: 500 },
 * )
 */

export interface RetryOptions {
  /** Total attempts including the first try. Default 4. */
  maxAttempts?: number
  /** Base delay for exponential backoff (ms). Default 500. */
  baseDelayMs?: number
  /** Cap on any single delay (ms). Default 30_000. */
  maxDelayMs?: number
  /** Full jitter (0..delay) vs. equal jitter (delay/2 + random(0..delay/2)). Default 'equal'. */
  jitter?: 'full' | 'equal' | 'none'
  /**
   * Custom decision hook. Return true to retry, false to fail fast, or
   * `undefined` to fall through to the default classifier. Fires on every caught error.
   */
  shouldRetry?: (error: unknown, attempt: number) => boolean | undefined
  /** Abort the retry loop. */
  signal?: AbortSignal
  /** Called before each retry with the planned delay. */
  onRetry?: (info: RetryAttemptInfo) => void
}

export interface RetryAttemptInfo {
  attempt: number
  error: unknown
  delayMs: number
  reason: 'rate_limit' | 'server_error' | 'network' | 'custom' | 'retryable_error'
}

export class RetryExhaustedError extends Error {
  readonly attempts: number
  readonly lastError: unknown
  constructor(attempts: number, lastError: unknown) {
    const cause = lastError instanceof Error ? lastError.message : String(lastError)
    super(`retryLLM: exhausted after ${attempts} attempts — last error: ${cause}`)
    this.name = 'RetryExhaustedError'
    this.attempts = attempts
    this.lastError = lastError
  }
}

/**
 * Extract a retry delay (ms) from the error if the provider told us one.
 *
 * OpenAI:    `Retry-After` (seconds or HTTP-date), `x-ratelimit-reset-tokens` (seconds)
 * Anthropic: `retry-after` (seconds), sometimes on the error.response.headers
 * Gemini:    error body contains `retryDelay: "Ns"` in RetryInfo
 *
 * Returns -1 when nothing usable is found.
 */
export function retryDelayFromError(err: unknown): number {
  if (!err || typeof err !== 'object') return -1
  const e = err as Record<string, any>

  // Headers may hang off .headers, .response.headers, .response.res.headers, etc.
  const headers =
    e.headers ??
    e.response?.headers ??
    e.response?.res?.headers ??
    e.cause?.headers

  const readHeader = (name: string): string | undefined => {
    if (!headers) return undefined
    if (typeof headers.get === 'function') return headers.get(name) ?? undefined
    const lc = name.toLowerCase()
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase() === lc) return String(headers[k])
    }
    return undefined
  }

  // 1) Standard Retry-After (seconds OR HTTP-date)
  const ra = readHeader('retry-after')
  if (ra) {
    const n = Number(ra)
    if (Number.isFinite(n) && n >= 0) return Math.floor(n * 1000)
    // HTTP-date
    const t = Date.parse(ra)
    if (!Number.isNaN(t)) {
      const delta = t - Date.now()
      if (delta > 0) return delta
    }
  }

  // 2) OpenAI rate-limit reset hints (token or request reset, whichever is sooner)
  const candidates: number[] = []
  for (const h of ['x-ratelimit-reset-tokens', 'x-ratelimit-reset-requests', 'x-ratelimit-reset']) {
    const v = readHeader(h)
    if (!v) continue
    // Format can be "1s", "500ms", "1m30s", or plain seconds
    const m = /^((\d+)m)?((\d+(?:\.\d+)?)s)?((\d+)ms)?$/i.exec(v.trim())
    if (m) {
      const mins = Number(m[2] ?? 0)
      const secs = Number(m[4] ?? 0)
      const mss  = Number(m[6] ?? 0)
      const ms = mins * 60_000 + secs * 1000 + mss
      if (ms > 0) candidates.push(ms)
    } else {
      const n = Number(v)
      if (Number.isFinite(n) && n >= 0) candidates.push(n * 1000)
    }
  }
  if (candidates.length) return Math.min(...candidates)

  // 3) Gemini RetryInfo in the error body
  const body = e.response?.data ?? e.body ?? e.error ?? e
  const details =
    body?.error?.details ??
    body?.details ??
    (Array.isArray(body?.errorDetails) ? body.errorDetails : undefined)
  if (Array.isArray(details)) {
    for (const d of details) {
      const rd = d?.retryDelay ?? d?.['retry_delay']
      if (typeof rd === 'string') {
        const m = /^(\d+(?:\.\d+)?)s$/i.exec(rd.trim())
        if (m) return Math.floor(Number(m[1]) * 1000)
      }
    }
  }

  return -1
}

/**
 * Classify whether an error is worth retrying. Covers:
 *   - 429 Too Many Requests
 *   - 408 Request Timeout
 *   - 425 Too Early
 *   - 500/502/503/504 Server errors
 *   - Anthropic `overloaded_error` and `rate_limit_error`
 *   - Gemini RESOURCE_EXHAUSTED / UNAVAILABLE
 *   - Network-level (ECONNRESET, ETIMEDOUT, fetch abort-except-user)
 */
export function classifyError(err: unknown): RetryAttemptInfo['reason'] | 'fatal' {
  if (!err || typeof err !== 'object') return 'fatal'
  const e = err as Record<string, any>
  const status = typeof e.status === 'number' ? e.status
               : typeof e.statusCode === 'number' ? e.statusCode
               : typeof e.response?.status === 'number' ? e.response.status
               : undefined

  if (status === 429) return 'rate_limit'
  if (status === 408 || status === 425) return 'retryable_error'
  if (typeof status === 'number' && status >= 500 && status < 600) return 'server_error'

  const code = e.code ?? e.cause?.code ?? e.error?.code
  if (typeof code === 'string') {
    if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ECONNREFUSED'
        || code === 'EAI_AGAIN' || code === 'UND_ERR_SOCKET') return 'network'
  }

  const type = e.error?.type ?? e.type ?? e.response?.data?.error?.type
  if (type === 'rate_limit_error') return 'rate_limit'
  if (type === 'overloaded_error' || type === 'api_error') return 'server_error'

  // Gemini-style gRPC status
  const grpc = e.error?.status ?? e.response?.data?.error?.status
  if (grpc === 'RESOURCE_EXHAUSTED') return 'rate_limit'
  if (grpc === 'UNAVAILABLE' || grpc === 'INTERNAL' || grpc === 'DEADLINE_EXCEEDED') return 'server_error'

  return 'fatal'
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'))
    const t = setTimeout(() => resolve(), ms)
    const onAbort = () => { clearTimeout(t); reject(new Error('aborted')) }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function jitteredDelay(
  baseMs: number,
  attempt: number,
  maxMs: number,
  jitter: 'full' | 'equal' | 'none',
): number {
  const exp = Math.min(maxMs, baseMs * Math.pow(2, attempt))
  if (jitter === 'none') return exp
  if (jitter === 'full') return Math.random() * exp
  // equal
  return exp / 2 + Math.random() * (exp / 2)
}

export async function retryLLM<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxAttempts  = 4,
    baseDelayMs  = 500,
    maxDelayMs   = 30_000,
    jitter       = 'equal',
    shouldRetry,
    signal,
    onRetry,
  } = options

  if (maxAttempts < 1) throw new RangeError('retryLLM: maxAttempts must be >= 1')

  let lastError: unknown
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal?.aborted) throw new Error('aborted')
    try {
      return await fn()
    } catch (err) {
      lastError = err

      // Custom hook overrides the default classifier.
      const decision = shouldRetry?.(err, attempt)
      let reason: RetryAttemptInfo['reason'] | 'fatal'
      if (decision === true)  reason = 'custom'
      else if (decision === false) reason = 'fatal'
      else reason = classifyError(err)

      if (reason === 'fatal' || attempt === maxAttempts - 1) {
        break
      }

      // Honor provider-supplied delay if present, else exponential backoff.
      const hinted = retryDelayFromError(err)
      const delayMs = hinted >= 0
        ? Math.min(hinted, maxDelayMs)
        : Math.floor(jitteredDelay(baseDelayMs, attempt, maxDelayMs, jitter))

      onRetry?.({ attempt: attempt + 1, error: err, delayMs, reason })

      await sleep(delayMs, signal)
    }
  }

  throw new RetryExhaustedError(maxAttempts, lastError)
}
