import { Context, Service } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { pluginLabel, tableKey, type ClaimTable } from '../src/claims.ts'
import { observe } from '../src/observe.ts'

class FakeTools extends Service {
  constructor(ctx: Context) {
    super(ctx, 'tools')
  }

  register(definition: { name: string }): () => void {
    return this.ctx.effect(() => () => undefined, `fake-tools.register ${definition.name}`)
  }
}

class FakeSystemPrompt extends Service {
  constructor(ctx: Context) {
    super(ctx, 'systemPrompt')
  }

  section(section: { name: string }): () => void {
    return this.ctx.effect(() => () => undefined, `fake-systemPrompt.section ${section.name}`)
  }

  context(context: { name: string }): () => void {
    return this.ctx.effect(() => () => undefined, `fake-systemPrompt.context ${context.name}`)
  }
}

function owners(table: ClaimTable, kind: 'tool' | 'section' | 'context', name: string) {
  return table.get(tableKey(kind, name)) ?? []
}

describe('observe registrations', () => {
  it('records the caller fiber, not Lens, and drops the record when the child disposes', async () => {
    const ctx = new Context()
    new FakeTools(ctx)
    new FakeSystemPrompt(ctx)

    const table: ClaimTable = new Map()
    observe(ctx, table)

    const child = {
      name: '@example/child',
      apply: (scope: Context) => {
        scope.get('tools').register({ name: 'child_tool' })
        scope.get('systemPrompt').section({ name: 'child-section' })
        scope.get('systemPrompt').context({ name: 'child-context' })
      },
    }

    const fiber = await ctx.plugin(child)
    const owner = { id: '@example/child', label: pluginLabel('@example/child') }
    expect(owners(table, 'tool', 'child_tool')).toEqual([owner])
    expect(owners(table, 'section', 'child-section')).toEqual([owner])
    expect(owners(table, 'context', 'child-context')).toEqual([owner])
    expect(owner.id).not.toBe(ctx.fiber.name)
    expect(owner.id).not.toBe('plugin-context-lens')

    await fiber.dispose()
    expect(owners(table, 'tool', 'child_tool')).toEqual([])
    expect(owners(table, 'section', 'child-section')).toEqual([])
    expect(owners(table, 'context', 'child-context')).toEqual([])
  })

  it('does not record an empty fiber name', () => {
    const ctx = new Context()
    new FakeTools(ctx)
    const table: ClaimTable = new Map()
    observe(ctx, table)

    const tools = ctx.get('tools') as FakeTools
    const fiber = tools.ctx.fiber
    const describe = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(fiber), 'name')
    Object.defineProperty(fiber, 'name', { configurable: true, get: () => '' })
    try {
      tools.register({ name: 'anonymous_tool' })
    } finally {
      if (describe === undefined) delete (fiber as { name?: string }).name
      else Object.defineProperty(fiber, 'name', describe)
    }
    expect(owners(table, 'tool', 'anonymous_tool')).toEqual([])
  })
})
