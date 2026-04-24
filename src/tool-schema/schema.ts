import type { ParameterSchema, JsonSchemaProperty, ParamMeta, ToolMeta } from './types.js'

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

  return { type: 'object', properties, required }
}
