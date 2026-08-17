import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { apply } from '../../src/client/index.ts'

describe('client registration', () => {
  it('registers Lens with its collision-safe id and exposes unload disposers', () => {
    const dictionaryDispose = vi.fn()
    const viewDispose = vi.fn()
    const effects: Array<() => void> = []
    const register = vi.fn((_options: { label: () => string }, _component: unknown) => viewDispose)
    const inject = vi.fn((_name: string, mount: () => () => void) => {
      effects.push(mount())
    })
    const context = {
      get: () => ({ rpc: { call: vi.fn() } }),
      effect: (mount: () => () => void) => {
        effects.push(mount())
      },
      locale: {
        register: vi.fn(() => dictionaryDispose),
        bind: () => (key: string) => key === 'view.label' ? 'Lens' : key,
      },
      slots: { inject, register },
    } as unknown as Context

    apply(context)

    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'conversation.view',
        id: 'plugin-context-lens',
        order: 20,
      }),
      expect.any(Function),
    )
    const options = register.mock.calls[0]![0]
    expect(options.label()).toBe('Lens')

    for (const dispose of effects.reverse()) dispose()
    expect(viewDispose).toHaveBeenCalledOnce()
    expect(dictionaryDispose).toHaveBeenCalledOnce()
  })
})
