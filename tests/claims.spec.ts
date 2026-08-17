import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { PluginContextLens } from '../src/claims.ts'

describe('PluginContextLens', () => {
  it('resolves config exactly and leaves unknown names unattributed', () => {
    const lens = new PluginContextLens(new Context(), [{
      plugin: '@example/static',
      label: 'Static Plugin',
      tools: ['exact_tool'],
    }])

    expect(lens.resolve('tool', 'exact_tool')).toMatchObject({
      id: '@example/static',
      source: 'config',
    })
    expect(lens.resolve('tool', 'EXACT_TOOL')).toMatchObject({
      id: 'unattributed',
      source: 'none',
    })
  })

  it('reports same-priority conflicts instead of choosing a plugin', () => {
    const lens = new PluginContextLens(new Context(), [
      { plugin: '@example/a', tools: ['shared'] },
      { plugin: '@example/b', tools: ['shared'] },
    ])

    expect(lens.resolve('tool', 'shared')).toMatchObject({
      category: 'conflicted',
      source: 'conflict',
    })
  })

  it('gives a live fiber claim precedence and removes it with the fiber', async () => {
    const ctx = new Context()
    const lens = new PluginContextLens(ctx, [{
      plugin: '@example/configured',
      sections: ['shared-section'],
    }])
    const contributor = {
      name: '@example/live',
      apply: (scope: Context) => {
        scope.pluginContextLens.claim({
          label: 'Live Contributor',
          sections: ['shared-section'],
        })
      },
    }

    const fiber = await ctx.plugin(contributor)
    expect(lens.resolve('section', 'shared-section')).toMatchObject({
      id: '@example/live',
      label: 'Live Contributor',
      source: 'claim',
    })

    await fiber.dispose()
    expect(lens.resolve('section', 'shared-section')).toMatchObject({
      id: '@example/configured',
      source: 'config',
    })
  })

  it('rejects empty claims', () => {
    const lens = new PluginContextLens(new Context(), [])
    expect(() => { lens.claim({}) }).toThrow('claim has no contribution names')
  })
})
