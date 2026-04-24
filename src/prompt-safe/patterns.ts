export interface Pattern {
  type: 'injection' | 'jailbreak' | 'pii'
  label: string
  regex: RegExp
}

export const INJECTION_PATTERNS: Pattern[] = [
  { type: 'injection', label: 'ignore_instructions',    regex: /ignore\s+(all\s+)?(previous|prior|above)\s+instructions?/i },
  { type: 'injection', label: 'disregard_instructions', regex: /disregard\s+(all\s+)?(previous|prior|above)\s+instructions?/i },
  { type: 'injection', label: 'system_override',        regex: /\bsystem\s*:\s*you\s+are\b/i },
  { type: 'injection', label: 'new_instructions',       regex: /\bnew\s+instructions?\s*:/i },
  { type: 'injection', label: 'override_directive',     regex: /\boverride\s+(previous\s+)?instructions?\b/i },
  { type: 'injection', label: 'forget_instructions',    regex: /forget\s+(everything|all)\s+(you('ve| have)\s+been\s+told|instructions?)/i },
  { type: 'injection', label: 'prompt_leak',            regex: /\brepeat\s+(your\s+)?(system\s+)?prompt\b/i },
  { type: 'injection', label: 'role_switch',            regex: /\b(act|behave|pretend)\s+as\s+(if\s+you\s+are|a\s+)/i },
  // Translate-and-leak: tricks the model into revealing hidden context
  { type: 'injection', label: 'translate_leak',         regex: /translate\s+(the\s+)?(above|previous|following|everything)\s+(text|content|instructions?|conversation)/i },
  // Instruction extraction via summary
  { type: 'injection', label: 'summarize_instructions', regex: /summarize\s+(your\s+)?(system\s+)?(prompt|instructions?|context|rules)/i },
  // XML/token injection used to break context in chat models
  { type: 'injection', label: 'xml_token_injection',    regex: /<\|?(im_start|im_end|system|user|assistant|endoftext)\|?>/i },
  // Unicode direction override (invisible text used for smuggling)
  { type: 'injection', label: 'unicode_smuggling',      regex: /[\u202A-\u202E\u2066-\u2069\u200B-\u200F\uFEFF]/ },
  // "What did I say / what are your instructions" extraction
  { type: 'injection', label: 'context_extraction',     regex: /what\s+(did\s+i\s+(say|tell\s+you)|are\s+your\s+(instructions?|rules|guidelines))/i },
]

export const JAILBREAK_PATTERNS: Pattern[] = [
  { type: 'jailbreak', label: 'dan',                  regex: /\bDAN\b.*\bjailbreak\b|\bjailbreak\b.*\bDAN\b/i },
  { type: 'jailbreak', label: 'do_anything_now',      regex: /do\s+anything\s+now/i },
  { type: 'jailbreak', label: 'hypothetically',       regex: /hypothetically[\s,]+if\s+(you\s+)?were\s+(not|an?\s+AI|allowed)/i },
  { type: 'jailbreak', label: 'base64_payload',       regex: /base64[_\s]?decode|atob\s*\(/i },
  { type: 'jailbreak', label: 'developer_mode',       regex: /\bdeveloper\s+mode\b.*\benable\b|\benable\b.*\bdeveloper\s+mode\b/i },
  { type: 'jailbreak', label: 'stay_in_character',    regex: /stay\s+in\s+character|never\s+break\s+character/i },
  { type: 'jailbreak', label: 'no_restrictions',      regex: /without\s+(any\s+)?restrictions?|bypass\s+(your\s+)?filter/i },
  // "Opposite mode" / "evil mode" / "anti-GPT" variants
  { type: 'jailbreak', label: 'opposite_mode',        regex: /\b(opposite|evil|chaos|shadow|dark)\s+(mode|GPT|AI|version)\b/i },
  // Grandma / fictional persona exploit
  { type: 'jailbreak', label: 'persona_exploit',      regex: /pretend\s+(you\s+)?(have\s+no\s+(guidelines|restrictions?|rules)|you('re| are)\s+(my\s+)?(grandma|deceased|dead|jailbroken))/i },
  // "Simulation" framing to bypass guardrails
  { type: 'jailbreak', label: 'simulation_framing',   regex: /\bsimulat(e|ing|ion)\s+(a\s+)?(world|reality|scenario|AI|model)\s+(where|without|that\s+(has\s+no|ignores?))/i },
  // Token budget / overflow attack
  { type: 'jailbreak', label: 'token_overflow',       regex: /repeat\s+the\s+word\s+\w+\s+\d{3,}\s+times?/i },
]

export const PII_PATTERNS: Pattern[] = [
  { type: 'pii', label: 'email',        regex: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g },
  { type: 'pii', label: 'phone_us',     regex: /\b(\+?1[\s\-.]?)?\(?\d{3}\)?[\s\-.]?\d{3}[\s\-.]?\d{4}\b/g },
  { type: 'pii', label: 'ssn',          regex: /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/g },
  { type: 'pii', label: 'credit_card',  regex: /\b(?:4\d{12}(?:\d{3})?|5[1-5]\d{14}|3[47]\d{13}|3(?:0[0-5]|[68]\d)\d{11}|6(?:011|5\d{2})\d{12})\b/g },
  { type: 'pii', label: 'ipv4',         regex: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g },
  { type: 'pii', label: 'passport',     regex: /\b[A-Z]{1,2}\d{6,9}\b/g },
  { type: 'pii', label: 'api_key',      regex: /\b(sk-[A-Za-z0-9]{20,}|AIza[A-Za-z0-9\-_]{35}|AKIA[A-Z0-9]{16})\b/g },
]
