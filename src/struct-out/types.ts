/** A single validation problem. Path uses JSON-Pointer-like segments. */
export interface ValidationIssue {
  path: string[]
  message: string
  expected?: string
  got?: string
}

export interface ValidationResult<T> {
  ok: boolean
  data?: T
  issues?: ValidationIssue[]
}

/**
 * Adapter shapes tried in order: `safeParse` (Zod/Valibot), `parse` (ArkType),
 * `validate` (AJV), then plain JSON Schema.
 */
export type Validator<T> =
  | { safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: unknown } }
  | { parse: (v: unknown) => T }
  | { validate: (v: unknown) => boolean; errors?: unknown }
  | JsonSchemaValidator

export interface JsonSchemaValidator {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'
  properties?: Record<string, JsonSchemaValidator>
  required?: string[]
  items?: JsonSchemaValidator
  enum?: readonly unknown[]
  minimum?: number
  maximum?: number
  additionalProperties?: boolean
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [k: string]: any
}

export interface RepairContext {
  raw: string
  /** Set if parsing succeeded but validation failed. */
  parsed?: unknown
  issues: ValidationIssue[]
  /** Pre-built fix prompt; pass to your LLM as-is or wrap with your own framing. */
  prompt: string
  /** 1-based: the first repair call is attempt 1. */
  attempt: number
}

export interface AttemptInfo {
  attempt: number
  kind: 'initial' | 'repair'
  stage: 'extract' | 'parse' | 'validate' | 'ok'
  issues?: ValidationIssue[]
  raw?: string
}

export type PartialMode = 'return' | 'null' | 'throw'

export interface StructOutOptions<T> {
  raw: string
  schema: Validator<T>
  /** Async callback invoked on validation failure. Returns the model's new raw response. */
  repair?: (ctx: RepairContext) => Promise<string>
  /** Default 2. */
  maxRetries?: number
  /** Behavior when retries are exhausted. Default `'throw'`. */
  partial?: PartialMode
  signal?: AbortSignal
  onAttempt?: (info: AttemptInfo) => void
}

export type StructOutResult<T> =
  | { ok: true;  data: T;                          attempts: AttemptInfo[] }
  | { ok: false; data: null;                       attempts: AttemptInfo[]; error: StructOutError }
  | { ok: false; partial: Record<string, unknown>; attempts: AttemptInfo[]; error: StructOutError }

export type StructOutErrorKind =
  | 'no_json'
  | 'parse'
  | 'validation'
  | 'exhausted'
  | 'aborted'

export class StructOutError extends Error {
  readonly kind: StructOutErrorKind
  readonly attempts: AttemptInfo[]
  readonly lastRaw?: string
  readonly validationError?: ValidationIssue[]
  readonly cause?: unknown

  constructor(params: {
    kind: StructOutErrorKind
    message: string
    attempts: AttemptInfo[]
    lastRaw?: string
    validationError?: ValidationIssue[]
    cause?: unknown
  }) {
    super(params.message)
    this.name = 'StructOutError'
    this.kind = params.kind
    this.attempts = params.attempts
    if (params.lastRaw !== undefined) this.lastRaw = params.lastRaw
    if (params.validationError !== undefined) this.validationError = params.validationError
    if (params.cause !== undefined) this.cause = params.cause
  }
}
