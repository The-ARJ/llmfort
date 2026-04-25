export interface ParseResult {
  ok: boolean
  value?: unknown
  strategy?: 'strict' | 'clean' | 'truncation-repair'
  error?: string
}

export function parse(raw: string): ParseResult {
  const trimmed = raw.trim()
  if (!trimmed) return { ok: false, error: 'empty input' }

  // Strategy 1: strict.
  try {
    return { ok: true, value: JSON.parse(trimmed), strategy: 'strict' }
  } catch { /* try lenient */ }

  const cleaned = cleanup(trimmed)
  try {
    return { ok: true, value: JSON.parse(cleaned), strategy: 'clean' }
  } catch { /* try truncation repair */ }

  const closed = repairTruncation(cleaned)
  if (closed !== cleaned) {
    try {
      return { ok: true, value: JSON.parse(closed), strategy: 'truncation-repair' }
    } catch { /* give up */ }
  }

  return { ok: false, error: 'could not parse as JSON even with repair' }
}

function cleanup(input: string): string {
  let out = ''
  let i = 0
  const n = input.length

  while (i < n) {
    const ch = input[i]!

    // String literal — copy verbatim, upgrade single/smart quotes to double.
    if (ch === '"' || ch === "'" || ch === '“' || ch === '‘') {
      const closers: Record<string, string> = {
        '"':    '"',
        "'":    "'",
        '“': '”',
        '‘': '’',
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

    if (ch === '/' && input[i + 1] === '/') {
      while (i < n && input[i] !== '\n') i++
      continue
    }
    if (ch === '/' && input[i + 1] === '*') {
      i += 2
      while (i < n && !(input[i] === '*' && input[i + 1] === '/')) i++
      i += 2
      continue
    }

    if (ch === ',') {
      let k = i + 1
      while (k < n && /\s/.test(input[k]!)) k++
      if (input[k] === '}' || input[k] === ']') {
        i++
        continue
      }
    }

    // JS-only literals (NaN, Infinity, -Infinity, undefined) → null in value position.
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

    // Unquoted object keys: `foo :` → `"foo" :`. Hyphens allowed (e.g. content-type).
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
      else stack.length = 0 // mismatched closer — abort repair
    }
  }

  let closed = input
  if (inString) closed += '"'
  closed = closed.replace(/,\s*$/, '')
  closed = closed.replace(/"[^"]*"\s*:\s*$/, '')
  closed = closed.replace(/,\s*$/, '')
  while (stack.length > 0) closed += stack.pop()

  return closed
}
