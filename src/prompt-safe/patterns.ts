export interface Pattern {
  type: 'injection' | 'jailbreak' | 'pii'
  label: string
  regex: RegExp
  /**
   * Optional post-match validator. If returns false the match is discarded
   * (used to cut PII false-positives like generic 10-digit order numbers).
   */
  validate?: (match: string, fullText: string, index: number) => boolean
}

export const INJECTION_PATTERNS: Pattern[] = [
  { type: 'injection', label: 'ignore_instructions',    regex: /ignore\s+(all\s+)?(previous|prior|above|the\s+above)\s+(instructions?|prompts?|rules|context)/i },
  { type: 'injection', label: 'disregard_instructions', regex: /disregard\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|rules)/i },
  { type: 'injection', label: 'system_override',        regex: /\bsystem\s*:\s*you\s+are\b/i },
  { type: 'injection', label: 'new_instructions',       regex: /\bnew\s+instructions?\s*:/i },
  { type: 'injection', label: 'override_directive',     regex: /\boverride\s+(previous\s+)?(instructions?|rules|guidelines)\b/i },
  { type: 'injection', label: 'forget_instructions',    regex: /forget\s+(everything|all|previous)\s+(you('ve|\s+have)\s+been\s+told|instructions?|rules)/i },
  { type: 'injection', label: 'prompt_leak',            regex: /\brepeat\s+(your\s+)?(system\s+)?(prompt|instructions?)\b/i },
  { type: 'injection', label: 'role_switch',            regex: /\b(act|behave|pretend|roleplay)\s+as\s+(if\s+you\s+are|a\s+|an\s+)/i },
  { type: 'injection', label: 'translate_leak',         regex: /translate\s+(the\s+)?(above|previous|following|everything)\s+(text|content|instructions?|conversation|prompt)/i },
  { type: 'injection', label: 'summarize_instructions', regex: /summarize\s+(your\s+)?(system\s+)?(prompt|instructions?|context|rules)/i },
  // Chat-template token injection (<|im_start|>, <|system|>, <|endoftext|>, [INST], etc.)
  { type: 'injection', label: 'xml_token_injection',    regex: /<\|?(im_start|im_end|system|user|assistant|endoftext|bos|eos)\|?>|\[\/?INST\]|\[\/?SYS\]/i },
  // Unicode direction override / zero-width smuggling
  { type: 'injection', label: 'unicode_smuggling',      regex: /[‪-‮⁦-⁩​-‏﻿]/ },
  { type: 'injection', label: 'context_extraction',     regex: /what\s+(did\s+i\s+(say|tell\s+you)|are\s+your\s+(instructions?|rules|guidelines|system\s+prompt))/i },
  // Data-exfiltration via rendered image / markdown link
  { type: 'injection', label: 'exfil_markdown',         regex: /!\[[^\]]*\]\(\s*https?:\/\/[^)]*(\?|&)[^)]*\$\{?(prompt|context|system|secret|api_?key)/i },
  // Indirect injection markers that show up in scraped-web content
  { type: 'injection', label: 'indirect_injection',     regex: /\b(ai|assistant|model|llm|chatbot)[\s,:]+(please\s+)?(ignore|disregard|override|forget|stop)\b/i },
  // --- Multilingual variants ---
  // Chinese: 忽略/无视 previous instructions
  { type: 'injection', label: 'ignore_instructions_zh', regex: /(忽略|无视|忽視|忘记|忘記)(之前|以前|以上|上面|前面|所有)?(的)?(所有)?(指令|指示|规则|規則|提示|系统提示|系統提示)/ },
  // Spanish: ignora/olvida las instrucciones anteriores
  { type: 'injection', label: 'ignore_instructions_es', regex: /(ignora|olvida|omite|descarta)\s+(todas?\s+)?(las?\s+)?(instrucciones|reglas|indicaciones)\s+(anteriores|previas)/i },
  // French: ignore/oublie les instructions précédentes
  { type: 'injection', label: 'ignore_instructions_fr', regex: /(ignore[zr]?|oublie[zr]?|écarte[zr]?)\s+(toutes?\s+)?(les\s+)?(instructions|règles|consignes)\s+(précédentes|antérieures)/i },
  // German: ignoriere/vergiss die vorherigen Anweisungen
  { type: 'injection', label: 'ignore_instructions_de', regex: /(ignorier[e]?|vergiss|verwerf[e]?)\s+(alle\s+)?(vorherigen|bisherigen|vorigen)\s+(anweisungen|regeln|instruktionen)/i },
  // Russian: игнорируй/забудь предыдущие инструкции
  { type: 'injection', label: 'ignore_instructions_ru', regex: /(игнорируй|забудь|отбрось)\s+(все\s+)?(предыдущие|прошлые)\s+(инструкции|правила|указания)/i },
  // Japanese: これまでの指示を無視
  { type: 'injection', label: 'ignore_instructions_ja', regex: /(これまでの|以前の|前の|過去の|全ての)(指示|指令|ルール|命令)を?(無視|忘れ)/ },
  // Korean: 이전 지시 무시
  { type: 'injection', label: 'ignore_instructions_ko', regex: /(이전의?|앞의?|위의?|모든)\s*(지시|명령|규칙|프롬프트)(을|를)?\s*(무시|잊)/ },
  // Arabic: تجاهل التعليمات السابقة
  { type: 'injection', label: 'ignore_instructions_ar', regex: /(تجاهل|انسى|اهمل)\s+(جميع\s+)?(التعليمات|الأوامر|القواعد)\s+(السابقة|السابقه)/ },
]

export const JAILBREAK_PATTERNS: Pattern[] = [
  { type: 'jailbreak', label: 'dan',                  regex: /\bDAN\b.*\bjailbreak\b|\bjailbreak\b.*\bDAN\b|\bDAN\s+(mode|prompt)\b/i },
  { type: 'jailbreak', label: 'do_anything_now',      regex: /do\s+anything\s+now/i },
  { type: 'jailbreak', label: 'hypothetically',       regex: /hypothetically[\s,]+if\s+(you\s+)?were\s+(not|an?\s+AI|allowed)/i },
  { type: 'jailbreak', label: 'base64_payload',       regex: /base64[_\s]?decode|atob\s*\(|decode\s+the\s+following\s+base64/i },
  { type: 'jailbreak', label: 'developer_mode',       regex: /\bdeveloper\s+mode\b.*\benable\b|\benable\b.*\bdeveloper\s+mode\b|\bgodmode\b/i },
  { type: 'jailbreak', label: 'stay_in_character',    regex: /stay\s+in\s+character|never\s+break\s+character|remain\s+in\s+character/i },
  { type: 'jailbreak', label: 'no_restrictions',      regex: /without\s+(any\s+)?(restrictions?|filters?|guidelines)|bypass\s+(your\s+)?(filter|guidelines|safety)/i },
  { type: 'jailbreak', label: 'opposite_mode',        regex: /\b(opposite|evil|chaos|shadow|dark|inverse)\s+(mode|GPT|AI|model|version|persona)\b/i },
  { type: 'jailbreak', label: 'persona_exploit',      regex: /pretend\s+(you\s+)?(have\s+no\s+(guidelines|restrictions?|rules)|you('re| are)\s+(my\s+)?(grandma|deceased|dead|jailbroken|unrestricted))/i },
  { type: 'jailbreak', label: 'simulation_framing',   regex: /\bsimulat(e|ing|ion)\s+(a\s+)?(world|reality|scenario|AI|model)\s+(where|without|that\s+(has\s+no|ignores?))/i },
  // Repeat-the-word N times — allow "word/phrase/token/letter" and larger thresholds
  { type: 'jailbreak', label: 'token_overflow',       regex: /repeat\s+(the\s+)?(word|phrase|token|letter|string|character|sentence)\s+\S.*?\s+\d{3,}\s+times?/i },
  // Harmful-content framing
  { type: 'jailbreak', label: 'harmful_framing',      regex: /\b(for\s+educational\s+purposes|for\s+research|purely\s+hypothetical|as\s+a\s+thought\s+experiment)\b.{0,100}\b(bomb|weapon|malware|exploit|hack|bypass|crack)/i },
]

// Luhn check for card-number validation
function luhnValid(digits: string): boolean {
  const nums = digits.replace(/\D/g, '')
  if (nums.length < 13 || nums.length > 19) return false
  let sum = 0
  let alt = false
  for (let i = nums.length - 1; i >= 0; i--) {
    let n = parseInt(nums[i]!, 10)
    if (alt) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
    alt = !alt
  }
  return sum % 10 === 0
}

export const PII_PATTERNS: Pattern[] = [
  { type: 'pii', label: 'email',        regex: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g },
  // US phone: require formatting (parens, dashes, dots, spaces, or leading +1) so bare 10-digit
  // integers like order numbers don't false-positive.
  {
    type: 'pii',
    label: 'phone_us',
    regex: /(?:\+?1[\s\-.])?(?:\(\d{3}\)\s?|\d{3}[\s\-.])\d{3}[\s\-.]\d{4}\b/g,
    validate: (m) => {
      // Reject if the whole match is just 10-11 digits with no separators.
      const hasSep = /[\s\-.()]/.test(m)
      return hasSep
    },
  },
  // SSN: require dashes (bare 9 digits collides with too many IDs)
  { type: 'pii', label: 'ssn',          regex: /\b\d{3}-\d{2}-\d{4}\b/g },
  {
    type: 'pii',
    label: 'credit_card',
    regex: /\b(?:4\d{12}(?:\d{3})?|5[1-5]\d{14}|3[47]\d{13}|3(?:0[0-5]|[68]\d)\d{11}|6(?:011|5\d{2})\d{12})\b/g,
    validate: (m) => luhnValid(m),
  },
  { type: 'pii', label: 'ipv4',         regex: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g },
  // Passport: require the word "passport" nearby to avoid catching SKUs / invoice numbers.
  {
    type: 'pii',
    label: 'passport',
    regex: /\b[A-Z]{1,2}\d{6,9}\b/g,
    validate: (m, fullText, index) => {
      const window = fullText.slice(Math.max(0, index - 40), index + m.length + 40).toLowerCase()
      return /passport|travel\s+document|mrz/.test(window)
    },
  },
  // Provider API keys. Anthropic: sk-ant-..., OpenAI: sk-proj-... / sk-..., Google: AIza..., AWS: AKIA...
  {
    type: 'pii',
    label: 'api_key',
    regex: /\b(sk-ant-[A-Za-z0-9_\-]{20,}|sk-proj-[A-Za-z0-9_\-]{20,}|sk-[A-Za-z0-9]{20,}|AIza[A-Za-z0-9\-_]{35}|AKIA[A-Z0-9]{16}|ghp_[A-Za-z0-9]{36,}|xox[baprs]-[A-Za-z0-9\-]{10,})\b/g,
  },
  // JWT (header.payload.signature, all base64url)
  { type: 'pii', label: 'jwt',          regex: /\beyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\b/g },
]
