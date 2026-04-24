/**
 * Lenient JSON parser.
 *
 * Strict JSON.parse first. If that fails, try a set of targeted cleanups
 * that cover the common ways LLMs produce almost-valid JSON:
 *   - Trailing commas before } or ]
 *   - JS-style // line comments and /* block comments *\/
 *   - Unquoted keys (`foo: 1` → `"foo": 1`)
 *   - Smart quotes (curly) in place of straight
 *   - Single-quoted strings
 *
 * Then if the string looks truncated at the end, close any open brackets
 * in nesting order and retry.
 *
 * Never uses eval. Never executes untrusted content.
 */

export interface ParseResult {
  ok: boolean
  value?: unknown
  /** Which strategy succeeded, for debugging. */
  strategy?: 'strict' | 'clean' | 'truncation-repair'
  error?: string
}

export function parse(raw: string): ParseResult {
  const trimmed = raw.trim()
  if (!trimmed) return { ok: false, error: 'empty input' }

  // Strategy 1: strict.
  try {
    return { ok: true, value: JSON.parse(trimmed), strategy: 'strict' }
  } catch { /* fall through */ }

  // Strategy 2: targeted cleanups.
  const cleaned = cleanup(trimmed)
  try {
    return { ok: true, value: JSON.parse(cleaned), strategy: 'clean' }
  } catch { /* fall through */ }

  // Strategy 3: truncation repair — close any unclosed brackets.
  const closed = repairTruncation(cleaned)
  if (closed !== cleaned) {
    try {
      return { ok: true, value: JSON.parse(closed), strategy: 'truncation-repair' }
    } catch { /* fall through */ }
  }

  return { ok: false, error: 'could not parse as JSON even with repair' }
}

function cleanup(input: string): string {
  // We tokenize top-down respecting string boundaries so we don't mutate
  // characters that appear inside a quoted value.
  let out = ''
  let i = 0
  const n = input.length

  while (i < n) {
    const ch = input[i]!

    // String literal — copy verbatim with escape awareness, upgrading single
    // quotes to double quotes. Smart quotes get normalized to straight.
    if (ch === '"' || ch === "'" || ch === '“' || ch === '‘') {
      const closers: Record<string, string> = {
        '"':    '"',
        "'":    "'",
        '“': '”', // "
        '‘': '’', // '
      }
      const closer = closers[ch]!
      const wasSingle = ch === "'" || ch === '‘'
      out += '"'
      i++
      while (i < n) {
        const c = input[i]!
        if (c === '\\') {
          out += c + (input[i + 1] ?? '')
          i += 2
          continue
        }
        if (c === closer || (wasSingle && (c === "'" || c === '’'))) {
          out += '"'
          i++
          break
        }
        // If we originally opened with double but encounter a real double inside
        // an accidentally-single-quoted context, escape it.
        if (c === '"' && wasSingle) {
          out += '\\"'
          i++
          continue
        }
        out += c
        i++
      }
      continue
    }

    // Line comment
    if (ch === '/' && input[i + 1] === '/') {
      while (i < n && input[i] !== '\n') i++
      continue
    }
    // Block comment
    if (ch === '/' && input[i + 1] === '*') {
      i += 2
      while (i < n && !(input[i] === '*' && input[i + 1] === '/')) i++
      i += 2
      continue
    }

    // Trailing comma before } or ]
    if (ch === ',') {
      let k = i + 1
      while (k < n && /\s/.test(input[k]!)) k++
      if (input[k] === '}' || input[k] === ']') {
        i++
        continue
      }
    }

    // JS literals that aren't valid JSON: NaN, Infinity, -Infinity, undefined.
    // Only valid in value position (after : or , or [). Replace with null so
    // downstream validation rather than parsing surfaces the error.
    if (ch === 'N' || ch === 'I' || ch === 'u' || ch === '-') {
      const prevNonWs = findPrevNonWs(out)
      const inValuePos = prevNonWs === ':' || prevNonWs === ',' || prevNonWs === '['
      if (inValuePos) {
        const rest = input.slice(i)
        const m = rest.match(/^(NaN|Infinity|-Infinity|undefined)\b/)
        if (m) {
          out += 'null'
          i += m[0].length
          continue
        }
      }
    }

    // Unquoted object key: `  foo :` → `  "foo" :`
    // Fires only right after { or , and followed by a colon. Also handles
    // hyphenated keys like `content-type:` which models emit fairly often.
    if (/[A-Za-z_$]/.test(ch)) {
      const prevNonWs = findPrevNonWs(out)
      if (prevNonWs === '{' || prevNonWs === ',') {
        let k = i
        while (k < n && /[A-Za-z0-9_$\-]/.test(input[k]!)) k++
        let p = k
        while (p < n && /\s/.test(input[p]!)) p++
        if (input[p] === ':') {
          out += '"' + input.slice(i, k) + '"'
          i = k
          continue
        }
      }
    }

    out += ch
    i++
  }

  return out
}

function findPrevNonWs(s: string): string | undefined {
  for (let i = s.length - 1; i >= 0; i--) {
    if (!/\s/.test(s[i]!)) return s[i]
  }
  return undefined
}

function repairTruncation(input: string): string {
  // Walk the string tracking stack depth, ignoring string interiors.
  const stack: string[] = []
  let inString: '"' | null = null
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!
    if (inString) {
      if (c === '\\') { i++; continue }
      if (c === inString) inString = null
      continue
    }
    if (c === '"') { inString = c; continue }
    if (c === '{') stack.push('}')
    else if (c === '[') stack.push(']')
    else if (c === '}' || c === ']') {
      if (stack[stack.length - 1] === c) stack.pop()
      else stack.length = 0 // mismatched — don't try to repair
    }
  }

  let closed = input

  // If we ended inside a string, close it. This is a common truncation case:
  // the model got cut off mid-value.
  if (inString) {
    closed += '"'
  }

  // If the tail ends with `, ` or bare ` ` expecting a next key, trim it so we
  // don't leave a dangling `,` before the closers we're about to append.
  closed = closed.replace(/,\s*$/, '')
  // Also strip dangling `:` (truncated right after a key).
  closed = closed.replace(/"[^"]*"\s*:\s*$/, '')
  // Drop stray trailing comma from partial-array cases.
  closed = closed.replace(/,\s*$/, '')

  // Close stack in reverse.
  while (stack.length > 0) closed += stack.pop()

  return closed
}
