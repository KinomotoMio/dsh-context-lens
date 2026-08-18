import { Context, type Fiber } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import {
  PluginContextLens,
  loadedPackageIdsInScope,
  selectLoadedOwners,
  withinFiber,
} from '../src/claims.ts'

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

  it('attributes a shared tool name to the loaded package only', () => {
    const bash = { id: '@deepseek-ai/dsh-tool-bash', label: 'Bash' }
    const persistent = { id: '@deepseek-ai/dsh-tool-bash-persistent', label: 'Persistent Bash' }
    expect(selectLoadedOwners([bash, persistent], new Set([bash.id]))).toEqual([bash])
    expect(selectLoadedOwners([bash, persistent], new Set([bash.id, persistent.id]))).toEqual([
      bash,
      persistent,
    ])
    expect(selectLoadedOwners([bash, persistent], new Set())).toBeUndefined()
  })

  it('walks parent.fiber and stops at the root fiber', () => {
    const root = fakeFiber()
    const child = fakeFiber(root)
    const other = fakeFiber()
    expect(withinFiber(asFiber(root), asFiber(root))).toBe(true)
    expect(withinFiber(asFiber(child), asFiber(root))).toBe(true)
    expect(withinFiber(asFiber(root), asFiber(child))).toBe(false)
    expect(withinFiber(asFiber(other), asFiber(root))).toBe(false)
  })

  it('keeps this preset and host-plane packages, dropping other standing presets', () => {
    const hostRoot = fakeFiber()
    const standardRoot = fakeFiber(hostRoot)
    const minimalRoot = fakeFiber(hostRoot)
    const bash = namedFiber('@deepseek-ai/dsh-tool-bash', standardRoot)
    const persistent = namedFiber('@deepseek-ai/dsh-tool-bash-persistent', minimalRoot)
    const hostPrompt = namedFiber('@deepseek-ai/dsh-system-prompt', hostRoot)
    const ctx = fakeRegistry(bash, persistent, hostPrompt)

    expect([...loadedPackageIdsInScope(ctx, {
      presetRoot: asFiber(standardRoot),
      otherPresetRoots: [asFiber(minimalRoot)],
    })].sort()).toEqual([
      '@deepseek-ai/dsh-system-prompt',
      '@deepseek-ai/dsh-tool-bash',
    ])
    expect([...loadedPackageIdsInScope(ctx, {
      otherPresetRoots: [asFiber(standardRoot), asFiber(minimalRoot)],
    })].sort()).toEqual(['@deepseek-ai/dsh-system-prompt'])
  })
})

interface FakeFiber {
  state: number
  entry?: { options?: { name?: string } }
  parent: { fiber: FakeFiber }
}

function asFiber(fiber: FakeFiber): Fiber {
  return fiber as unknown as Fiber
}

function fakeFiber(parent?: FakeFiber): FakeFiber {
  const fiber: FakeFiber = {
    state: 2,
    parent: { fiber: undefined as unknown as FakeFiber },
  }
  fiber.parent.fiber = parent ?? fiber
  return fiber
}

function namedFiber(name: string, parent?: FakeFiber): FakeFiber {
  const fiber = fakeFiber(parent)
  fiber.entry = { options: { name } }
  return fiber
}

function fakeRegistry(...fibers: FakeFiber[]): Context {
  return {
    registry: {
      values: () => [{ fibers: fibers.map(asFiber) }],
    },
  } as unknown as Context
}
