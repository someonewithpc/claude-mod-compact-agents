/**
 * A handoff asked for and not done yet. `asks` counts the requests for a
 * note the subagent was sent; past the limit the note is written cold.
 */
export type CompactAgentsHandoff = { focus: string; at: number; asks: number; isAsked: boolean }

/** By the id of the subagent to hand off. */
export type CompactAgentsState = {
  pending: Record<string, CompactAgentsHandoff>
}

declare module 'claude-code' {
  interface PluginState {
    'compact-agents': { handoffs: CompactAgentsState | null }
  }
}
