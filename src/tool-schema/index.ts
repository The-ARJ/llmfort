import { buildParameterSchema, toOpenAIStrict } from './schema.js'
import { lintToolSchema, lintUnknownKeywords } from './lint.js'
import type {
  Provider, ToolMeta, ToolSchemaResult,
  OpenAITool, AnthropicTool, GeminiTool, GenericTool,
} from './types.js'

export type { Provider, ToolMeta, ToolSchemaResult, OpenAITool, AnthropicTool, GeminiTool, GenericTool }
export type { JsonSchemaProperty, JsonSchemaType, ParameterSchema, ParamMeta } from './types.js'
export { lintToolSchema, lintUnknownKeywords }
export type { LintWarning, LintResult, LintSeverity } from './lint.js'

/** Generate the provider-specific tool/function-calling envelope for a tool definition. */
export function toolSchema<P extends Provider = 'generic'>(
  meta: ToolMeta,
  provider?: P,
): ToolSchemaResult<P> {
  // OpenAI and Anthropic reject empty tool names; whitespace-only counts as empty.
  const name = meta.name && meta.name.trim() ? meta.name : 'tool'
  const parameters = buildParameterSchema(meta)
  const p = (provider ?? 'generic') as Provider

  if (p === 'openai') {
    return {
      type: 'function',
      function: { name, description: meta.description, parameters: toOpenAIStrict(parameters) },
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

/** Generate every provider envelope at once. */
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

/** Surface per-provider warnings for silent-strip and outright-rejection cases. */
toolSchema.lint = lintToolSchema

/** Audit for unknown JSON-Schema keywords (typos like `minLenght`). */
toolSchema.lintUnknown = lintUnknownKeywords
