import type { JsonSchemaValidator, ValidationIssue, Validator } from './types.js'

export function buildRepairPrompt(
  raw: string,
  issues: ValidationIssue[],
  schema: Validator<unknown>,
): string {
  const schemaSummary = summarizeSchema(schema)
  const bullets = issues.slice(0, 10).map(formatIssue).map(l => `- ${l}`).join('\n')
  const moreThan10 = issues.length > 10 ? `\n- ...and ${issues.length - 10} more` : ''

  return [
    'Your previous response could not be used.',
    '',
    ...(schemaSummary ? ['Expected shape:', schemaSummary, ''] : []),
    'What you returned:',
    truncate(raw, 2000),
    '',
    'Specific problems:',
    bullets + moreThan10,
    '',
    'Return ONLY a valid JSON object that matches the schema.',
    'No prose. No code fences. No explanation. No trailing text.',
  ].join('\n')
}

function formatIssue(iss: ValidationIssue): string {
  const loc = iss.path.length ? `field "${iss.path.join('.')}"` : 'root'
  return `${loc}: ${iss.message}`
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max) + '\n... (truncated)'
}

function summarizeSchema(schema: Validator<unknown>): string | null {
  if (schema && typeof schema === 'object' && !isFunction((schema as any).safeParse)
      && !isFunction((schema as any).parse) && !isFunction((schema as any).validate)) {
    try {
      return JSON.stringify(stripSchema(schema as JsonSchemaValidator), null, 2)
    } catch { return null }
  }

  if ((schema as any)?._def) {
    const summary = summarizeZod((schema as any)._def)
    if (summary) return summary
  }

  if (isFunction((schema as any)?.toJsonSchema)) {
    try {
      return JSON.stringify((schema as any).toJsonSchema(), null, 2)
    } catch { /* ignore */ }
  }

  return null
}

function stripSchema(s: JsonSchemaValidator): JsonSchemaValidator {
  const { $schema, $id, title, description, ...rest } = s as any
  if (rest.properties) {
    rest.properties = Object.fromEntries(
      Object.entries(rest.properties as Record<string, JsonSchemaValidator>).map(
        ([k, v]) => [k, stripSchema(v)],
      ),
    )
  }
  if (rest.items) rest.items = stripSchema(rest.items)
  return rest
}

function summarizeZod(def: any, depth = 0): string | null {
  if (depth > 6) return '...'
  const t = def?.typeName
  switch (t) {
    case 'ZodString':  return 'string'
    case 'ZodNumber':  return 'number'
    case 'ZodBigInt':  return 'bigint'
    case 'ZodBoolean': return 'boolean'
    case 'ZodNull':    return 'null'
    case 'ZodDate':    return 'date (ISO string)'
    case 'ZodLiteral': return `literal ${JSON.stringify(def.value)}`
    case 'ZodEnum':    return `enum ${JSON.stringify(def.values)}`
    case 'ZodOptional':
    case 'ZodNullable':
    case 'ZodDefault':
      return (summarizeZod(def.innerType?._def, depth + 1) ?? 'unknown') + (t === 'ZodOptional' ? '?' : '')
    case 'ZodArray':
      return `${summarizeZod(def.type?._def, depth + 1) ?? 'unknown'}[]`
    case 'ZodObject': {
      const shape = typeof def.shape === 'function' ? def.shape() : def.shape
      if (!shape) return null
      const lines = Object.entries(shape).map(
        ([k, v]: [string, any]) => `  "${k}": ${summarizeZod(v._def, depth + 1) ?? 'unknown'}`,
      )
      return `{\n${lines.join(',\n')}\n}`
    }
    case 'ZodUnion':
      return (def.options ?? []).map((o: any) => summarizeZod(o._def, depth + 1) ?? 'unknown').join(' | ')
    default:
      return null
  }
}

function isFunction(x: unknown): boolean {
  return typeof x === 'function'
}
