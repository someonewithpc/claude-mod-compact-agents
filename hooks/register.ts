import type { Hook, Register, TurnStepChunk, TurnStepResult } from 'claude-code'

import type { CompactAgentsHandoff, CompactAgentsState } from '../types'
import {
  aliasOf,
  briefOf,
  emptyHandoffs,
  findAgent,
  isLive,
  noteRequest,
  replacementPrompt,
  stoppedAnswer,
  SUMMARY_SYSTEM,
  summaryPrompt,
} from './handoff'

const TOOL = 'compact_agent'
const MAX_ASKS = 2
const COLD_MODEL = 'haiku'
const SUMMARY_MAX_TOKENS = 16_000
const SUMMARY_TIMEOUT_MS = 15 * 60_000
const PENDING_MAX_AGE_MS = 24 * 3600_000

const DESCRIPTION = [
  "Compact a running subagent's context. Once its current tool call finishes, the subagent is asked to write",
  'a handoff note, on its own model and prompt cache; it then stops, and a fresh agent of the same type and',
  "model continues the task from the note and the original brief. The stopped agent's final answer names the",
  "new agent's id, and the new agent's result reaches you when it finishes. Use it on a subagent whose context",
  'has grown large with file dumps and logs it no longer needs. `agent` is the id or name ListAgents shows;',
  '`focus` names what the note should keep or stress.',
].join(' ')

let handoffs: CompactAgentsState = emptyHandoffs()
/** Agents one copy of the step hook is handling, which the copy beneath must pass by. */
const handling = new Set<string>()

