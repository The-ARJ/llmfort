import { describe, it, expect, vi } from 'vitest'
import { structOut, StructOutError } from '../src/struct-out/index.js'

// ----- Fixtures -----

const titleScoreSchema = {
  type: 'object' as const,
  required: ['title', 'score'],
  additionalProperties: false,
  properties: {
    title: { type: 'string' as const },
    score: { type: 'number' as const, minimum: 0, maximum: 10 },
  },
}

const rawFencedJson = `Here is the result:

\`\`\`json
{
  "title": "Getting started with Node.js",
  "score": 8
}
\`\`\`

Let me know if you need anything else!`

const rawWithExtraField = `\`\`\`json
{
  "title": "X",
  "score": 5,
  "note": "shouldn't be here"
}
\`\`\``

const rawWrongType = `{"title":"X","score":"high"}`

const rawTruncated = `{"title":"Getting started with Node.js","score":8,"tags":["node","js"`

const rawTrailingComma = `{"title":"X","score":7,}`

const rawSingleQuotes = `{'title':'X','score':4}`

const rawWithComments = `// hello
{
  "title": "X", // this is the title
  /* block
     comment */
  "score": 6
}`

const rawBare = `{"title":"bare","score":1}`

const rawMultipleBlocks = `Example of what NOT to do:
\`\`\`json
{"title":"bad","score":-1}
\`\`\`

Actual answer:
\`\`\`json
{"title":"good","score":9}
\`\`\``

const rawPreamble = `Here's the JSON: {"title":"T","score":3}`

const rawNoJson = `I can't answer that question. Please ask something else.`

const rawUnicode = `{"title":"smart “quotes”","score":2}`

// ----- Extract -----

describe('structOut.extract', () => {
  it('finds JSON inside a ```json fence', () => {
    expect(structOut.extract(rawFencedJson)).toContain('"title"')
  })

  it('finds bare JSON with no wrapper', () => {
    expect(structOut.extract(rawBare)).toBe(rawBare)
  })

  it('finds JSON after a preamble', () => {
    const out = structOut.extract(rawPreamble)
    expect(out).toContain('"score":3')
  })

  it('picks the LAST block when multiple are present', () => {
    const out = structOut.extract(rawMultipleBlocks)
    expect(out).toContain('"good"')
    expect(out).not.toContain('"bad"')
  })

  it('returns null for pure prose with no JSON', () => {
    expect(structOut.extract(rawNoJson)).toBeNull()
  })

  it('returns null for empty input', () => {
    expect(structOut.extract('')).toBeNull()
    expect(structOut.extract('   ')).toBeNull()
  })

  it('ignores braces inside string values', () => {
    const out = structOut.extract(`{"msg":"use { and } in strings","ok":true}`)
    expect(out).toContain('use { and } in strings')
  })
})

// ----- Parse -----

describe('structOut.parse (lenient)', () => {
  it('parses strict JSON', () => {
    expect(structOut.parse(rawBare)).toEqual({ title: 'bare', score: 1 })
  })

  it('recovers from trailing commas', () => {
    expect(structOut.parse(rawTrailingComma)).toEqual({ title: 'X', score: 7 })
  })

  it('recovers from single-quoted JS-style objects', () => {
    expect(structOut.parse(rawSingleQuotes)).toEqual({ title: 'X', score: 4 })
  })

  it('strips // and /* */ comments', () => {
    expect(structOut.parse(rawWithComments)).toEqual({ title: 'X', score: 6 })
  })

  it('closes truncated objects (mid-value cutoff)', () => {
    const parsed = structOut.parse(rawTruncated) as any
    expect(parsed.title).toBe('Getting started with Node.js')
    expect(parsed.score).toBe(8)
    expect(Array.isArray(parsed.tags)).toBe(true)
    expect(parsed.tags).toContain('node')
  })

  it('normalizes curly (smart) quotes inside values', () => {
    const parsed = structOut.parse(rawUnicode) as any
    expect(parsed.score).toBe(2)
  })

  it('throws on pure prose', () => {
    expect(() => structOut.parse(rawNoJson)).toThrow(StructOutError)
  })

  it('normalizes NaN / Infinity / undefined to null', () => {
    const p = structOut.parse('{"a": NaN, "b": Infinity, "c": -Infinity, "d": undefined}') as any
    expect(p.a).toBeNull()
    expect(p.b).toBeNull()
    expect(p.c).toBeNull()
    expect(p.d).toBeNull()
  })

  it('parses unquoted hyphenated keys (e.g. content-type)', () => {
    const p = structOut.parse('{content-type: "application/json", status: 200}') as any
    expect(p['content-type']).toBe('application/json')
    expect(p.status).toBe(200)
  })

  it('does not rewrite JS literals in string values', () => {
    const p = structOut.parse('{"msg": "NaN is not a number"}') as any
    expect(p.msg).toBe('NaN is not a number')
  })
})

