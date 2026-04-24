export interface Pattern {
  type: 'injection' | 'jailbreak' | 'pii'
  label: string
  regex: RegExp
}

export const INJECTION_PATTERNS: Pattern[] = [
  { type: 'injection', label: 'ignore_instructions',  regex: /ignore\s+(all\s+)?(previous|prior|above)\s+instructions?/i },
  { type: 'injection', label: 'disregard_instructions', regex: /disregard\s+(all\s+)?(previous|prior|above)\s+instructions?/i },
  { type: 'injection', label: 'system_override',      regex: /\bsystem\s*:\s*you\s+are\b/i },
  { type: 'injection', label: 'new_instructions',     regex: /\bnew\s+instructions?\s*:/i },
  { type: 'injection', label: 'override_directive',   regex: /\boverride\s+(previous\s+)?instructions?\b/i },
  { type: 'injection', label: 'forget_instructions',  regex: /forget\s+(everything|all)\s+(you('ve| have)\s+been\s+told|instructions?)/i },
  { type: 'injection', label: 'prompt_leak',          regex: /\brepeat\s+(your\s+)?(system\s+)?prompt\b/i },
  { type: 'injection', label: 'role_switch',          regex: /\b(act|behave|pretend)\s+as\s+(if\s+you\s+are|a\s+)/i },
]

export const JAILBREAK_PATTERNS: Pattern[] = [
  { type: 'jailbreak', label: 'dan',                  regex: /\bDAN\b.*\bjailbreak\b|\bjailbreak\b.*\bDAN\b/i },
  { type: 'jailbreak', label: 'do_anything_now',      regex: /do\s+anything\s+now/i },
  { type: 'jailbreak', label: 'hypothetically',       regex: /hypothetically[\s,]+if\s+(you\s+)?were\s+(not|an?\s+AI|allowed)/i },
  { type: 'jailbreak', label: 'base64_payload',       regex: /base64[_\s]?decode|atob\s*\(/i },
  { type: 'jailbreak', label: 'developer_mode',       regex: /\bdeveloper\s+mode\b.*\benable\b|\benable\b.*\bdeveloper\s+mode\b/i },
  { type: 'jailbreak', label: 'stay_in_character',    regex: /stay\s+in\s+character|never\s+break\s+character/i },
  { type: 'jailbreak', label: 'no_restrictions',      regex: /without\s+(any\s+)?restrictions?|bypass\s+(your\s+)?filter/i },
]

export const PII_PATTERNS: Pattern[] = [
  { type: 'pii', label: 'email',        regex: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g },
  { type: 'pii', label: 'phone_us',     regex: /\b(\+?1[\s\-.]?)?\(?\d{3}\)?[\s\-.]?\d{3}[\s\-.]?\d{4}\b/g },
  { type: 'pii', label: 'ssn',          regex: /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/g },
  { type: 'pii', label: 'credit_card',  regex: /\b(?:4\d{12}(?:\d{3})?|5[1-5]\d{14}|3[47]\d{13}|3(?:0[0-5]|[68]\d)\d{11}|6(?:011|5\d{2})\d{12})\b/g },
  { type: 'pii', label: 'ipv4',         regex: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g },
]