const handoffStep: Hook<'turn.step'> = async function* ($, e, next) {
  const agentId = e.agentId
  const request = agentId === undefined ? undefined : handoffs.pending[agentId]
  if (agentId === undefined || request === undefined || handling.has(agentId)) return yield* next(e)
  handling.add(agentId)
  try {
    return yield* handOffStep(agentId, request)
  } finally {
    handling.delete(agentId)
  }

  async function* handOffStep(
    agentId: string,
    request: CompactAgentsHandoff,
  ): AsyncGenerator<TurnStepChunk, TurnStepResult> {
    const save = () => $.state.set({ plugin: 'compact-agents', key: 'handoffs' } as const, handoffs)
    const log = (line: string) => $.ui.log(line, { to: 'transcript' })
    const fail = async (why: string) => {
      delete handoffs.pending[agentId]
      await save()
      log(`could not hand off subagent ${agentId}: ${why}; it goes on as it was`)
      await $.session
        .append({
          message: {
            type: 'user',
            content: [
              {
                type: 'text',
                text: `[compact-agents] Agent ${agentId} was not handed off (${why}). It goes on as it was.`,
              },
            ],
          },
        })
        .catch(() => {})
    }
    const handOff = async (note: string): Promise<string | null> => {
      const agent = findAgent(await $.agent.list(), agentId)
      const messages = await $.session.messages({ agentId })
      const alias = aliasOf(e.model)
      const spawned = await $.agent.spawn({
        prompt: replacementPrompt(Array.isArray(messages) ? briefOf(messages) : '', note, agentId),
        description: agent?.description ?? 'continued task',
        ...(alias === undefined ? {} : { model: alias }),
        ...(agent !== null && agent.type !== '' && agent.type !== 'teammate' ? { subagentType: agent.type } : {}),
      })
      const newId = 'agentId' in spawned ? spawned.agentId : undefined
      if (newId === undefined) {
        await fail(`the new agent was refused: ${'deny' in spawned ? String(spawned.deny) : 'no id came back'}`)
        return null
      }
      delete handoffs.pending[agentId]
      await save()
      log(`subagent ${agentId} handed off to ${newId}`)
      return newId
    }
    const ended = (newId: string): TurnStepResult => ({
      turnId: e.turnId,
      index: e.index,
      answer: stoppedAnswer(agentId, newId),
      toolUses: [],
      stopReason: 'end_turn',
      usage: null,
    })

    if ((await $.clock.now()) - request.at > PENDING_MAX_AGE_MS) {
      delete handoffs.pending[agentId]
      await save()
      return yield* next(e)
    }

    if (request.isAsked) {
      // This request ends with the note request, behind the agent's own cached
      // prefix. Its answer is held back: it goes to the replacement, not upward.
      const held: TurnStepChunk[] = []
      const stream = next(e)
      let step = await stream.next()
      while (step.done !== true) {
        held.push(step.value)
        step = await stream.next()
      }
      const response = step.value
      const note = response.answer.trim()
      if (response.toolUses.length === 0 && note !== '') {
        const usage = response.usage
        if (usage !== null) {
          log(
            `subagent ${agentId} wrote its note: ${usage.cache_read_input_tokens} tokens read from the cache, ` +
              `${usage.input_tokens + usage.cache_creation_input_tokens} not`,
          )
        }
        const newId = await handOff(note)
        if (newId !== null) {
          const done = ended(newId)
          yield { kind: 'text', index: 0, text: done.answer }
          yield { kind: 'stop', stopReason: 'end_turn', usage: response.usage }
          return { ...done, usage: response.usage }
        }
      } else if (response.toolUses.length > 0) {
        request.isAsked = false
        await save()
        log(
          `subagent ${agentId} called a tool instead of writing its note; ${request.asks < MAX_ASKS ? 'asking again' : `writing it cold on ${COLD_MODEL}`}`,
        )
      } else {
        await fail('it wrote no note')
      }
      for (const chunk of held) yield chunk
      return response
    }

    if (request.asks < MAX_ASKS) return yield* next(e)

    // The agent would not write its note: summarize the transcript cold, on the cheap model.
    const messages = await $.session.messages({ agentId })
    if (!Array.isArray(messages) || messages.length === 0) {
      await fail('its transcript could not be read')
      return yield* next(e)
    }
    log(`subagent ${agentId} paused: summarizing ${messages.length} messages on ${COLD_MODEL}`)
    const summary = await $.model.complete(
      {
        model: COLD_MODEL,
        system: SUMMARY_SYSTEM,
        prompt: summaryPrompt(messages, request.focus),
        maxTokens: SUMMARY_MAX_TOKENS,
        timeoutMs: SUMMARY_TIMEOUT_MS,
      },
      { signal: next.signal },
    )
    if (!summary.isAnswered || summary.text.trim() === '') {
      await fail(summary.isAnswered ? 'the summary came back empty' : `the summary failed: ${summary.reason}`)
      return yield* next(e)
    }
    const newId = await handOff(summary.text.trim())
    if (newId === null) return yield* next(e)
    const done = ended(newId)
    yield { kind: 'text', index: 0, text: done.answer }
    yield { kind: 'stop', stopReason: 'end_turn', usage: null }
    return done
  }
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    handoffs = (await $.state.get({ plugin: 'compact-agents', key: 'handoffs' } as const)).value ?? emptyHandoffs()
    try {
      await $.tool.register({
        name: TOOL,
        description: DESCRIPTION,
        inputSchema: {
          type: 'object',
          properties: {
            agent: { type: 'string', description: "The subagent's id or name" },
            focus: { type: 'string', description: 'What the handoff note should keep or stress' },
          },
          required: ['agent'],
        },
      })
    } catch (error) {
      $.ui.log(`could not register the ${TOOL} tool: ${String(error)}`, { to: 'debug' })
    }
    return next(e)
  })

  on('tool.call', { tool: 'mcp__compact-agents__compact_agent' }, async ($, e) => {
    const ref = typeof e.agent === 'string' ? e.agent.trim() : ''
    const focus = typeof e.focus === 'string' ? e.focus.trim() : ''
    if (ref === '') return { result: 'Name the subagent to compact: its id or name.', isError: true }
    const agent = findAgent(await $.agent.list(), ref)
    if (agent === null) return { result: `No agent of this session is called ${ref}.`, isError: true }
    if (!isLive(agent)) {
      return { result: `Agent ${agent.id} is ${agent.status}: there is nothing running to compact.`, isError: true }
    }
    if (agent.teammateId !== undefined) {
      return { result: `Agent ${agent.id} is a teammate; only subagents can be handed off.`, isError: true }
    }
    handoffs.pending[agent.id] = { focus, at: await $.clock.now(), asks: 0, isAsked: false }
    await $.state.set({ plugin: 'compact-agents', key: 'handoffs' } as const, handoffs)
    $.ui.log(`subagent ${agent.id} (${agent.description}) is handed off after its current tool call`, {
      to: 'transcript',
    })
    return {
      result:
        `Agent ${agent.id} is asked for a handoff note once its current tool call finishes, then stops. ` +
        'Its final answer will name the agent that takes over.',
    }
  })

  // The request rides on the agent's next tool result, so the request after
  // it opens with the agent's own cached prefix.
  on('session.append', { door: 'tool-result', agentId: /./ }, async ($, e, next) => {
    const request = e.agentId === undefined ? undefined : handoffs.pending[e.agentId]
    if (request === undefined || request.isAsked || request.asks >= MAX_ASKS) return next(e)
    request.isAsked = true
    request.asks += 1
    await $.state.set({ plugin: 'compact-agents', key: 'handoffs' } as const, handoffs)
    const content = Array.isArray(e.message.content) ? e.message.content : []
    return next({
      ...e,
      message: { ...e.message, content: [...content, { type: 'text', text: noteRequest(request.focus) }] },
    })
  })

  // A subagent started from a turn.step hook steps past that hook, so the
  // replacement one copy starts is seen, and can be handed off again, by the other.
  on('turn.step', handoffStep)
  on('turn.step', { agentId: /./ }, handoffStep)
}
