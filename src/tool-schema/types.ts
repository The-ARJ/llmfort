export type Provider = 'openai' | 'anthropic' | 'gemini' | 'generic'

export type JsonSchemaType =
  | 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null'

export interface JsonSchemaProperty {
  type: JsonSchemaType | JsonSchemaType[]
  description?: string
  enum?: (string | number | boolean | null)[]
  items?: JsonSchemaProperty
  properties?: Record<string, JsonSchemaProperty>
  required?: string[]
  minimum?: number
  maximum?: number
  default?: unknown
}

export interface ParameterSchema {
  type: 'object'
  properties: Record<string, JsonSchemaProperty>
  required: string[]
  additionalProperties?: boolean
}

/** OpenAI / OpenAI-compatible tool envelope. */
export interface OpenAITool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: ParameterSchema
  }
}

/** Anthropic tool envelope. */
export interface AnthropicTool {
  name: string
  description: string
  input_schema: ParameterSchema
}

/** Gemini functionDeclarations envelope. */
export interface GeminiTool {
  functionDeclarations: Array<{
    name: string
    description: string
    parameters: ParameterSchema
  }>
}

/** Unwrapped schema, no provider envelope. */
export interface GenericTool {
  name: string
  description: string
  parameters: ParameterSchema
}

export type ToolSchemaResult<P extends Provider> =
  P extends 'openai'    ? OpenAITool    :
  P extends 'anthropic' ? AnthropicTool :
  P extends 'gemini'    ? GeminiTool    :
  GenericTool

export interface ParamMeta {
  type: JsonSchemaType | JsonSchemaType[]
  description?: string
  enum?: (string | number | boolean | null)[]
  required?: boolean
  items?: JsonSchemaProperty
  minimum?: number
  maximum?: number
  default?: unknown
}

export interface ToolMeta {
  name?: string
  description: string
  params: Record<string, ParamMeta>
}
