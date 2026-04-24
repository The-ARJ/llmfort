/**
 * Tiny JSON-Schema-subset validator — used when the user passes a plain
 * schema object (as opposed to a Zod/Valibot/ArkType/AJV instance).
 *
 * Covers what LLMs actually emit: type, required, properties, items, enum,
 * minimum/maximum, additionalProperties. Not a full JSON Schema implementation
 * — no $ref, no allOf/anyOf/oneOf, no format, no pattern. If users need that
 * they should bring AJV (which already implements the duck-typed `validate`
 * interface this module consumes).
 */
import type { JsonSchemaValidator, ValidationIssue } from './types.js'

export function validateJsonSchema(
  value: unknown,
  schema: JsonSchemaValidator,
  path: string[] = [],
): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  if (schema.type) {
    const t = typeOf(value)
    const expected = schema.type
    const match = expected === 'integer' ? t === 'number' && Number.isInteger(value) : t === expected
    if (!match) {
      issues.push({
        path,
        message: `expected ${expected}, got ${t}`,
        expected,
        got: t,
      })
      return issues // downstream checks presume the type matches
    }
  }

  if (schema.enum && !schema.enum.includes(value as never)) {
    issues.push({
      path,
      message: `must be one of ${JSON.stringify(schema.enum)}`,
      expected: `one of ${JSON.stringify(schema.enum)}`,
      got: JSON.stringify(value),
    })
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      issues.push({ path, message: `must be >= ${schema.minimum}, got ${value}` })
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      issues.push({ path, message: `must be <= ${schema.maximum}, got ${value}` })
    }
  }

  if (schema.type === 'object' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>
    for (const key of schema.required ?? []) {
      if (!(key in obj)) {
        issues.push({ path: [...path, key], message: `missing required field "${key}"` })
      }
    }
    if (schema.properties) {
      for (const [key, subSchema] of Object.entries(schema.properties)) {
        if (key in obj) {
          issues.push(...validateJsonSchema(obj[key], subSchema, [...path, key]))
        }
      }
    }
    if (schema.additionalProperties === false) {
      const known = new Set(Object.keys(schema.properties ?? {}))
      for (const key of Object.keys(obj)) {
        if (!known.has(key)) {
          issues.push({ path: [...path, key], message: `unexpected extra field "${key}"` })
        }
      }
    }
  }

  if (schema.type === 'array' && Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i++) {
      issues.push(...validateJsonSchema(value[i], schema.items, [...path, String(i)]))
    }
  }

  return issues
}

function typeOf(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v
}

/** Detect whether an unknown object looks like a plain JSON Schema descriptor. */
export function looksLikeJsonSchema(v: unknown): v is JsonSchemaValidator {
  if (v === null || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  if (typeof o.type === 'string') return true
  if (o.properties !== undefined || o.items !== undefined || o.enum !== undefined) return true
  return false
}
