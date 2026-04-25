import { describe, it, expect } from 'vitest'
import { toolSchema, toolSchemaAll } from '../src/tool-schema/index.js'

const weatherMeta = {
  name: 'get_weather',
  description: 'Get current weather for a city',
  params: {
    city: { type: 'string' as const, description: 'City name' },
    unit: { type: 'string' as const, enum: ['C', 'F'] as const, required: false },
  },
}

describe('toolSchema — openai', () => {
  it('produces correct top-level shape', () => {
    const schema = toolSchema(weatherMeta, 'openai')
    expect(schema.type).toBe('function')
    expect(schema.function.name).toBe('get_weather')
    expect(schema.function.description).toBe('Get current weather for a city')
  })

  it('places parameters under function.parameters', () => {
    const schema = toolSchema(weatherMeta, 'openai')
    expect(schema.function.parameters.type).toBe('object')
    expect(schema.function.parameters.properties.city.type).toBe('string')
  })

  it('forces every property into required (strict-mode contract)', () => {
    const schema = toolSchema(weatherMeta, 'openai')
    expect(schema.function.parameters.required).toContain('city')
    expect(schema.function.parameters.required).toContain('unit')
    expect(schema.function.parameters.properties.unit?.type).toEqual(['string', 'null'])
  })

  it('Anthropic still uses required-list for optional params', () => {
    const schema = toolSchema(weatherMeta, 'anthropic')
    expect(schema.input_schema.required).toContain('city')
    expect(schema.input_schema.required).not.toContain('unit')
  })

  it('includes enum values', () => {
    const schema = toolSchema(weatherMeta, 'openai')
    expect(schema.function.parameters.properties.unit?.enum).toEqual(['C', 'F'])
  })
})

describe('toolSchema — anthropic', () => {
  it('uses input_schema instead of parameters', () => {
    const schema = toolSchema(weatherMeta, 'anthropic')
    expect(schema.input_schema.type).toBe('object')
    expect('function' in schema).toBe(false)
  })

  it('has name and description at top level', () => {
    const schema = toolSchema(weatherMeta, 'anthropic')
    expect(schema.name).toBe('get_weather')
    expect(schema.description).toBe('Get current weather for a city')
  })
})

describe('toolSchema — gemini', () => {
  it('wraps in functionDeclarations array', () => {
    const schema = toolSchema(weatherMeta, 'gemini')
    expect(Array.isArray(schema.functionDeclarations)).toBe(true)
    expect(schema.functionDeclarations[0]?.name).toBe('get_weather')
  })
})

describe('toolSchema — generic (default)', () => {
  it('returns flat structure with no provider wrapper', () => {
    const schema = toolSchema(weatherMeta)
    expect(schema.name).toBe('get_weather')
    expect(schema.parameters.type).toBe('object')
  })
})

describe('toolSchemaAll', () => {
  it('generates all four formats at once', () => {
    const all = toolSchemaAll(weatherMeta)
    expect(all.openai.type).toBe('function')
    expect(all.anthropic.input_schema).toBeDefined()
    expect(all.gemini.functionDeclarations).toHaveLength(1)
    expect(all.generic.parameters).toBeDefined()
  })

  it('Anthropic and Gemini share the same parameter properties', () => {
    const all = toolSchemaAll(weatherMeta)
    const anthropicProps = all.anthropic.input_schema.properties
    const geminiProps = all.gemini.functionDeclarations[0]!.parameters.properties
    expect(anthropicProps).toEqual(geminiProps)
  })

  it('OpenAI widens optional params with null and forces all keys into required', () => {
    const all = toolSchemaAll(weatherMeta)
    const params = all.openai.function.parameters
    expect(params.required.sort()).toEqual(Object.keys(params.properties).sort())
    expect(params.properties.unit?.type).toEqual(['string', 'null'])
  })
})

