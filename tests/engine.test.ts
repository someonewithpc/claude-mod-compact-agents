import type { AgentInfo, On, SessionMessage } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

const NOW = Date.UTC(2026, 10, 12, 12, 0)
const SESSION = { cwd: '/repo', surface: 'terminal', isInteractive: true } as const
const RUNNING: AgentInfo = {
  id: 'a1',
  description: 'audit the parser',
  type: 'Explore',
  status: 'running',
  name: 'auditor',
}
const TRANSCRIPT: SessionMessage[] = [
  { role: 'user', text: 'Audit src/parser.ts for overflow bugs.', toolUses: [] },
  {
    role: 'assistant',
    text: 'Reading it.',
    toolUses: [{ tool_use_id: 'u1', tool: 'Read', input: { file_path: 'src/parser.ts' }, text: 'x'.repeat(50) }],
  },
]
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

type World = {
  agents: AgentInfo[]
  completed: { model: string; prompt: string }[]
  spawned: { prompt: string; subagentType?: string; model?: string }[]
  steps: number
  sent: string[]
  session: ReturnType<typeof mock.session>
}

function worldOf(on: On, answers: { answer: string; tools: number }[], isSummaryOk = true): World {
  const world: World = { agents: [RUNNING], completed: [], spawned: [], steps: 0, sent: [], session: mock.session(on) }
  mock.clock(on, { now: NOW })
  mock.store(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.messages', ($, e) => ({ value: e.agentId === 'a1' ? TRANSCRIPT : [] }))
  on('agent.list', () => ({ value: world.agents }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__compact-agents__${e.name}` } }))
  on('ui.log', () => ({ value: undefined }))
  on('session.send', ($, e) => {
    world.sent.push(`${e.to}: ${e.text}`)
    return { isDelivered: true as const }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('model.complete', ($, e) => {
    world.completed.push({ model: e.model, prompt: e.prompt })
    if (!isSummaryOk) return { value: { isAnswered: false as const, reason: 'empty-reply' as const, usage: USAGE } }
    return { value: { isAnswered: true as const, text: 'COLD NOTE', usage: USAGE } }
  })
  // Core alone sets a spawned agent's id, so under the kit every spawn ends
  // up refused: what reaches it is checked here, the rest in a live session.
  on('agent.spawn', ($, e) => {
    const tool = e as unknown as { subagent_type?: string }
    world.spawned.push({ prompt: e.prompt, subagentType: e.subagentType ?? tool.subagent_type, model: e.model })
    return { model: 'claude-sonnet-5-5' }
  })
  on('turn.step', async function* ($, e) {
    const answer = answers[world.steps] ?? { answer: 'went on', tools: 0 }
    world.steps += 1
    yield { kind: 'text', index: 0, text: answer.answer }
    return {
      turnId: e.turnId,
      index: e.index,
      answer: answer.answer,
      toolUses: Array.from({ length: answer.tools }, (_, i) => ({ id: `t${i}`, name: 'Bash', input: {} })),
      stopReason: answer.tools > 0 ? 'tool_use' : 'end_turn',
      usage: null,
    }
  })
  return world
}

async function drain<T>(stream: AsyncGenerator<unknown, T>): Promise<{ chunks: unknown[]; result: T }> {
  const chunks: unknown[] = []
  let step = await stream.next()
  while (step.done !== true) {
    chunks.push(step.value)
    step = await stream.next()
  }
  return { chunks, result: step.value }
}

const toolResult = (agentId: string) =>
  ({
    door: 'tool-result',
    origin: { kind: 'tool', tool: 'Bash' },
    uuid: `r-${Math.random()}`,
    agentId,
    message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u1', content: 'ok' }] },
  }) as never

const step = (index: number) => ({
  turnId: 't9',
  index,
  model: 'claude-sonnet-5-5',
  messageCount: 4 + index,
  agentId: 'a1',
})

describe('compact_agent', () => {
  test('asks the agent for its note on its next tool result and holds the answer back', async ($, on) => {
    const world = worldOf(on, [{ answer: 'WARM NOTE', tools: 0 }])
    await $.session.start(SESSION)

    const called = await $.tool.call({
      tool: 'mcp__compact-agents__compact_agent',
      agent: 'auditor',
      focus: 'the overflow',
    })
    expect(JSON.stringify(called)).toContain('Agent a1')

    await $.session.append(toolResult('a1'))
    const row = world.session.appended().at(-1)
    const text = JSON.stringify(row?.message.content)
    expect(text).toContain('handoff note')
    expect(text).toContain('the overflow')

    const { chunks } = await drain($.turn.step(step(1)))
    expect(world.completed).toHaveLength(0)
    expect(world.spawned).toHaveLength(1)
    expect(world.spawned[0]?.prompt).toContain('WARM NOTE')
    expect(world.spawned[0]?.prompt).toContain('Audit src/parser.ts for overflow bugs.')
    expect(world.spawned[0]?.subagentType).toBe('Explore')
    expect(world.spawned[0]?.model).toBe('sonnet')
    // The kit refuses the spawn, so the note is let through as the agent's report.
    expect(JSON.stringify(chunks)).toContain('WARM NOTE')
    expect(world.sent).toHaveLength(1)
    expect(world.sent[0]).toContain('main: [compact-agents] Agent a1 wrote its handoff note, but')
    expect(world.sent[0]).toContain('start an agent with the Agent tool')
  })

  test('tells the main loop when the agent finishes before it can be compacted, and lets it ask again', async ($, on) => {
    const world = worldOf(on, [])
    await $.session.start(SESSION)
    await $.tool.call({ tool: 'mcp__compact-agents__compact_agent', agent: 'a1' })
    await $.turn.complete({
      answer: 'done',
      durationMs: 1,
      isAborted: false,
      turnId: 't9',
      reason: 'answer',
      agentId: 'a1',
    })
    expect(world.sent.at(-1)).toContain('Agent a1 finished before it could be compacted')
    const again = await $.tool.call({ tool: 'mcp__compact-agents__compact_agent', agent: 'a1' })
    expect(JSON.stringify(again)).not.toContain('already being compacted')
  })

  test('tells the main loop to retry when the cold summary fails, and the agent goes on', async ($, on) => {
    const world = worldOf(
      on,
      [
        { answer: '', tools: 1 },
        { answer: '', tools: 1 },
      ],
      false,
    )
    await $.session.start(SESSION)
    await $.tool.call({ tool: 'mcp__compact-agents__compact_agent', agent: 'a1' })
    await $.session.append(toolResult('a1'))
    await drain($.turn.step(step(1)))
    await $.session.append(toolResult('a1'))
    await drain($.turn.step(step(2)))
    const { result } = await drain($.turn.step(step(3)))
    expect(result.answer).toBe('went on')
    expect(world.spawned).toHaveLength(0)
    expect(world.sent.at(-1)).toContain('Call compact_agent on it again to retry')
    const again = await $.tool.call({ tool: 'mcp__compact-agents__compact_agent', agent: 'a1' })
    expect(JSON.stringify(again)).toContain('is asked for a handoff note')
  })

  test('asks once more, then summarizes cold on haiku, when the agent keeps calling tools', async ($, on) => {
    const world = worldOf(on, [
      { answer: '', tools: 1 },
      { answer: '', tools: 1 },
    ])
    await $.session.start(SESSION)
    await $.tool.call({ tool: 'mcp__compact-agents__compact_agent', agent: 'a1' })

    await $.session.append(toolResult('a1'))
    await drain($.turn.step(step(1)))
    await $.session.append(toolResult('a1'))
    await drain($.turn.step(step(2)))
    await $.session.append(toolResult('a1'))
    const asks = world.session.appended().filter((row) => JSON.stringify(row.message.content).includes('handoff note'))
    expect(asks).toHaveLength(2)

    await drain($.turn.step(step(3)))
    expect(world.completed).toHaveLength(1)
    expect(world.completed[0]?.model).toBe('haiku')
    expect(world.spawned[0]?.prompt).toContain('COLD NOTE')
  })

  test('leaves other agents and the main loop alone', async ($, on) => {
    const world = worldOf(on, [])
    await $.session.start(SESSION)
    await $.tool.call({ tool: 'mcp__compact-agents__compact_agent', agent: 'a1' })
    await $.session.append(toolResult('a2'))
    expect(JSON.stringify(world.session.appended().at(-1)?.message.content)).not.toContain('handoff note')
    const { result } = await drain($.turn.step({ turnId: 't1', index: 0, model: 'claude-sonnet-5-5', messageCount: 1 }))
    expect(result.answer).toBe('went on')
    expect(world.spawned).toHaveLength(0)
  })

  test('refuses an agent that already finished', async ($, on) => {
    const world = worldOf(on, [])
    world.agents = [{ ...RUNNING, status: 'completed' }]
    await $.session.start(SESSION)
    const called = await $.tool.call({ tool: 'mcp__compact-agents__compact_agent', agent: 'a1' })
    expect(JSON.stringify(called)).toContain('completed')
  })
})
