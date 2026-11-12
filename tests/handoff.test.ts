import type { SessionMessage } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import { aliasOf, transcriptText } from '../hooks/handoff'

describe('aliasOf', () => {
  test('maps a model id to the family the Agent tool takes', () => {
    expect(aliasOf('claude-sonnet-5-5')).toBe('sonnet')
    expect(aliasOf('claude-haiku-4-5-20251001')).toBe('haiku')
    expect(aliasOf('opus')).toBe('opus')
    expect(aliasOf('gpt-x')).toBe(undefined)
  })
})

describe('transcriptText', () => {
  test('keeps the brief and the newest messages when the transcript is too long', () => {
    const big = 'y'.repeat(100_000)
    const messages: SessionMessage[] = [
      { role: 'user', text: 'THE BRIEF', toolUses: [] },
      ...Array.from({ length: 10 }, (_, i): SessionMessage => ({ role: 'assistant', text: `step ${i} ${big}`, toolUses: [] })),
    ]
    const text = transcriptText(messages)
    expect(text.startsWith('[brief]\nTHE BRIEF')).toBe(true)
    expect(text).toContain('step 9')
    expect(text).not.toContain('step 0 ')
    expect(text).toContain('earlier messages left out')
  })
})
