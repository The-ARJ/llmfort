import type { JsonSchemaValidator, ValidationIssue, ValidationResult, Validator } from './types.js'
import { looksLikeJsonSchema, validateJsonSchema } from './jsonschema.js'

export function validate<T>(value: unknown, schema: Validator<T>): ValidationResult<T> {
  // Zod / Valibot
  if (schema && typeof (schema as any).safeParse === 'function') {
    const res = (schema as any).safeParse(value)
    if (res && res.success) return { ok: true, data: res.data as T }
    return { ok: false, issues: normalizeZodIssues(res?.error) }
  }

  // ArkType / throw-style
  if (schema && typeof (schema as any).parse === 'function'
      && typeof (schema as any).safeParse !== 'function') {
    try {
      return { ok: true, data: (schema as any).parse(value) as T }
    } catch (e) {
      return { ok: false, issues: [{ path: [], message: toMessage(e) }] }
    }
  }

  // AJV-style
  if (schema && typeof (schema as any).validate === 'function') {
    const ok = (schema as any).validate(value)
    if (ok) return { ok: true, data: value as T }
    return { ok: false, issues: normalizeAjvErrors((schema as any).errors) }
  }

  // Plain JSON Schema object
  if (looksLikeJsonSchema(schema)) {
    const issues = validateJsonSchema(value, schema as JsonSchemaValidator)
    if (issues.length === 0) return { ok: true, data: value as T }
    return { ok: false, issues }
  }

  return {
    ok: false,
    issues: [{
      path: [],
      message: 'Unrecognized schema: expected .safeParse(), .parse(), .validate(), or a JSON Schema object.',
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
