export interface RetryOptions {
  maxAttempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  jitter?: 'full' | 'equal' | 'none'
  /** Return true to retry, false to fail fast, undefined to fall through to the default classifier. */
  shouldRetry?: (error: unknown, attempt: number) => boolean | undefined
  signal?: AbortSignal
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

/** Returns the provider-hinted retry delay in ms, or -1 if absent. */
export function retryDelayFromError(err: unknown): number {
  if (!err || typeof err !== 'object') return -1
  const e = err as Record<string, any>

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

  const ra = readHeader('retry-after')
  if (ra) {
    const n = Number(ra)
    if (Number.isFinite(n) && n >= 0) return Math.floor(n * 1000)
    const t = Date.parse(ra)
    if (!Number.isNaN(t)) {
      const delta = t - Date.now()
      if (delta > 0) return delta
    }
  }

  const candidates: number[] = []
  for (const h of ['x-ratelimit-reset-tokens', 'x-ratelimit-reset-requests', 'x-ratelimit-reset']) {
    const v = readHeader(h)
    if (!v) continue
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

/** Classify an error for retry purposes. Returns `'fatal'` for non-retryable. */
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

      const decision = shouldRetry?.(err, attempt)
      let reason: RetryAttemptInfo['reason'] | 'fatal'
      if (decision === true)  reason = 'custom'
      else if (decision === false) reason = 'fatal'
      else reason = classifyError(err)

      if (reason === 'fatal' || attempt === maxAttempts - 1) break

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
