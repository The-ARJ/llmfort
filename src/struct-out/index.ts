import { extract as extractFn } from './extract.js'
import { parse as parseFn } from './parse.js'
import { validate as validateFn } from './validate.js'
import { buildRepairPrompt } from './repair.js'
import {
  StructOutError,
  type AttemptInfo,
  type StructOutOptions,
  type StructOutResult,
  type ValidationIssue,
  type Validator,
} from './types.js'

export type {
  AttemptInfo,
  JsonSchemaValidator,
  PartialMode,
  RepairContext,
  StructOutOptions,
  StructOutResult,
  StructOutErrorKind,
  ValidationIssue,
  ValidationResult,
  Validator,
} from './types.js'
export { StructOutError } from './types.js'

/**
 * Turn a raw LLM response string into a validated, typed object.
 *
 * Pipeline: extract JSON from wrappers → lenient parse → validate → (optional) repair loop.
 *
 * @example
 * const { ok, data } = await structOut({
 *   raw: llmResponse,
 *   schema: MyZodSchema,
 *   repair: async ({ prompt }) => (await llm.chat([...history, { role:'user', content: prompt }])).text,
 * })
 */
export async function structOut<T>(options: StructOutOptions<T>): Promise<StructOutResult<T>> {
  const {
    raw,
    schema,
    repair,
    maxRetries = 2,
    partial = 'throw',
    signal,
    onAttempt,
  } = options

  const attempts: AttemptInfo[] = []
  let currentRaw = raw
  let lastParsed: unknown = undefined
  let lastIssues: ValidationIssue[] = []

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) {
      return finish({
        ok: false,
        kind: 'aborted',
        message: 'aborted',
        attempts,
        lastRaw: currentRaw,
        lastIssues,
        lastParsed,
        partial,
      }) as StructOutResult<T>
    }

    const isInitial = attempt === 0
    const kind: 'initial' | 'repair' = isInitial ? 'initial' : 'repair'

    // --- Extract ---
    const extracted = extractFn(currentRaw)
    if (extracted === null) {
      const info: AttemptInfo = { attempt, kind, stage: 'extract', raw: currentRaw }
      attempts.push(info); onAttempt?.(info)
      if (!shouldRetry(attempt, maxRetries, repair)) {
        return finish({
          ok: false,
          kind: 'no_json',
          message: 'No JSON object found in response.',
          attempts,
          lastRaw: currentRaw,
          lastParsed,
          lastIssues,
          partial,
        }) as StructOutResult<T>
      }
      // Invoke repair with a synthetic "no JSON" issue.
      const issues: ValidationIssue[] = [{ path: [], message: 'response did not contain any JSON' }]
      try {
        currentRaw = await invokeRepair(repair!, currentRaw, undefined, issues, schema, attempt, signal)
      } catch (e) {
        return finish({
          ok: false, kind: 'aborted', message: toMsg(e), attempts,
          lastRaw: currentRaw, lastParsed, lastIssues: issues, partial, cause: e,
        }) as StructOutResult<T>
      }
      continue
    }

    // --- Parse ---
    const parsed = parseFn(extracted)
    if (!parsed.ok) {
      const issues: ValidationIssue[] = [{ path: [], message: parsed.error ?? 'could not parse JSON' }]
      const info: AttemptInfo = { attempt, kind, stage: 'parse', raw: extracted, issues }
      attempts.push(info); onAttempt?.(info)
      if (!shouldRetry(attempt, maxRetries, repair)) {
        return finish({
          ok: false, kind: 'parse',
          message: `Could not parse JSON: ${parsed.error}`,
          attempts, lastRaw: currentRaw, lastParsed, lastIssues: issues, partial,
        }) as StructOutResult<T>
      }
      try {
        currentRaw = await invokeRepair(repair!, extracted, undefined, issues, schema, attempt, signal)
      } catch (e) {
        return finish({
          ok: false, kind: 'aborted', message: toMsg(e), attempts,
          lastRaw: currentRaw, lastParsed, lastIssues: issues, partial, cause: e,
        }) as StructOutResult<T>
      }
      continue
    }

    lastParsed = parsed.value

    // --- Validate ---
    const valid = validateFn<T>(parsed.value, schema)
    if (valid.ok) {
      const info: AttemptInfo = { attempt, kind, stage: 'ok' }
      attempts.push(info); onAttempt?.(info)
      return { ok: true, data: valid.data as T, attempts }
    }

    lastIssues = valid.issues ?? []
    const info: AttemptInfo = { attempt, kind, stage: 'validate', issues: lastIssues, raw: extracted }
    attempts.push(info); onAttempt?.(info)

    if (!shouldRetry(attempt, maxRetries, repair)) {
      return finish({
        ok: false,
        kind: attempt >= maxRetries ? 'exhausted' : 'validation',
        message: summarizeIssues(lastIssues),
        attempts, lastRaw: currentRaw, lastParsed, lastIssues, partial,
      }) as StructOutResult<T>
    }

    try {
      currentRaw = await invokeRepair(repair!, extracted, parsed.value, lastIssues, schema, attempt, signal)
    } catch (e) {
      return finish({
        ok: false, kind: 'aborted', message: toMsg(e), attempts,
        lastRaw: currentRaw, lastParsed, lastIssues, partial, cause: e,
      }) as StructOutResult<T>
    }
  }

  return finish({
    ok: false, kind: 'exhausted',
    message: summarizeIssues(lastIssues),
    attempts, lastRaw: currentRaw, lastParsed, lastIssues, partial,
  }) as StructOutResult<T>
}

