import { describe, it, expect, vi } from 'vitest'
import {
  retryLLM,
  retryDelayFromError,
  classifyError,
  RetryExhaustedError,
} from '../src/retry-llm/index.js'

describe('classifyError', () => {
  it('429 → rate_limit', () => {
    expect(classifyError({ status: 429 })).toBe('rate_limit')
  })
  it('500 → server_error', () => {
    expect(classifyError({ status: 503 })).toBe('server_error')
  })
  it('Anthropic rate_limit_error → rate_limit', () => {
    expect(classifyError({ error: { type: 'rate_limit_error' } })).toBe('rate_limit')
  })
  it('Anthropic overloaded_error → server_error', () => {
    expect(classifyError({ error: { type: 'overloaded_error' } })).toBe('server_error')
  })
  it('Gemini RESOURCE_EXHAUSTED → rate_limit', () => {
    expect(classifyError({ error: { status: 'RESOURCE_EXHAUSTED' } })).toBe('rate_limit')
  })
  it('Gemini UNAVAILABLE → server_error', () => {
    expect(classifyError({ error: { status: 'UNAVAILABLE' } })).toBe('server_error')
  })
  it('ECONNRESET → network', () => {
    expect(classifyError({ code: 'ECONNRESET' })).toBe('network')
  })
  it('408 / 425 → retryable_error', () => {
    expect(classifyError({ status: 408 })).toBe('retryable_error')
    expect(classifyError({ status: 425 })).toBe('retryable_error')
  })
  it('400 / non-retryable → fatal', () => {
    expect(classifyError({ status: 400 })).toBe('fatal')
    expect(classifyError({ status: 403 })).toBe('fatal')
  })
  it('null / undefined → fatal', () => {
    expect(classifyError(null)).toBe('fatal')
    expect(classifyError(undefined)).toBe('fatal')
  })
})

describe('retryDelayFromError', () => {
  it('reads Retry-After seconds', () => {
    expect(retryDelayFromError({ headers: { 'retry-after': '5' } })).toBe(5000)
  })
  it('reads Retry-After via .get()', () => {
    const headers = new Map([['retry-after', '3']])
    // @ts-expect-error allow map-like
    expect(retryDelayFromError({ headers })).toBe(3000)
  })
  it('reads OpenAI x-ratelimit-reset-tokens with "1s30ms" form', () => {
    const err = { headers: { 'x-ratelimit-reset-tokens': '1s30ms' } }
    expect(retryDelayFromError(err)).toBe(1030)
  })
  it('reads Gemini RetryInfo', () => {
    const err = {
      error: {
        status: 'RESOURCE_EXHAUSTED',
        details: [{ '@type': 'RetryInfo', retryDelay: '2s' }],
      },
    }
    expect(retryDelayFromError(err)).toBe(2000)
  })
  it('returns -1 when no hint present', () => {
    expect(retryDelayFromError({ status: 500 })).toBe(-1)
    expect(retryDelayFromError(null)).toBe(-1)
  })
})

describe('retryLLM', () => {
  it('returns the result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok')
    const r = await retryLLM(fn)
    expect(r).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('retries on 429 then succeeds', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce({ status: 429 })
      .mockResolvedValue('ok')
    const r = await retryLLM(fn, { baseDelayMs: 1, jitter: 'none' })
    expect(r).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('retries on network error then succeeds', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce({ code: 'ECONNRESET' })
      .mockRejectedValueOnce({ code: 'ETIMEDOUT' })
      .mockResolvedValue('ok')
    const r = await retryLLM(fn, { baseDelayMs: 1, jitter: 'none' })
    expect(r).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('does NOT retry a 400 bad request', async () => {
    const fn = vi.fn().mockRejectedValue({ status: 400 })
    await expect(retryLLM(fn, { baseDelayMs: 1 })).rejects.toBeInstanceOf(RetryExhaustedError)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('does NOT retry a 401 auth error', async () => {
    const fn = vi.fn().mockRejectedValue({ status: 401 })
    await expect(retryLLM(fn, { baseDelayMs: 1 })).rejects.toBeInstanceOf(RetryExhaustedError)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('honors maxAttempts', async () => {
    const fn = vi.fn().mockRejectedValue({ status: 503 })
    await expect(retryLLM(fn, { maxAttempts: 2, baseDelayMs: 1 })).rejects.toBeInstanceOf(RetryExhaustedError)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('honors Retry-After header', async () => {
    const start = Date.now()
    const fn = vi.fn()
      .mockRejectedValueOnce({ status: 429, headers: { 'retry-after': '0.05' } })
      .mockResolvedValue('ok')
    await retryLLM(fn, { baseDelayMs: 10_000, jitter: 'none' })
    // Should take ~50ms (from Retry-After), not 10s (from baseDelay).
    expect(Date.now() - start).toBeLessThan(5000)
  })

  it('AbortSignal aborts the sleep between retries', async () => {
    const ac = new AbortController()
    const fn = vi.fn().mockImplementation(async () => {
      setTimeout(() => ac.abort(), 1)
      throw { status: 503 }
    })
    await expect(retryLLM(fn, { baseDelayMs: 500, signal: ac.signal })).rejects.toThrow(/aborted/)
  })

  it('custom shouldRetry=true forces retry on a normally-fatal error', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce({ status: 400 })
      .mockResolvedValue('ok')
    const r = await retryLLM(fn, {
      baseDelayMs: 1,
      shouldRetry: (_e, attempt) => attempt === 0,
    })
    expect(r).toBe('ok')
  })

  it('custom shouldRetry=false forces fail on a normally-retryable error', async () => {
    const fn = vi.fn().mockRejectedValue({ status: 429 })
    await expect(retryLLM(fn, {
      baseDelayMs: 1,
      shouldRetry: () => false,
    })).rejects.toBeInstanceOf(RetryExhaustedError)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('onRetry fires with attempt info', async () => {
    const onRetry = vi.fn()
    const fn = vi.fn()
      .mockRejectedValueOnce({ status: 429 })
      .mockResolvedValue('ok')
    await retryLLM(fn, { baseDelayMs: 1, jitter: 'none', onRetry })
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(onRetry.mock.calls[0]![0].reason).toBe('rate_limit')
  })

  it('maxAttempts < 1 throws RangeError', async () => {
    await expect(retryLLM(async () => 'x', { maxAttempts: 0 })).rejects.toBeInstanceOf(RangeError)
  })
})
