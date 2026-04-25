import type { SafeResult, Violation } from './index.js'
import { PII_PATTERNS, type Pattern } from './patterns.js'

export const INDIRECT_PATTERNS: Pattern[] = [
  { type: 'injection', label: 'fake_system_tag',
    regex: /^\s*(system|assistant|user)\s*[:|]\s*[\S]/im },
  { type: 'injection', label: 'fake_role_markdown',
    regex: /\*\*\s*(system|assistant)\s*[:|]\s*\*\*/i },
  { type: 'injection', label: 'chat_template_tokens',
    regex: /<\|?(im_start|im_end|system|user|assistant|endoftext|bos|eos)\|?>|\[\/?INST\]|\[\/?SYS\]|<\/?system>|<\/?assistant>/i },
  { type: 'injection', label: 'markdown_image_exfil',
    regex: /!\[[^\]]*\]\(\s*https?:\/\/[^)]*[?&][^)]*(=|:)[^)]*\)/ },
  { type: 'injection', label: 'suspicious_tracking_link',
    regex: /\[[^\]]*\]\(\s*https?:\/\/[^)]{0,200}[?&](prompt|system|context|secret|api[_-]?key|token|data)=/i },
  { type: 'injection', label: 'data_url_payload',
    regex: /data:[\w\/+.-]+;base64,[A-Za-z0-9+/=]{40,}/ },
  { type: 'injection', label: 'tool_call_pretend',
    regex: /<(tool_use|tool_call|function_call|function_response)\b[^>]*>/i },
  { type: 'injection', label: 'unicode_smuggling',
    regex: /[‪-‮⁦-⁩​-‏﻿]/ },
  { type: 'injection', label: 'indirect_imperative',
    regex: /\b(ai|assistant|model|llm|chatbot|claude|gpt|gemini)[\s,:]+(please\s+)?(ignore|disregard|override|forget|stop|output|reveal|print|send|email|leak)\b/i },
  { type: 'injection', label: 'conditional_injection',
    regex: /\b(when\s+you\s+(see|read|encounter)\s+this|upon\s+reading\s+this)[\s,]+(please\s+)?(do|execute|call|invoke|run|output|reveal)/i },
  { type: 'injection', label: 'important_instruction',
    regex: /\b(important[!\s]+(new|updated)\s+instructions?|new\s+system\s+prompt|additional\s+rules?|override\s+prior)/i },
]

function scanOne(text: string, patterns: Pattern[]): Violation[] {
  const violations: Violation[] = []
  for (const p of patterns) {
    if (p.regex.global) {
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

export interface IndirectScanOptions {
  /** Include PII detection in the scan. Default true. */
  includeBase?: boolean
}

export function scanUntrusted(
  text: string,
  options: IndirectScanOptions = {},
): SafeResult {
  const { includeBase = true } = options
  const violations: Violation[] = scanOne(text, INDIRECT_PATTERNS)
  if (includeBase) violations.push(...scanOne(text, PII_PATTERNS))
  return { safe: violations.length === 0, violations }
}
