/**
 * A single validation problem produced by the validator adapter.
 * Path uses JSON-Pointer-like segments for nested fields (e.g. ['items', '0', 'score']).
 */
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
 * Validator adapter — anything that matches one of these shapes works.
 * In priority order we try: safeParse (Zod/Valibot), parse (ArkType/throw-style),
 * validate (AJV-style), then treat as a plain JSON Schema object.
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
  /** The raw LLM string that failed. */
  raw: string
  /** Parsed object, if parsing succeeded (validation was what failed). */
  parsed?: unknown
  /** Specific validation issues to surface in the repair prompt. */
  issues: ValidationIssue[]
  /** The fully built repair prompt — pass this (or your own) to your LLM. */
  prompt: string
  /** Current attempt index (0-based — first repair call is attempt 1). */
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
  /** Raw LLM response to structure. */
  raw: string
  /** Any validator shape — Zod, Valibot, ArkType, AJV, or a plain JSON Schema object. */
  schema: Validator<T>
  /**
   * Optional async callback the library invokes when validation fails.
   * Receives a RepairContext with a surgical fix prompt; must return the model's new raw response.
   * If omitted, no repair is attempted even if `maxRetries > 0`.
   */
  repair?: (ctx: RepairContext) => Promise<string>
  /** Max repair iterations. Default 2. */
  maxRetries?: number
  /**
   * What to do when retries are exhausted:
   *  - 'throw'  (default): throw StructOutError
   *  - 'null'  : resolve with { ok:false, data:null, error }
   *  - 'return': resolve with { ok:false, partial: <best effort object>, error }
   */
  partial?: PartialMode
  /** Abort the repair loop. */
  signal?: AbortSignal
  /** Observability hook called after every attempt. */
  onAttempt?: (info: AttemptInfo) => void
}

export type StructOutResult<T> =
  | { ok: true;  data: T;                      attempts: AttemptInfo[] }
  | { ok: false; data: null;                   attempts: AttemptInfo[]; error: StructOutError }
  | { ok: false; partial: Record<string, unknown>; attempts: AttemptInfo[]; error: StructOutError }

export type StructOutErrorKind =
  | 'no_json'     // could not find any JSON in the string
  | 'parse'       // found JSON but could not parse it even with repair
  | 'validation'  // parsed but failed validation (only used when repair is disabled or null mode)
  | 'exhausted'   // ran out of retries
  | 'aborted'     // AbortSignal fired, or repair callback threw

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