// ----- Validate (plain JSON Schema) -----

describe('structOut.validate with plain JSON Schema', () => {
  it('accepts valid object', () => {
    const r = structOut.validate({ title: 'X', score: 5 }, titleScoreSchema)
    expect(r.ok).toBe(true)
  })

  it('rejects wrong type', () => {
    const r = structOut.validate({ title: 'X', score: 'high' }, titleScoreSchema)
    expect(r.ok).toBe(false)
    expect(r.issues?.[0]?.path).toEqual(['score'])
    expect(r.issues?.[0]?.message).toMatch(/number/)
  })

  it('rejects extra field when additionalProperties is false', () => {
    const r = structOut.validate({ title: 'X', score: 5, note: 'bad' }, titleScoreSchema)
    expect(r.ok).toBe(false)
    expect(r.issues?.some(i => i.path[0] === 'note')).toBe(true)
  })

  it('rejects missing required', () => {
    const r = structOut.validate({ title: 'X' }, titleScoreSchema)
    expect(r.ok).toBe(false)
    expect(r.issues?.some(i => i.message.includes('score'))).toBe(true)
  })

  it('enforces minimum/maximum', () => {
    const r = structOut.validate({ title: 'X', score: 42 }, titleScoreSchema)
    expect(r.ok).toBe(false)
    expect(r.issues?.[0]?.message).toMatch(/<=/)
  })
})

// ----- parseSafe (sync, no repair) -----

describe('structOut.parseSafe', () => {
  it('returns ok=true for a clean response', () => {
    const r = structOut.parseSafe(rawFencedJson, titleScoreSchema)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data).toEqual({ title: 'Getting started with Node.js', score: 8 })
  })

  it('returns ok=false with error.kind=no_json on prose', () => {
    const r = structOut.parseSafe(rawNoJson, titleScoreSchema)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.kind).toBe('no_json')
      expect(r.data).toBeNull()
    }
  })

  it('returns ok=false with error.kind=validation on extra field', () => {
    const r = structOut.parseSafe(rawWithExtraField, titleScoreSchema)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.kind).toBe('validation')
      expect(r.error.validationError?.[0]?.path[0]).toBe('note')
    }
  })
})

// ----- Async structOut with repair callback -----

