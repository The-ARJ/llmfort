import { describe, it, expect } from 'vitest'
import { normalizeError, isRetryable } from '../src/error-normalize/index.js'

describe('normalizeError — OpenAI-shaped errors', () => {
  it('429 from OpenAI SDK → rate_limited', () => {
    const r = normalizeError({ status: 429, error: { code: 'rate_limit_exceeded', message: 'Rate limit' } })
    expect(r.kind).toBe('rate_limited')
    expect(r.retryable).toBe(true)
    expect(r.status).toBe(429)
    expect(r.provider).toBe('openai')
  })

  it('context_length_exceeded → context_overflow', () => {
    const r = normalizeError({ status: 400, error: { code: 'context_length_exceeded', message: 'ctx' } })
    expect(r.kind).toBe('context_overflow')
    expect(r.retryable).toBe(false)
  })

  it('content_policy_violation → content_filtered', () => {
    const r = normalizeError({ status: 400, error: { code: 'content_policy_violation', message: 'refused' } })
    expect(r.kind).toBe('content_filtered')
  })

  it('401 → auth', () => {
    const r = normalizeError({ status: 401, message: 'Invalid API key' })
    expect(r.kind).toBe('auth')
    expect(r.retryable).toBe(false)
  })

  it('insufficient_quota → billing', () => {
    const r = normalizeError({ status: 429, error: { code: 'insufficient_quota' } })
    expect(r.kind).toBe('billing')
  })

  it('500 → server_error, retryable', () => {
    const r = normalizeError({ status: 503 })
    expect(r.kind).toBe('server_error')
    expect(r.retryable).toBe(true)
  })
})

describe('normalizeError — Anthropic-shaped errors', () => {
  it('rate_limit_error → rate_limited', () => {
    const r = normalizeError({ status: 429, error: { type: 'rate_limit_error', message: 'wait' } })
    expect(r.kind).toBe('rate_limited')
    expect(r.provider).toBe('anthropic')
  })

  it('overloaded_error → server_error', () => {
    const r = normalizeError({ status: 529, error: { type: 'overloaded_error', message: 'overloaded' } })
    expect(r.kind).toBe('server_error')
    expect(r.retryable).toBe(true)
  })

  it('invalid_request_error → bad_request', () => {
    const r = normalizeError({ status: 400, error: { type: 'invalid_request_error', message: 'bad' } })
    expect(r.kind).toBe('bad_request')
  })

  it('permission_error → content_filtered', () => {
    const r = normalizeError({ status: 403, error: { type: 'permission_error', message: 'safety refused' } })
    expect(r.kind).toBe('content_filtered')
  })
})

describe('normalizeError — Gemini-shaped errors', () => {
  it('RESOURCE_EXHAUSTED → rate_limited', () => {
    const r = normalizeError({
      status: 429,
      error: { status: 'RESOURCE_EXHAUSTED', message: 'quota' },
    })
    expect(r.kind).toBe('rate_limited')
    expect(r.provider).toBe('gemini')
  })

  it('UNAVAILABLE → server_error', () => {
    const r = normalizeError({ error: { status: 'UNAVAILABLE', message: 'retry' } })
    expect(r.kind).toBe('server_error')
  })
})

describe('normalizeError — network and misc', () => {
  it('ECONNRESET → network', () => {
    const r = normalizeError({ code: 'ECONNRESET', message: 'socket' })
    expect(r.kind).toBe('network')
    expect(r.retryable).toBe(true)
  })

  it('AbortError → aborted', () => {
    const err = new Error('cancelled')
    err.name = 'AbortError'
    const r = normalizeError(err)
    expect(r.kind).toBe('aborted')
    expect(r.retryable).toBe(false)
  })

  it('plain string → unknown', () => {
    const r = normalizeError('something broke')
    expect(r.kind).toBe('unknown')
    expect(r.retryable).toBe(false)
  })

  it('null → unknown', () => {
    expect(normalizeError(null).kind).toBe('unknown')
  })

  it('idempotent: normalizing twice returns same shape', () => {
    const once = normalizeError({ status: 429 })
    const twice = normalizeError(once)
    expect(twice).toBe(once)
  })
})

describe('isRetryable helper', () => {
  it('true for 429', () => {
    expect(isRetryable({ status: 429 })).toBe(true)
  })
  it('false for 400', () => {
    expect(isRetryable({ status: 400 })).toBe(false)
  })
  it('true for network error', () => {
    expect(isRetryable({ code: 'ETIMEDOUT' })).toBe(true)
  })
  it('false for content filter', () => {
    expect(isRetryable({ status: 400, error: { code: 'content_policy_violation' } })).toBe(false)
  })
})
