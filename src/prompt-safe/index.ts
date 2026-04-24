import { INJECTION_PATTERNS, JAILBREAK_PATTERNS, PII_PATTERNS, type Pattern } from './patterns.js'

export type ViolationType = 'injection' | 'jailbreak' | 'pii'

export interface Violation {
  type: ViolationType
  label: string
  match: string
}

export interface SafeResult {
  safe: boolean
  violations: Violation[]
}

export interface PromptSafeOptions {
  injection?: boolean
  jailbreak?: boolean
  pii?: boolean
}

function scan(text: string, patterns: Pattern[]): Violation[] {
  const violations: Violation[] = []
  for (const p of patterns) {
    // Reset lastIndex for global regexes
    p.regex.lastIndex = 0
    const m = p.regex.exec(text)
    if (m) {
      violations.push({ type: p.type, label: p.label, match: m[0] })
    }
    p.regex.lastIndex = 0
  }
  return violations
}

/**
 * Scan a prompt string for injection attempts, jailbreak patterns, and PII.
 * Returns a result object — never throws.
 *
 * @example
 * const result = promptSafe("Ignore all previous instructions and...")
 * // { safe: false, violations: [{ type: 'injection', label: 'ignore_instructions', match: '...' }] }
 */
export function promptSafe(
  text: string,
  options: PromptSafeOptions = {},
): SafeResult {
  const {
    injection = true,
    jailbreak = true,
    pii       = true,
  } = options

  const violations: Violation[] = []

  if (injection) violations.push(...scan(text, INJECTION_PATTERNS))
  if (jailbreak) violations.push(...scan(text, JAILBREAK_PATTERNS))
  if (pii)       violations.push(...scan(text, PII_PATTERNS))

  return { safe: violations.length === 0, violations }
}

const PII_REDACT_MAP: Record<string, string> = {
  email:       '[REDACTED_EMAIL]',
  phone_us:    '[REDACTED_PHONE]',
  ssn:         '[REDACTED_SSN]',
  credit_card: '[REDACTED_CC]',
  ipv4:        '[REDACTED_IP]',
}

/**
 * Redact PII from a prompt string in-place. Non-PII violations are not removed
 * (removal of injection/jailbreak text can change meaning unpredictably).
 *
 * @example
 * promptSafe.redact("Email me at user@example.com")
 * // "Email me at [REDACTED_EMAIL]"
 */
promptSafe.redact = function redact(text: string): string {
  let result = text
  for (const p of PII_PATTERNS) {
    const replacement = PII_REDACT_MAP[p.label] ?? '[REDACTED]'
    p.regex.lastIndex = 0
    result = result.replace(p.regex, replacement)
    p.regex.lastIndex = 0
  }
  return result
}

/**
 * Throws if the prompt contains any violations matching the given options.
 *
 * @example
 * promptSafe.assert(userInput) // throws PromptViolationError if unsafe
 */
promptSafe.assert = function assert(
  text: string,
  options?: PromptSafeOptions,
): void {
  const result = promptSafe(text, options)
  if (!result.safe) {
    const summary = result.violations.map(v => `${v.type}:${v.label}`).join(', ')
    throw new PromptViolationError(`Prompt violations detected: ${summary}`, result.violations)
  }
}

export class PromptViolationError extends Error {
  readonly violations: Violation[]
  constructor(message: string, violations: Violation[]) {
    super(message)
    this.name = 'PromptViolationError'
    this.violations = violations
  }
}
