import { buildParameterSchema } from './schema.js'
import type {
  Provider, ToolMeta, ToolSchemaResult,
  OpenAITool, AnthropicTool, GeminiTool, GenericTool,
} from './types.js'

export type { Provider, ToolMeta, ToolSchemaResult, OpenAITool, AnthropicTool, GeminiTool, GenericTool }
export type { JsonSchemaProperty, JsonSchemaType, ParameterSchema, ParamMeta } from './types.js'

/**
 * Generate a provider-specific tool/function-calling schema from a plain
 * metadata object — no compiler plugins, no decorators, no build step required.
 *
 * @example
 * const schema = toolSchema({
 *   description: 'Get current weather',
 *   params: {
 *     city:  { type: 'string', description: 'City name' },
 *     unit:  { type: 'string', enum: ['C', 'F'], required: false },
 *   }
 * }, 'openai')
 */
export function toolSchema<P extends Provider = 'generic'>(
  meta: ToolMeta,
  provider?: P,
): ToolSchemaResult<P> {
  // Fall back on null, undefined, empty, or whitespace-only names — OpenAI and
  // Anthropic both reject empty tool names, so returning "" would produce an
  // envelope the provider won't accept.
  const name = meta.name && meta.name.trim() ? meta.name : 'tool'
  const parameters = buildParameterSchema(meta)
  const p = (provider ?? 'generic') as Provider

  if (p === 'openai') {
    return {
      type: 'function',
      function: { name, description: meta.description, parameters },
    } satisfies OpenAITool as ToolSchemaResult<P>
  }

  if (p === 'anthropic') {
    return {
      name,
      description: meta.description,
      input_schema: parameters,
    } satisfies AnthropicTool as ToolSchemaResult<P>
  }

  if (p === 'gemini') {
    return {
      functionDeclarations: [{ name, description: meta.description, parameters }],
    } satisfies GeminiTool as ToolSchemaResult<P>
  }

  return {
    name,
    description: meta.description,
    parameters,
  } satisfies GenericTool as ToolSchemaResult<P>
}

/**
 * Convert a single `toolSchema` result into every provider format at once.
 * Useful when you target multiple providers from the same function definition.
 */
export function toolSchemaAll(meta: ToolMeta): {
  openai: OpenAITool
  anthropic: AnthropicTool
  gemini: GeminiTool
  generic: GenericTool
} {
  return {
    openai:    toolSchema(meta, 'openai'),
    anthropic: toolSchema(meta, 'anthropic'),
    gemini:    toolSchema(meta, 'gemini'),
    generic:   toolSchema(meta, 'generic'),
  }
}
