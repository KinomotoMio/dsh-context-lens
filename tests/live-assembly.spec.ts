import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { renderPrompt, type PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { describe, expect, it, vi } from 'vitest'
import { LiveAssemblyStore } from '../src/live-assembly.ts'

type AssembleListener = (
  input: PromptAssembly,
  context: unknown,
  next: () => Promise<PromptAssembly>,
) => Promise<PromptAssembly>

type EventListener = (
  session: { id: ReturnType<typeof SessionId> },
  event: { type: string; data: { turn: number; step: number } },
) => void

type DisposedListener = (session: { id: ReturnType<typeof SessionId> }) => void

function assembly(name: string, text: string): PromptAssembly {
  return {
    sections: [{ name, text }],
    contexts: [],
    tools: [],
    variables: {},
  }
}

describe('LiveAssemblyStore', () => {
  it('keeps exact returned sections, rejects mismatches, bounds retention, and clears on dispose', async () => {
    let assembleListener: AssembleListener | undefined
    let eventListener: EventListener | undefined
    let disposedListener: DisposedListener | undefined
    const context = {
      on: vi.fn((name: string, listener: unknown) => {
        if (name === 'system-prompt/assemble') assembleListener = listener as AssembleListener
        if (name === 'session/event') eventListener = listener as EventListener
        if (name === 'session/disposed') disposedListener = listener as DisposedListener
        return () => {}
      }),
    } as unknown as Context
    const store = new LiveAssemblyStore(context, 2)
    const id = SessionId('live-assembly')
    const session = { id }

    for (const [step, value] of [
      [1, assembly('first', 'one')],
      [2, assembly('second', 'two')],
      [3, assembly('third', 'three')],
    ] as const) {
      const returned = await assembleListener!(assembly('ignored', 'input'), {
        agent: { session },
      }, async () => value)
      expect(returned).toBe(value)
      eventListener!(session, { type: 'step/start', data: { turn: 1, step } })
    }

    expect(store.verifiedSections(id, '1:1', renderPrompt(assembly('first', 'one')))).toBeUndefined()
    expect(store.verifiedSections(id, '1:2', 'different')).toBeUndefined()
    expect(store.verifiedSections(id, '1:3', renderPrompt(assembly('third', 'three')))).toEqual([
      { name: 'third', text: 'three' },
    ])

    disposedListener!(session)
    expect(store.verifiedSections(id, '1:3', renderPrompt(assembly('third', 'three')))).toBeUndefined()
  })
})
