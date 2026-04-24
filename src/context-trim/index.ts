import { countMessageTokens, countTokens } from './tokens.js'
import { groupTurns, type Turn } from './turns.js'
import { scoreMessage } from './score.js'
import type { Message, TrimOptions, TrimResult, TrimStrategy } from './types.js'

export type { ContentBlock, Message, ToolCall, TrimOptions, TrimResult, TrimStrategy } from './types.js'

/**
 * Trim a conversation to fit a token budget without breaking it.
 *
 * Preserves system messages, the last N turns, pinned messages, and keeps
 * tool_call / tool_result pairs atomic. Three strategies: 'sliding' (drop
 * oldest turns), 'importance' (drop lowest-score turns), 'summary' (compress
 * dropped block into a single message via your callback).
 *
 * @example
 * const trimmed = await contextTrim(messages, {
 *   model: 'gpt-5',
 *   maxTokens: 100_000,
 *   keepLastTurns: 4,
 * })
 */
export async function contextTrim(
  messages: Message[],
  options: TrimOptions,
): Promise<TrimResult> {
  const {
    maxTokens,
    model,
    strategy = 'sliding',
    keepLastTurns = 4,
    keepSystem = true,
    summarize,
    summaryRole = 'system',
  } = options

  if (!Number.isFinite(maxTokens) || maxTokens < 0) {
    throw new RangeError(`contextTrim: maxTokens must be a finite non-negative number, got ${maxTokens}`)
  }
  if (strategy === 'summary' && typeof summarize !== 'function') {
    throw new TypeError(`contextTrim: strategy 'summary' requires a summarize callback`)
  }

  if (messages.length === 0) {
    return {
      messages: [], removed: 0, tokensBefore: 0, tokensAfter: 0,
      trimmed: false, strategy, overflow: 0,
    }
  }

  const tokensBefore = countTokens(messages, model)
  const grouped = groupTurns(messages)

  // Orphan tool messages are broken state regardless of budget — remove them
  // before checking if we're under budget. An "under budget with orphans"
  // conversation is still corrupt and will confuse the model.
  const orphanIndices = new Set<number>()
  for (const turn of grouped.turns) {
    if (turn.kind === 'orphan') {
      for (const idx of turn.indices) orphanIndices.add(idx)
    }
  }

  const tokensAfterOrphanRemoval = countTokensOfIndices(messages, orphanIndices, tokensBefore, model)
  if (tokensAfterOrphanRemoval <= maxTokens) {
    if (orphanIndices.size === 0) {
      // Fast path: nothing to do.
      return {
        messages: messages.slice(),
        removed: 0,
        tokensBefore,
        tokensAfter: tokensBefore,
        trimmed: false,
        strategy,
        overflow: 0,
      }
    }
    return finalize(messages, orphanIndices, tokensBefore, maxTokens, strategy, model)
  }

  // Determine "protected" indices — the union of:
  //   - system messages (if keepSystem)
  //   - pinned messages (anywhere)
  //   - messages belonging to the last keepLastTurns real turns
  const protectedIdx = new Set<number>()

  if (keepSystem) {
    for (const i of grouped.systemIndices) protectedIdx.add(i)
  }
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]!.pinned === true) protectedIdx.add(i)
  }
  // Last N turns — counted from the end, skipping orphans (which should always go first).
  const keptTail: Turn[] = []
  for (let t = grouped.turns.length - 1; t >= 0 && keptTail.length < keepLastTurns; t--) {
    const turn = grouped.turns[t]!
    if (turn.kind === 'orphan') continue
    keptTail.unshift(turn)
  }
  for (const turn of keptTail) {
    for (const idx of turn.indices) protectedIdx.add(idx)
  }
  // Pinned turns are always protected (one pinned message pins the whole turn).
  for (const turn of grouped.turns) {
    if (turn.pinned) for (const idx of turn.indices) protectedIdx.add(idx)
  }

  // Removable turns: everything not protected and not orphan (orphans were
  // already handled above in the pre-check).
  const removableTurns: Turn[] = []
  for (const turn of grouped.turns) {
    if (turn.kind === 'orphan') continue
    if (turn.indices.every(i => protectedIdx.has(i))) continue
    removableTurns.push(turn)
  }

  // Start the removed set with all orphans (they're always dropped).
  const removed = new Set<number>(orphanIndices)

  let current = countTokensOfIndices(messages, removed, tokensBefore, model)
  if (current <= maxTokens) {
    return finalize(messages, removed, tokensBefore, maxTokens, strategy, model)
  }

  // Order removable turns by strategy.
  const order = removalOrder(removableTurns, strategy, options.score)

  if (strategy === 'summary') {
    // Summary strategy: collect the set we'd remove via sliding, then ask
    // the user to summarize it into a single message.
    const toRemove: Turn[] = []
    for (const turn of order) {
      toRemove.push(turn)
      for (const idx of turn.indices) removed.add(idx)
      current = countTokensOfIndices(messages, removed, tokensBefore, model)
      if (current <= maxTokens) break
    }
    const toSummarize = toRemove.flatMap(t => t.messages)
    if (toSummarize.length === 0) {
      return finalize(messages, removed, tokensBefore, maxTokens, strategy, model)
    }
    let summary: string
    try {
      summary = await summarize!(toSummarize)
    } catch (e) {
      // Summarize failed — fall back to plain removal so we still fit the budget.
      return finalize(messages, removed, tokensBefore, maxTokens, strategy, model)
    }
    if (typeof summary !== 'string' || !summary.trim()) {
      return finalize(messages, removed, tokensBefore, maxTokens, strategy, model)
    }
    const summaryMessage: Message = {
      role: summaryRole,
      content: `[summary of earlier conversation]\n${summary}`,
    }
    return finalizeWithInjection(messages, removed, summaryMessage, tokensBefore, maxTokens, strategy, model)
  }

  // Sliding / importance.
  for (const turn of order) {
    for (const idx of turn.indices) removed.add(idx)
    current = countTokensOfIndices(messages, removed, tokensBefore, model)
    if (current <= maxTokens) break
  }

  return finalize(messages, removed, tokensBefore, maxTokens, strategy, model)
}

