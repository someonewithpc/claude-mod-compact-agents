import type { AgentInfo, SessionMessage } from 'claude-code'

import type { CompactAgentsState } from '../types'

const TRANSCRIPT_MAX_CHARS = 600_000
const BRIEF_MAX_CHARS = 40_000
const TOOL_INPUT_MAX_CHARS = 2_000
const TOOL_RESULT_MAX_CHARS = 4_000

export const SUMMARY_SYSTEM = [
  'You write handoff notes between coding agents. An agent was stopped partway through a task because its',
  'context grew too large. A fresh agent with the same tools will continue from your note alone: it cannot',
  'see the transcript. Write the note so that agent can carry on without redoing finished work.',
].join(' ')

const SUMMARY_SECTIONS = [
  '1. The task: what was asked, every constraint and rule the brief set, and who the result goes to.',
  '2. Done so far: what was found, changed, built or measured. Give exact file paths, commands, commit hashes,',
  '   identifiers and numbers. Say what was verified and how.',
  '3. Current state: what is uncommitted, half-edited, running or waiting, and where.',
  '4. Dead ends: what was tried and failed, and why, so it is not tried again.',
  '5. Next steps: the concrete next actions, in order, starting with the one the agent was about to take.',
].join('\n')

export function emptyHandoffs(): CompactAgentsState {
  return { pending: {} }
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n[... ${text.length - max} characters cut]`
}

function rendered(message: SessionMessage): string {
  const parts = [`[${message.role}]`]
  if (message.text !== '') parts.push(message.text)
  for (const use of message.toolUses) {
    parts.push(`-> ${use.tool} ${cut(JSON.stringify(use.input), TOOL_INPUT_MAX_CHARS)}`)
    if (use.text !== undefined) parts.push(`<- ${use.isError ? '(error) ' : ''}${cut(use.text, TOOL_RESULT_MAX_CHARS)}`)
  }
  return parts.join('\n')
}

/** The agent's opening brief: its first user message, as the spawner wrote it. */
export function briefOf(messages: readonly SessionMessage[]): string {
  return messages.find((message) => message.role === 'user' && message.text !== '')?.text ?? ''
}

/**
 * The transcript as text for the summarizer: the brief whole, then as much of
 * the most recent work as fits, since that is what the next agent needs most.
 */
export function transcriptText(messages: readonly SessionMessage[]): string {
  const brief = cut(briefOf(messages), BRIEF_MAX_CHARS)
  const rest = messages.map(rendered)
  const tail: string[] = []
  let size = brief.length
  for (let i = rest.length - 1; i >= 0; i--) {
    const part = rest[i] ?? ''
    if (size + part.length > TRANSCRIPT_MAX_CHARS) {
      tail.push(`[... ${i + 1} earlier messages left out]`)
      break
    }
    tail.push(part)
    size += part.length
  }
  return [`[brief]\n${brief}`, ...tail.reverse()].join('\n\n')
}

export function summaryPrompt(messages: readonly SessionMessage[], focus: string): string {
  return [
    '<transcript>',
    transcriptText(messages),
    '</transcript>',
    '',
    'Write the handoff note for the agent that continues this task. Cover, under these headings:',
    SUMMARY_SECTIONS,
    ...(focus === '' ? [] : ['', `The agent that asked for this handoff wants the note to keep or stress: ${focus}`]),
    '',
    'Write only the note.',
  ].join('\n')
}

/** What the subagent is asked, at the end of a tool result, so its own warm cache writes the note. */
export function noteRequest(focus: string): string {
  return [
    '<compact-agents>',
    'Your context is being compacted. Stop working on the task now: call no more tools. Your next reply is',
    'a handoff note for a fresh agent that continues this task without seeing this conversation. Cover,',
    'under these headings:',
    SUMMARY_SECTIONS,
    ...(focus === '' ? [] : [`The agent that asked for this handoff wants the note to keep or stress: ${focus}`]),
    'Reply with the note alone.',
    '</compact-agents>',
  ].join('\n')
}

export function replacementPrompt(brief: string, summary: string, fromId: string): string {
  return [
    `You are continuing a task another agent (${fromId}) started. It was stopped because its context grew`,
    'too large, and this is the handoff it left. Pick up at the next step it names. Do not redo work it',
    'reports as done unless you find it was not.',
    '',
    '<original-brief>',
    brief,
    '</original-brief>',
    '',
    '<handoff>',
    summary,
    '</handoff>',
  ].join('\n')
}

export function stoppedAnswer(fromId: string, toId: string): string {
  return [
    `[compact-agents] Context handed off. This agent (${fromId}) stopped here, and agent ${toId} continues the`,
    'task from a summary of this transcript and the original brief. Its result arrives when it finishes;',
    `address follow-ups to ${toId}.`,
  ].join(' ')
}

const ALIASES = ['opus', 'sonnet', 'haiku', 'fable'] as const
export type ModelAlias = (typeof ALIASES)[number]

/** The Agent tool takes a family alias alone; a model of no known family gets the agent type's default. */
export function aliasOf(model: string): ModelAlias | undefined {
  return ALIASES.find((alias) => model === alias || model.includes(`-${alias}-`) || model.startsWith(`${alias}-`))
}

/** The agent `ref` names: an exact id first, then a name. */
export function findAgent(agents: readonly AgentInfo[], ref: string): AgentInfo | null {
  return agents.find((agent) => agent.id === ref) ?? agents.find((agent) => agent.name === ref) ?? null
}

const LIVE = new Set(['pending', 'running', 'waiting'])

export function isLive(agent: AgentInfo): boolean {
  return LIVE.has(agent.status)
}
