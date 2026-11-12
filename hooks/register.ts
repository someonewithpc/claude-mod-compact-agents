import type { EngineInterface, Hook, Register, TurnStepChunk, TurnStepResult } from 'claude-code'

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

/**
 * Tells the main loop how a handoff went, as an agent's message reaches it,
 * so an idle main loop wakes to read it; a row in its transcript otherwise.
 */
async function notify($: EngineInterface, text: string): Promise<void> {
  const message = `[compact-agents] ${text}`
  const sent = await $.session.send({ to: 'main', text: message }).catch(() => null)
  if (sent?.isDelivered === true) return
  await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: message }] } }).catch(() => {})
}

async function save($: EngineInterface): Promise<void> {
  await $.state.set({ plugin: 'compact-agents', key: 'handoffs' } as const, handoffs)
}

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
    const log = (line: string) => $.ui.log(line, { to: 'transcript' })
    const drop = async () => {
      delete handoffs.pending[agentId]
      await save($)
    }
    /** The agent goes on as it was, so the main loop may ask again. */
    const giveUp = async (why: string) => {
      await drop()
      log(`could not hand off subagent ${agentId}: ${why}; it goes on as it was`)
      await notify(
        $,
        `Agent ${agentId} was not compacted: ${why}. It is still running as it was. ` +
          'Call compact_agent on it again to retry.',
      )
    }
    /** Starts the agent that continues from `note`. */
    const handOff = async (note: string): Promise<{ newId: string } | { why: string }> => {
      const agent = findAgent(await $.agent.list(), agentId)
      const messages = await $.session.messages({ agentId })
      const alias = aliasOf(e.model)
      const spawned = await $.agent
        .spawn({
          prompt: replacementPrompt(Array.isArray(messages) ? briefOf(messages) : '', note, agentId),
          description: agent?.description ?? 'continued task',
          ...(alias === undefined ? {} : { model: alias }),
          ...(agent !== null && agent.type !== '' && agent.type !== 'teammate' ? { subagentType: agent.type } : {}),
        })
        .catch((error: unknown) => ({ deny: String(error) }))
      const newId = 'agentId' in spawned ? spawned.agentId : undefined
      if (newId === undefined) {
        const why = 'deny' in spawned && spawned.deny !== undefined ? String(spawned.deny) : 'no id came back'
        return { why: `the agent to continue it could not be started: ${why}` }
      }
      await drop()
      log(`subagent ${agentId} handed off to ${newId}`)
      return { newId }
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
      await drop()
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
        const cached =
          usage === null ? '' : ` (${usage.cache_read_input_tokens} tokens of it read from the prompt cache)`
        log(`subagent ${agentId} wrote its note${cached}`)
        const outcome = await handOff(note)
        if ('newId' in outcome) {
          await notify(
            $,
            `Agent ${agentId} was compacted: agent ${outcome.newId} continues its task from a handoff note${cached}. ` +
              `Send follow-ups to ${outcome.newId}; its result reaches you when it finishes.`,
          )
          const done = ended(outcome.newId)
          yield { kind: 'text', index: 0, text: done.answer }
          yield { kind: 'stop', stopReason: 'end_turn', usage: response.usage }
          return { ...done, usage: response.usage }
        }
        // The note ended the agent's turn, so the agent stops with it as its report.
        await drop()
        log(`could not hand off subagent ${agentId}: ${outcome.why}`)
        await notify(
          $,
          `Agent ${agentId} wrote its handoff note, but ${outcome.why}. Agent ${agentId} has stopped and its ` +
            'final report is the note. To go on, start an agent with the Agent tool and give it that report.',
        )
      } else if (response.toolUses.length > 0) {
        request.isAsked = false
        await save($)
        log(
          `subagent ${agentId} called a tool instead of writing its note; ` +
            (request.asks < MAX_ASKS ? 'asking again' : `writing it cold on ${COLD_MODEL}`),
        )
      } else {
        await drop()
        log(`subagent ${agentId} ended without writing a note`)
        await notify($, `Agent ${agentId} ended without writing its handoff note (${response.stopReason}).`)
      }
      for (const chunk of held) yield chunk
      return response
    }

    if (request.asks < MAX_ASKS) return yield* next(e)

    // The agent would not write its note: summarize the transcript cold, on the cheap model.
    const messages = await $.session.messages({ agentId })
    if (!Array.isArray(messages) || messages.length === 0) {
      await giveUp('its transcript could not be read')
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
      await giveUp(summary.isAnswered ? 'the summary came back empty' : `the summary failed (${summary.reason})`)
      return yield* next(e)
    }
    const outcome = await handOff(summary.text.trim())
    if ('why' in outcome) {
      await giveUp(outcome.why)
      return yield* next(e)
    }
    await notify(
      $,
      `Agent ${agentId} was compacted: it would not write a handoff note, so its transcript was summarized on ` +
        `${COLD_MODEL}, and agent ${outcome.newId} continues from that. Send follow-ups to ${outcome.newId}.`,
    )
    const done = ended(outcome.newId)
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
        'You will get a message naming the agent that takes over, or saying why it failed.',
    }
  })

  on('turn.complete', { agentId: /./ }, async ($, e, next) => {
    const result = await next(e)
    const agentId = e.agentId
    if (agentId === undefined || handoffs.pending[agentId] === undefined || handling.has(agentId)) return result
    delete handoffs.pending[agentId]
    await $.state.set({ plugin: 'compact-agents', key: 'handoffs' } as const, handoffs)
    await notify($, `Agent ${agentId} finished before it could be compacted, so there was nothing to hand off.`)
    return result
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