describe('toolSchema.lint — provider-specific warnings', () => {
  it('flags Anthropic silent-strip for pattern/minLength/format', () => {
    const { byProvider } = toolSchema.lint({
      description: 'x',
      params: {
        email: { type: 'string', pattern: '^.+@.+$', minLength: 5, maxLength: 100, format: 'email' } as any,
      },
    })
    const keywords = byProvider.anthropic.map(w => w.keyword)
    expect(keywords).toContain('pattern')
    expect(keywords).toContain('minLength')
    expect(keywords).toContain('format')
  })

  it('flags OpenAI strict-mode optional params', () => {
    const { byProvider } = toolSchema.lint({
      description: 'x',
      params: {
        a: { type: 'string' },
        b: { type: 'string', required: false },
      },
    })
    expect(byProvider.openai.some(w => w.message.includes('strict mode'))).toBe(true)
  })

  it('flags Gemini nesting > 5 levels deep', () => {
    const { byProvider } = toolSchema.lint({
      description: 'x',
      params: {
        a: {
          type: 'object',
          properties: {
            b: { type: 'object', properties: {
              c: { type: 'object', properties: {
                d: { type: 'object', properties: {
                  e: { type: 'object', properties: {
                    f: { type: 'object', properties: {
                      g: { type: 'string' },
                    } },
                  } },
                } },
              } },
            } },
          } },
      } as any,
    })
    expect(byProvider.gemini.some(w => w.message.includes('depth'))).toBe(true)
  })

  it('flags empty tool description (Claude needs it)', () => {
    const { byProvider } = toolSchema.lint({ description: '', params: {} })
    expect(byProvider.anthropic.some(w => w.message.includes('description'))).toBe(true)
  })

  it('flags invalid tool name', () => {
    const { byProvider } = toolSchema.lint({
      name: '123 invalid name!',
      description: 'x',
      params: {},
    })
    expect(byProvider.openai.length).toBeGreaterThan(0)
  })

  it('flags `default` field (OpenAI strict rejects it)', () => {
    const { byProvider } = toolSchema.lint({
      description: 'x',
      params: { a: { type: 'string', default: 'hi' } },
    })
    expect(byProvider.openai.some(w => w.keyword === 'default')).toBe(true)
  })

  it('clean schema produces no warnings', () => {
    const { warnings } = toolSchema.lint({
      name: 'get_weather',
      description: 'Get weather for a city',
      params: {
        city: { type: 'string', description: 'The city' },
      },
    })
    expect(warnings).toEqual([])
  })

  it('lintUnknown catches typos', () => {
    const warnings = toolSchema.lintUnknown({
      description: 'x',
      params: {
        a: { type: 'string', minLenght: 5 } as any,  // typo
      },
    })
    expect(warnings.some(w => w.keyword === 'minLenght')).toBe(true)
  })
})

describe('toolSchema — strict-mode compatibility', () => {
  it('emits additionalProperties:false on OpenAI output (required for strict mode)', () => {
    const schema = toolSchema(weatherMeta, 'openai')
    expect(schema.function.parameters.additionalProperties).toBe(false)
  })

  it('emits additionalProperties:false on Anthropic output', () => {
    const schema = toolSchema(weatherMeta, 'anthropic')
    expect(schema.input_schema.additionalProperties).toBe(false)
  })

  it('emits additionalProperties:false on Gemini output', () => {
    const schema = toolSchema(weatherMeta, 'gemini')
    expect(schema.functionDeclarations[0]!.parameters.additionalProperties).toBe(false)
  })
})

describe('toolSchema — edge cases', () => {
  it('defaults name to "tool" when not supplied', () => {
    const schema = toolSchema({ description: 'no name', params: {} }, 'openai')
    expect(schema.function.name).toBe('tool')
  })

  it('defaults name to "tool" when empty string is passed', () => {
    // OpenAI and Anthropic both reject empty tool names.
    const schema = toolSchema({ name: '', description: 'x', params: {} }, 'openai')
    expect(schema.function.name).toBe('tool')
  })

  it('defaults name to "tool" when whitespace-only', () => {
    const schema = toolSchema({ name: '   ', description: 'x', params: {} }, 'anthropic')
    expect(schema.name).toBe('tool')
  })

  it('unknown provider falls back to generic shape (runtime safety)', () => {
    // TypeScript rejects this at compile time; at runtime we default gracefully
    // rather than throw, so JS consumers don't hit an opaque error.
    const schema = toolSchema({ description: 'x', params: {} }, 'mystery' as any) as any
    expect(schema.name).toBe('tool')
    expect(schema.parameters).toBeDefined()
    expect(schema.parameters.additionalProperties).toBe(false)
  })

  it('handles empty params', () => {
    const schema = toolSchema({ description: 'no params', params: {} }, 'openai')
    expect(schema.function.parameters.properties).toEqual({})
    expect(schema.function.parameters.required).toEqual([])
  })

  it('includes description on properties', () => {
    const schema = toolSchema({
      description: 'test',
      params: { x: { type: 'number' as const, description: 'a number' } },
    }, 'generic')
    expect(schema.parameters.properties.x?.description).toBe('a number')
  })
})