// --- Sync helpers (no network, no callback) ---

/** Extract the most likely JSON region from a raw string. Returns null if none found. */
structOut.extract = function (raw: string): string | null {
  return extractFn(raw)
}

/** Extract + lenient parse, no validation. Throws on unparseable input. */
structOut.parse = function (raw: string): unknown {
  const extracted = extractFn(raw)
  if (extracted === null) throw new StructOutError({ kind: 'no_json', message: 'No JSON found.', attempts: [] })
  const p = parseFn(extracted)
  if (!p.ok) throw new StructOutError({ kind: 'parse', message: p.error ?? 'parse failed', attempts: [] })
  return p.value
}

/** Validate an already-parsed value. Useful if you got the object from elsewhere. */
structOut.validate = function <T>(value: unknown, schema: Validator<T>) {
  return validateFn<T>(value, schema)
}

/**
 * Full sync pipeline without repair. Returns ok=true/false.
 * Use when you want one-shot semantics and no network calls.
 */
structOut.parseSafe = function <T>(raw: string, schema: Validator<T>): StructOutResult<T> {
  const extracted = extractFn(raw)
  if (extracted === null) {
    return {
      ok: false, data: null, attempts: [{ attempt: 0, kind: 'initial', stage: 'extract', raw }],
      error: new StructOutError({ kind: 'no_json', message: 'No JSON found.', attempts: [], lastRaw: raw }),
    }
  }
  const p = parseFn(extracted)
  if (!p.ok) {
    return {
      ok: false, data: null, attempts: [{ attempt: 0, kind: 'initial', stage: 'parse', raw: extracted }],
      error: new StructOutError({ kind: 'parse', message: p.error ?? 'parse failed', attempts: [], lastRaw: extracted }),
    }
  }
  const v = validateFn<T>(p.value, schema)
  if (v.ok) return { ok: true, data: v.data as T, attempts: [{ attempt: 0, kind: 'initial', stage: 'ok' }] }
  return {
    ok: false, data: null,
    attempts: [{
      attempt: 0, kind: 'initial', stage: 'validate', raw: extracted,
      ...(v.issues ? { issues: v.issues } : {}),
    }],
    error: new StructOutError({
      kind: 'validation',
      message: summarizeIssues(v.issues ?? []),
      attempts: [],
      lastRaw: extracted,
      validationError: v.issues ?? [],
    }),
  }
}

// --- internals ---

function shouldRetry(attempt: number, maxRetries: number, repair: unknown): boolean {
  return attempt < maxRetries && typeof repair === 'function'
}

async function invokeRepair(
  repair: (ctx: any) => Promise<string>,
  raw: string,
  parsed: unknown,
  issues: ValidationIssue[],
  schema: Validator<unknown>,
  attempt: number,
  signal?: AbortSignal,
): Promise<string> {
  const prompt = buildRepairPrompt(raw, issues, schema)
  const result = await repair({ raw, parsed, issues, prompt, attempt: attempt + 1 })
  if (signal?.aborted) throw new Error('aborted')
  if (typeof result !== 'string' || !result.trim()) {
    throw new Error('repair callback returned empty or non-string response')
  }
  return result
}

interface FinishParams {
  ok: false
  kind: 'no_json' | 'parse' | 'validation' | 'exhausted' | 'aborted'
  message: string
  attempts: AttemptInfo[]
  lastRaw: string
  lastParsed: unknown
  lastIssues: ValidationIssue[]
  partial: 'return' | 'null' | 'throw'
  cause?: unknown
}

function finish(p: FinishParams) {
  const error = new StructOutError({
    kind: p.kind,
    message: p.message,
    attempts: p.attempts,
    lastRaw: p.lastRaw,
    validationError: p.lastIssues,
    cause: p.cause,
  })
  if (p.partial === 'throw') throw error
  if (p.partial === 'null') return { ok: false, data: null, attempts: p.attempts, error }
  // 'return': hand back the best-effort parsed object, if any, so callers can salvage valid fields.
  const salvaged = salvagePartial(p.lastParsed, p.lastIssues)
  return { ok: false, partial: salvaged, attempts: p.attempts, error }
}

/**
 * Given a parsed object and its validation issues, return an object containing
 * only the fields that did NOT have issues at their exact path.
 */
function salvagePartial(parsed: unknown, issues: ValidationIssue[]): Record<string, unknown> {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const bad = new Set(issues.map(i => i.path[0]).filter(Boolean) as string[])
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (!bad.has(k)) out[k] = v
  }
  return out
}

function summarizeIssues(issues: ValidationIssue[]): string {
  if (issues.length === 0) return 'validation failed'
  const first = issues.slice(0, 3).map(i => {
    const loc = i.path.length ? i.path.join('.') : 'root'
    return `${loc}: ${i.message}`
  }).join('; ')
  const more = issues.length > 3 ? ` (+${issues.length - 3} more)` : ''
  return first + more
}

function toMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
