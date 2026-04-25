import type { ParameterSchema, JsonSchemaProperty, ParamMeta, ToolMeta, JsonSchemaType } from './types.js'

function metaToProperty(meta: ParamMeta): JsonSchemaProperty {
  const prop: JsonSchemaProperty = { type: meta.type }
  if (meta.description !== undefined) prop.description = meta.description
  if (meta.enum !== undefined) prop.enum = meta.enum
  if (meta.items !== undefined) prop.items = meta.items
  if (meta.minimum !== undefined) prop.minimum = meta.minimum
  if (meta.maximum !== undefined) prop.maximum = meta.maximum
  if (meta.default !== undefined) prop.default = meta.default
  return prop
}

export function buildParameterSchema(toolMeta: ToolMeta): ParameterSchema {
  const properties: Record<string, JsonSchemaProperty> = {}
  const required: string[] = []

  for (const [name, meta] of Object.entries(toolMeta.params)) {
    properties[name] = metaToProperty(meta)
    if (meta.required !== false) required.push(name)
  }

  return { type: 'object', properties, required, additionalProperties: false }
}

/** Rewrite a schema for OpenAI strict mode: every property in `required`, optionals widened with `null`. */
export function toOpenAIStrict(schema: ParameterSchema): ParameterSchema {
  const allKeys = Object.keys(schema.properties)
  const wasRequired = new Set(schema.required)

  const properties: Record<string, JsonSchemaProperty> = {}
  for (const [name, prop] of Object.entries(schema.properties)) {
    properties[name] = wasRequired.has(name) ? prop : widenWithNull(prop)
  }

  return { type: 'object', properties, required: allKeys, additionalProperties: false }
}

function widenWithNull(prop: JsonSchemaProperty): JsonSchemaProperty {
  if (Array.isArray(prop.type)) {
    if (prop.type.includes('null')) return prop
    return { ...prop, type: [...prop.type, 'null' as JsonSchemaType] }
  }
  if (prop.type === 'null') return prop
  return { ...prop, type: [prop.type, 'null' as JsonSchemaType] }
}