// --- Strategy-specific ordering ---

function removalOrder(
  turns: Turn[],
  strategy: TrimStrategy,
  customScore?: (m: Message) => number,
): Turn[] {
  if (strategy === 'importance') {
    const scored = turns.map(t => {
      const score = (customScore ?? scoreMessage)
      const sum = t.messages.reduce((a, m) => a + score(m), 0)
      return { t, s: sum / Math.max(1, t.messages.length) }
    })
    // Lowest score = first to go.
    scored.sort((a, b) => a.s - b.s)
    return scored.map(x => x.t)
  }
  // sliding / summary: oldest first (already in order).
  return turns.slice()
}

// --- Finalization helpers ---

function finalize(
  original: Message[],
  removed: Set<number>,
  tokensBefore: number,
  maxTokens: number,
  strategy: TrimStrategy,
  model?: string,
): TrimResult {
  const out: Message[] = []
  for (let i = 0; i < original.length; i++) {
    if (!removed.has(i)) out.push(original[i]!)
  }
  const tokensAfter = countTokensOfIndices(original, removed, tokensBefore, model)
  const overflow = Math.max(0, tokensAfter - maxTokens)
  return {
    messages: out,
    removed: removed.size,
    tokensBefore,
    tokensAfter,
    trimmed: removed.size > 0,
    strategy,
    overflow,
  }
}

function finalizeWithInjection(
  original: Message[],
  removed: Set<number>,
  injected: Message,
  tokensBefore: number,
  maxTokens: number,
  strategy: TrimStrategy,
  model: string | undefined,
): TrimResult {
  // Build the surviving list, then splice the summary in right after any
  // leading run of system messages. This guarantees the summary appears
  // before the first user/assistant/tool message, no matter which turns
  // were removed.
  const survivors: Message[] = []
  for (let i = 0; i < original.length; i++) {
    if (!removed.has(i)) survivors.push(original[i]!)
  }
  let insertAt = 0
  while (insertAt < survivors.length && survivors[insertAt]!.role === 'system') insertAt++
  const out = [...survivors.slice(0, insertAt), injected, ...survivors.slice(insertAt)]

  // Recount against the trimmed+injected output (fresh count, not via indices).
  const tokensAfter = countTokens(out, model)
  const overflow = Math.max(0, tokensAfter - maxTokens)
  return {
    messages: out,
    removed: removed.size,
    tokensBefore,
    tokensAfter,
    trimmed: removed.size > 0,
    strategy,
    overflow,
  }
}

/**
 * Compute total tokens of the subset (all messages NOT in removed).
 * We do this by subtracting removed messages from tokensBefore so we don't
 * re-walk the whole array every iteration.
 */
function countTokensOfIndices(
  messages: Message[],
  removed: Set<number>,
  tokensBefore: number,
  model: string | undefined,
): number {
  let subtract = 0
  for (const idx of removed) subtract += countMessageTokens(messages[idx]!, model)
  return Math.max(0, tokensBefore - subtract)
}

// --- Sync helpers attached to contextTrim ---

/** Total tokens for the full conversation (including per-reply primer). */
contextTrim.count = function (messages: Message[], model?: string): number {
  return countTokens(messages, model)
}

/** Tokens for a single message (content + overhead + any tool calls). */
contextTrim.countMessage = function (msg: Message, model?: string): number {
  return countMessageTokens(msg, model)
}

/** Importance score for a single message — 0..10. */
contextTrim.score = function (msg: Message): number {
  return scoreMessage(msg)
}

/**
 * Would `contextTrim(messages, opts)` actually trim anything? Returns a
 * summary without mutating. Useful for "your conversation is getting long"
 * UI indicators.
 */
contextTrim.dryRun = function (messages: Message[], opts: TrimOptions): {
  wouldTrim: boolean
  tokensBefore: number
  overBudgetBy: number
} {
  const tokensBefore = countTokens(messages, opts.model)
  const overBudgetBy = Math.max(0, tokensBefore - opts.maxTokens)
  return { wouldTrim: overBudgetBy > 0, tokensBefore, overBudgetBy }
}