describe('structOut — repair loop', () => {
  it('returns ok=true on first try when response is already valid', async () => {
    const repair = vi.fn()
    const result = await structOut({
      raw: rawFencedJson,
      schema: titleScoreSchema,
      repair,
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data).toEqual({ title: 'Getting started with Node.js', score: 8 })
    expect(repair).not.toHaveBeenCalled()
  })

  it('calls repair when validation fails, succeeds on second try', async () => {
    const repair = vi.fn().mockResolvedValue(`{"title":"X","score":5}`)
    const result = await structOut({
      raw: rawWrongType,
      schema: titleScoreSchema,
      repair,
    })
    expect(result.ok).toBe(true)
    expect(repair).toHaveBeenCalledTimes(1)
    expect(result.attempts.length).toBe(2) // initial + 1 repair
  })

  it('repair prompt contains specific error location and message', async () => {
    let capturedPrompt = ''
    await structOut({
      raw: rawWrongType,
      schema: titleScoreSchema,
      repair: async ({ prompt }) => {
        capturedPrompt = prompt
        return `{"title":"X","score":5}`
      },
    })
    expect(capturedPrompt).toContain('score')
    expect(capturedPrompt).toMatch(/number|string/i)
    expect(capturedPrompt).toContain('Return ONLY')
  })

  it('respects maxRetries', async () => {
    const repair = vi.fn().mockResolvedValue(rawWrongType) // never fixes it
    await expect(structOut({
      raw: rawWrongType,
      schema: titleScoreSchema,
      repair,
      maxRetries: 2,
    })).rejects.toBeInstanceOf(StructOutError)
    expect(repair).toHaveBeenCalledTimes(2)
  })

  it('kind=exhausted when retries run out', async () => {
    try {
      await structOut({
        raw: rawWrongType,
        schema: titleScoreSchema,
        repair: async () => rawWrongType,
        maxRetries: 1,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(StructOutError)
      expect((e as StructOutError).kind).toBe('exhausted')
    }
  })

  it('partial:"return" salvages valid fields', async () => {
    const result = await structOut({
      raw: rawWithExtraField, // title + score valid, note is extra
      schema: titleScoreSchema,
      maxRetries: 0,
      partial: 'return',
    })
    expect(result.ok).toBe(false)
    if (!result.ok && 'partial' in result) {
      expect(result.partial.title).toBe('X')
      expect(result.partial.score).toBe(5)
      expect(result.partial.note).toBeUndefined()
    }
  })

  it('partial:"null" returns data=null', async () => {
    const result = await structOut({
      raw: rawNoJson,
      schema: titleScoreSchema,
      maxRetries: 0,
      partial: 'null',
    })
    expect(result.ok).toBe(false)
    if (!result.ok && 'data' in result) expect(result.data).toBeNull()
  })

  it('partial:"throw" (default) throws StructOutError', async () => {
    await expect(structOut({
      raw: rawNoJson,
      schema: titleScoreSchema,
      maxRetries: 0,
    })).rejects.toBeInstanceOf(StructOutError)
  })

  it('AbortSignal aborts the repair loop', async () => {
    const ac = new AbortController()
    const repair = vi.fn(async () => {
      ac.abort()
      return rawWrongType
    })
    try {
      await structOut({
        raw: rawWrongType,
        schema: titleScoreSchema,
        repair,
        signal: ac.signal,
      })
    } catch (e) {
      expect(e).toBeInstanceOf(StructOutError)
      expect((e as StructOutError).kind).toBe('aborted')
    }
  })

  it('repair callback returning empty string surfaces as aborted', async () => {
    try {
      await structOut({
        raw: rawWrongType,
        schema: titleScoreSchema,
        repair: async () => '',
      })
    } catch (e) {
      expect(e).toBeInstanceOf(StructOutError)
      expect((e as StructOutError).kind).toBe('aborted')
    }
  })

  it('onAttempt is called for each attempt', async () => {
    const seen: string[] = []
    await structOut({
      raw: rawWrongType,
      schema: titleScoreSchema,
      repair: async () => `{"title":"X","score":5}`,
      onAttempt: (info) => seen.push(info.stage),
    })
    expect(seen).toContain('validate')
    expect(seen).toContain('ok')
  })
})

// ----- Zod-shape adapter (duck-typed, no zod dep) -----

describe('structOut validator adapter — safeParse shape', () => {
  const zodLike = {
    safeParse(v: unknown) {
      if (typeof v !== 'object' || v === null) {
        return { success: false, error: { issues: [{ path: [], message: 'expected object' }] } }
      }
      const o = v as Record<string, unknown>
      if (typeof o.title !== 'string') {
        return { success: false, error: { issues: [{ path: ['title'], message: 'expected string' }] } }
      }
      return { success: true, data: o as { title: string } }
    },
  }

  it('accepts valid input via safeParse', () => {
    const r = structOut.parseSafe(`{"title":"hi"}`, zodLike)
    expect(r.ok).toBe(true)
  })

  it('surfaces safeParse issues with correct paths', () => {
    const r = structOut.parseSafe(`{"title":123}`, zodLike)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.validationError?.[0]?.path).toEqual(['title'])
    }
  })
})

describe('structOut validator adapter — throw-style parse', () => {
  const arkLike = {
    parse(v: unknown) {
      if (typeof v !== 'object' || !v || !('n' in v) || typeof (v as any).n !== 'number') {
        throw new Error('expected { n: number }')
      }
      return v
    },
  }

  it('returns ok=true when parse succeeds', () => {
    const r = structOut.parseSafe(`{"n":42}`, arkLike)
    expect(r.ok).toBe(true)
  })

  it('catches throw and surfaces message', () => {
    const r = structOut.parseSafe(`{"n":"nope"}`, arkLike)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.validationError?.[0]?.message).toMatch(/number/)
    }
  })
})

describe('structOut validator adapter — AJV-style validate+errors', () => {
  const ajvLike = {
    errors: null as any,
    validate(this: { errors: any }, v: unknown) {
      if (typeof (v as any)?.x === 'number') { this.errors = null; return true }
      this.errors = [{ instancePath: '/x', message: 'must be number' }]
      return false
    },
  }

  it('returns ok=true on validate success', () => {
    const r = structOut.parseSafe(`{"x":1}`, ajvLike as any)
    expect(r.ok).toBe(true)
  })

  it('normalizes AJV errors', () => {
    const r = structOut.parseSafe(`{"x":"no"}`, ajvLike as any)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.validationError?.[0]?.path).toEqual(['x'])
    }
  })
})
