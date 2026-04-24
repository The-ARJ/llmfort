/**
 * Turn grouping — the foundation every strategy relies on.
 *
 * A "turn" is a conversational unit that must be trimmed atomically to avoid
 * leaving the model with dangling state:
 *   - A user turn is one `user` message.
 *   - An assistant turn is one `assistant` message + all its `tool` responses
 *     (identified by tool_call_id → tool_calls[].id matching).
 *   - Orphaned tool messages (no matching call in history) form their own
 *     single-message turn — they're garbage and will be dropped first.
 *   - System messages are NEVER part of a turn; they're handled separately.
 *
 * This grouping is how we guarantee tool_call/tool_result pairs stay together.
 */
import type { Message } from './types.js'

export interface Turn {
  /** Indices in the original messages array, in order. */
  indices: number[]
  /** The messages themselves, in order. */
  messages: Message[]
  /** True if any message in the turn is pinned. */
  pinned: boolean
  /**
   * Turn starter: user | assistant | orphan.
   * orphan = tool result with no matching call — safe to drop.
   */
  kind: 'user' | 'assistant' | 'orphan'
}

export interface Grouped {
  /** Indices of messages with role 'system', in order. */
  systemIndices: number[]
  /** Turn groups in order. */
  turns: Turn[]
}

/**
 * Group messages into (system messages) + (ordered turns).
 *
 * Algorithm: walk the array. System messages go into their own bucket. For
 * everything else, start a new turn at each `user` or `assistant` message, and
 * attach subsequent `tool` messages whose tool_call_id matches a call issued
 * by the most recent `assistant` message in the current turn. If a `tool`
 * appears without a call we can resolve, it's an orphan turn of its own.
 */
export function groupTurns(messages: Message[]): Grouped {
  const systemIndices: number[] = []
  const turns: Turn[] = []

  let current: Turn | null = null
  let pendingToolCallIds = new Set<string>()

  const push = () => {
    if (current) {
      current.pinned = current.messages.some(m => m.pinned === true)
      turns.push(current)
    }
  }

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!

    if (m.role === 'system') {
      // Close any open turn so the system message acts as a separator.
      push(); current = null; pendingToolCallIds = new Set()
      systemIndices.push(i)
      continue
    }

    if (m.role === 'user') {
      push()
      current = { indices: [i], messages: [m], pinned: false, kind: 'user' }
      pendingToolCallIds = new Set()
      continue
    }

    if (m.role === 'assistant') {
      // An assistant message belongs to the *previous* user turn if that turn
      // has no assistant yet — that's how (user, assistant) pairs form.
      if (current && current.kind === 'user' && !current.messages.some(x => x.role === 'assistant')) {
        current.indices.push(i)
        current.messages.push(m)
      } else {
        push()
        current = { indices: [i], messages: [m], pinned: false, kind: 'assistant' }
      }
      pendingToolCallIds = new Set((m.tool_calls ?? []).map(tc => tc.id))
      continue
    }

    if (m.role === 'tool') {
      if (current && m.tool_call_id && pendingToolCallIds.has(m.tool_call_id)) {
        // Attach to current turn — this tool is responding to one of its calls.
        current.indices.push(i)
        current.messages.push(m)
        pendingToolCallIds.delete(m.tool_call_id)
      } else {
        // Orphan tool message — no matching call visible. Safe to drop; give
        // it its own turn so the caller can remove it without disturbing
        // neighbours. Close any open turn first.
        push()
        turns.push({ indices: [i], messages: [m], pinned: m.pinned === true, kind: 'orphan' })
        current = null
        pendingToolCallIds = new Set()
      }
      continue
    }
  }
  push()

  // Propagate pinned=true to whole turn if any message within is pinned.
  for (const t of turns) t.pinned = t.messages.some(m => m.pinned === true)

  return { systemIndices, turns }
}
