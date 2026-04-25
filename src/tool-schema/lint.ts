import type { JsonSchemaProperty, ParamMeta, Provider, ToolMeta } from './types.js'

export type LintSeverity = 'warn' | 'info'

export interface LintWarning {
  provider: Exclude<Provider, 'generic'>
  severity: LintSeverity
  /** Dot-path to the offending param. */
  path: string[]
  /** Triggering JSON-Schema keyword (e.g. `pattern`, `enum`). */
  keyword?: string
  message: string
}

export interface LintResult {
  warnings: LintWarning[]
  byProvider: Record<Exclude<Provider, 'generic'>, LintWarning[]>
}

const OPENAI: Exclude<Provider, 'generic'>    = 'openai'
const ANTHROPIC: Exclude<Provider, 'generic'> = 'anthropic'
const GEMINI: Exclude<Provider, 'generic'>    = 'gemini'

const ANTHROPIC_HONORED = new Set([
  'type', 'properties', 'required', 'items', 'enum', 'description',
  'additionalProperties',
])

// Keywords Claude accepts but never enforces — they reach the input_schema
// but don't constrain generation. Encode constraints in `description` instead.
const ANTHROPIC_STRIPPED = [
  'minLength', 'maxLength', 'pattern', 'format',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
  'minItems', 'maxItems', 'uniqueItems',
  'default', 'examples', 'multipleOf',
]

// Keywords Gemini rejects in functionDeclarations.
const GEMINI_UNSUPPORTED = [
  '$ref', 'allOf', 'anyOf', 'oneOf', 'not',
  'patternProperties', 'additionalProperties',
  'const', 'examples',
]

const GEMINI_MAX_DEPTH = 5

export function lintToolSchema(meta: ToolMeta): LintResult {
  const warnings: LintWarning[] = []

  if (!meta.description || meta.description.trim().length < 3) {
    warnings.push({
      provider: ANTHROPIC,
      severity: 'warn',
      path: [],
      message: 'Missing or empty `description`. Claude relies heavily on tool descriptions for selection — expect low call-rate.',
    })
  }

  if (meta.name && !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(meta.name)) {
    warnings.push({
      provider: OPENAI,
      severity: 'warn',
      path: [],
      message: `Tool name "${meta.name}" may be rejected. All three providers expect /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.`,
    })
  }

  for (const [name, param] of Object.entries(meta.params ?? {})) {
    walkParam(param, [name], warnings)
  }

  const params = meta.params ?? {}
  const required = new Set(
    Object.entries(params)
      .filter(([, p]) => p.required !== false)
      .map(([k]) => k),
  )
  const optionalKeys = Object.keys(params).filter(k => !required.has(k))
  if (optionalKeys.length > 0) {
    warnings.push({
      provider: OPENAI,
      severity: 'info',
      path: optionalKeys,
      message:
        'Optional parameters detected (required: false). OpenAI strict mode requires every field in `required`; make them required and widen the type to include null instead (or disable strict mode).',
    })
  }

  return {
    warnings,
    byProvider: {
      openai:    warnings.filter(w => w.provider === OPENAI),
      anthropic: warnings.filter(w => w.provider === ANTHROPIC),
      gemini:    warnings.filter(w => w.provider === GEMINI),
    },
  }
}

function walkParam(
  param: ParamMeta | JsonSchemaProperty,
  path: string[],
  warnings: LintWarning[],
  depth = 1,
): void {
  if (depth > GEMINI_MAX_DEPTH) {
    warnings.push({
      provider: GEMINI,
      severity: 'warn',
      path,
      message: `Schema depth exceeds ${GEMINI_MAX_DEPTH}. Gemini may reject this functionDeclaration.`,
    })
  }

  const p = param as unknown as Record<string, unknown>

  for (const keyword of ANTHROPIC_STRIPPED) {
    if (p[keyword] !== undefined) {
      warnings.push({
        provider: ANTHROPIC,
        severity: 'info',
        path,
        keyword,
        message: `\`${keyword}\` is silently stripped from Claude's input_schema. Encode this constraint in the description if you want Claude to honor it.`,
      })
    }
  }

  for (const keyword of GEMINI_UNSUPPORTED) {
    if (p[keyword] !== undefined) {
      warnings.push({
        provider: GEMINI,
        severity: 'warn',
        path,
        keyword,
        message: `Gemini functionDeclarations reject \`${keyword}\`. Remove or restructure.`,
      })
    }
  }

  if (p['default'] !== undefined) {
    warnings.push({
      provider: OPENAI,
      severity: 'warn',
      path,
      keyword: 'default',
      message: 'OpenAI strict mode rejects `default`. Remove it and handle defaults application-side.',
    })
  }

  if (Array.isArray(p.enum) && typeof p.type === 'string') {
    const values = p.enum as unknown[]
    const typeIsString = p.type === 'string'
    const allStrings = values.every(v => typeof v === 'string')
    const typeIsNumber = p.type === 'number' || p.type === 'integer'
    const allNumbers = values.every(v => typeof v === 'number')
    if (typeIsString && !allStrings) {
      warnings.push({
        provider: OPENAI,
        severity: 'warn',
        path,
        keyword: 'enum',
        message: 'Non-string value in enum on a type:"string" property. Normalize to strings.',
      })
    } else if (typeIsNumber && !allNumbers) {
      warnings.push({
        provider: OPENAI,
        severity: 'warn',
        path,
        keyword: 'enum',
        message: 'Non-number value in enum on a numeric property. Normalize.',
      })
    }
  }

  if (p.type === 'object' && p.properties && typeof p.properties === 'object') {
    for (const [k, sub] of Object.entries(p.properties as Record<string, JsonSchemaProperty>)) {
      walkParam(sub, [...path, k], warnings, depth + 1)
    }
  }
  if (p.type === 'array' && p.items) {
    walkParam(p.items as JsonSchemaProperty, [...path, '[]'], warnings, depth + 1)
  }
}

/** List JSON-Schema keys not recognized by any provider — catches typos like `minLenght`. */
export function lintUnknownKeywords(meta: ToolMeta): LintWarning[] {
  const known = new Set([
    ...ANTHROPIC_HONORED,
    ...ANTHROPIC_STRIPPED,
    ...GEMINI_UNSUPPORTED,
    'required',
  ])
  const warnings: LintWarning[] = []
  const walk = (p: Record<string, unknown>, path: string[]) => {
    for (const k of Object.keys(p)) {
      if (!known.has(k) && k !== 'properties' && k !== 'items') {
        if (k === 'required' && path.length > 0) continue
        warnings.push({
          provider: OPENAI,
          severity: 'info',
          path,
          keyword: k,
          message: `Unknown JSON-Schema keyword "${k}". Typo, or provider-specific extension?`,
        })
      }
    }
    if (p.properties && typeof p.properties === 'object') {
      for (const [k, sub] of Object.entries(p.properties as Record<string, unknown>)) {
        walk(sub as Record<string, unknown>, [...path, k])
      }
    }
    if (p.items && typeof p.items === 'object') {
      walk(p.items as Record<string, unknown>, [...path, '[]'])
    }
  }
  for (const [k, v] of Object.entries(meta.params ?? {})) {
    walk(v as unknown as Record<string, unknown>, [k])
  }
  return warnings
}
