/**
 * Validator adapter — duck-types the user-supplied schema so llmfort stays
 * zero-dep while still accepting Zod / Valibot / ArkType / AJV / plain JSON Schema.
 */
import type { JsonSchemaValidator, ValidationIssue, ValidationResult, Validator } from './types.js'
import { looksLikeJsonSchema, validateJsonSchema } from './jsonschema.js'

export function validate<T>(value: unknown, schema: Validator<T>): ValidationResult<T> {
  // --- Zod / Valibot shape: { safeParse(v) -> { success, data } | { success:false, error } } ---
  if (schema && typeof (schema as any).safeParse === 'function') {
    const res = (schema as any).safeParse(value)
    if (res && res.success) return { ok: true, data: res.data as T }
    const issues = normalizeZodIssues(res?.error)
    return { ok: false, issues }
  }

  // --- ArkType / throw-style: { parse(v) -> T, throws on failure } ---
  if (
    schema &&
    typeof (schema as any).parse === 'function' &&
    // Don't confuse with JSON-like "parse" helpers elsewhere — only call if there's no safeParse
    typeof (schema as any).safeParse !== 'function'
  ) {
    try {
      const data = (schema as any).parse(value) as T
      return { ok: true, data }
    } catch (e) {
      return { ok: false, issues: [{ path: [], message: toMessage(e) }] }
    }
  }

  // --- AJV-style: { validate(v) -> boolean, errors: [...] } ---
  if (schema && typeof (schema as any).validate === 'function') {
    const ok = (schema as any).validate(value)
    if (ok) return { ok: true, data: value as T }
    return { ok: false, issues: normalizeAjvErrors((schema as any).errors) }
  }

  // --- Plain JSON Schema object ---
  if (looksLikeJsonSchema(schema)) {
    const issues = validateJsonSchema(value, schema as JsonSchemaValidator)
    if (issues.length === 0) return { ok: true, data: value as T }
    return { ok: false, issues }
  }

  return {
    ok: false,
    issues: [{
      path: [],
      message:
        'Unrecognized schema. Expected something with .safeParse(), .parse(), .validate(), or a JSON Schema object.',
    }],
  }
}

function normalizeZodIssues(err: unknown): ValidationIssue[] {
  if (!err) return [{ path: [], message: 'validation failed' }]
  const zIssues = (err as any).issues ?? (err as any).errors
  if (Array.isArray(zIssues)) {
    return zIssues.map(iss => ({
      path: (iss.path ?? []).map((p: unknown) => String(p)),
      message: String(iss.message ?? 'invalid value'),
      ...(iss.expected ? { expected: String(iss.expected) } : {}),
      ...(iss.received ? { got: String(iss.received) } : {}),
    }))
  }
  return [{ path: [], message: toMessage(err) }]
}

function normalizeAjvErrors(errors: unknown): ValidationIssue[] {
  if (!Array.isArray(errors)) return [{ path: [], message: 'validation failed' }]
  return errors.map(e => ({
    path: String(e.instancePath ?? e.dataPath ?? '').split('/').filter(Boolean),
    message: String(e.message ?? 'invalid value'),
    ...(e.params?.allowedValues ? { expected: JSON.stringify(e.params.allowedValues) } : {}),
  }))
}

function toMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  try { return JSON.stringify(e) } catch { return String(e) }
}
