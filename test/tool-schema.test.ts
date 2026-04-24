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

  it('marks required params correctly', () => {
    const schema = toolSchema(weatherMeta, 'openai')
    expect(schema.function.parameters.required).toContain('city')
    expect(schema.function.parameters.required).not.toContain('unit')
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

  it('all formats share the same parameter properties', () => {
    const all = toolSchemaAll(weatherMeta)
    const openaiProps = all.openai.function.parameters.properties
    const anthropicProps = all.anthropic.input_schema.properties
    const geminiProps = all.gemini.functionDeclarations[0]!.parameters.properties
    expect(openaiProps).toEqual(anthropicProps)
    expect(anthropicProps).toEqual(geminiProps)
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
