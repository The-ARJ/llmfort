import type { Message } from './types.js'

export interface Turn {
  indices: number[]
  messages: Message[]
  pinned: boolean
  /** `orphan` = tool message with no matching call; always dropped first. */
  kind: 'user' | 'assistant' | 'orphan'
}

export interface Grouped {
  systemIndices: number[]
  turns: Turn[]
}

/**
 * Group messages into (system bucket) + (atomic turns).
 *
 * A turn is a conversational unit that must be trimmed atomically: a user
 * message, optionally followed by an assistant message and any `tool`
 * responses matching that assistant's `tool_calls[].id`. Orphan tool messages
 * — no matching call visible — get their own single-message turn.
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
      // Attach to the prior user turn if that turn has no assistant yet.
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
        current.indices.push(i)
        current.messages.push(m)
        pendingToolCallIds.delete(m.tool_call_id)
      } else {
        push()
        turns.push({ indices: [i], messages: [m], pinned: m.pinned === true, kind: 'orphan' })
        current = null
        pendingToolCallIds = new Set()
      }
      continue
    }
  }
  push()

  for (const t of turns) t.pinned = t.messages.some(m => m.pinned === true)

  return { systemIndices, turns }
}
