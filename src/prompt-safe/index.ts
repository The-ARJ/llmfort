import { INJECTION_PATTERNS, JAILBREAK_PATTERNS, PII_PATTERNS, type Pattern } from './patterns.js'
import { scanUntrusted, INDIRECT_PATTERNS, type IndirectScanOptions } from './indirect.js'

export { INDIRECT_PATTERNS, type IndirectScanOptions }

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
    if (p.regex.global) {
      // Stop at one hit per pattern so a single email doesn't produce a flood.
      p.regex.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = p.regex.exec(text)) !== null) {
        if (p.validate && !p.validate(m[0], text, m.index)) continue
        violations.push({ type: p.type, label: p.label, match: m[0] })
        break
      }
      p.regex.lastIndex = 0
    } else {
      const m = p.regex.exec(text)
      if (m && (!p.validate || p.validate(m[0], text, m.index))) {
        violations.push({ type: p.type, label: p.label, match: m[0] })
      }
    }
  }
  return violations
}

/** Scan user input for injection, jailbreak, and PII. Returns a result object; never throws. */
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
  ipv6:        '[REDACTED_IP]',
  passport:    '[REDACTED_PASSPORT]',
  api_key:     '[REDACTED_API_KEY]',
  jwt:         '[REDACTED_JWT]',
}

/** Replace detected PII with `[REDACTED_*]` tokens. Injection/jailbreak text is left intact. */
promptSafe.redact = function redact(text: string): string {
  let result = text
  for (const p of PII_PATTERNS) {
    const replacement = PII_REDACT_MAP[p.label] ?? '[REDACTED]'
    p.regex.lastIndex = 0
    if (p.validate) {
      result = result.replace(p.regex, (match, ..._rest) => {
        const args = _rest as unknown[]
        const original = args[args.length - 1] as string
        const offset = args[args.length - 2] as number
        return p.validate!(match, original, offset) ? replacement : match
      })
    } else {
      result = result.replace(p.regex, replacement)
    }
    p.regex.lastIndex = 0
  }
  return result
}

/** Throw `PromptViolationError` if any violation is detected. */
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

/** Scan a tool result before feeding it back to the model (indirect-injection pattern set). */
promptSafe.scanToolResult = function scanToolResult(
  text: string,
  options?: IndirectScanOptions,
): SafeResult {
  return scanUntrusted(text, options)
}

/** Scan a RAG-retrieved document for indirect-injection indicators. */
promptSafe.scanRetrievedDoc = function scanRetrievedDoc(
  text: string,
  options?: IndirectScanOptions,
): SafeResult {
  return scanUntrusted(text, options)
}

export class PromptViolationError extends Error {
  readonly violations: Violation[]
  constructor(message: string, violations: Violation[]) {
    super(message)
    this.name = 'PromptViolationError'
    this.violations = violations
  }
}
