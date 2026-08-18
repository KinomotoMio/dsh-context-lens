import { Context } from '@deepseek-ai/cordis'
import {
  createMessage,
  createUserMessage,
  type AssistantMessage,
  type TokenUsage,
  type ToolSchema,
} from '@deepseek-ai/dsh-llm'
import {
  canonicalHeader,
  Session,
  SessionId,
  type EpochHeader,
  type SessionEvent,
} from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { analyzeContext, requestRecords } from '../src/analyzer.ts'
import { PluginContextLens } from '../src/claims.ts'
import { estimateSystem, estimateTools } from '../src/estimate.ts'

const TOOLS: readonly ToolSchema[] = [{
  name: 'exact_tool',
  description: 'An exact test tool',
  parameters: { type: 'object', properties: {} },
}]

function header(system = 'Stable policy'): EpochHeader {
  return canonicalHeader({
    config: { provider: 'mock', model: 'deepseek-test' },
    system,
    tools: [...TOOLS],
  })
}

function assistant(text: string): AssistantMessage {
  return createMessage({
    role: 'assistant',
    content: [{ type: 'text', text }],
    source: { kind: 'model', provider: 'mock', model: 'deepseek-test' },
  })
}

function appendStep(
  session: Session,
  turn: number,
  step: number,
  usage: TokenUsage,
  requestHeader?: EpochHeader,
): void {
  session.append('step/start', { turn, step })
  if (requestHeader !== undefined) {
    session.append('request/header', {
      header: requestHeader,
      reason: turn === 1 && step === 1 ? 'initial' : 'change',
    })
  }
  session.append('assistant/message', {
    turn,
    step,
    message: assistant(`answer ${turn}.${step}`),
    usage,
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step })
}

function fixture(): Session {
  const session = Session.create(SessionId('lens-fixture'))
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'hello' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  appendStep(session, 1, 1, {
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 60,
    cacheWriteTokens: 20,
  }, header())
  appendStep(session, 1, 2, {
    inputTokens: 50,
    outputTokens: 10,
    cacheReadTokens: 150,
    cacheWriteTokens: 0,
  })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return session
}

function configuredLens(): PluginContextLens {
  return new PluginContextLens(new Context(), [
    { plugin: '@example/policy', sections: ['policy'] },
    { plugin: '@example/tool', tools: ['exact_tool'] },
  ])
}

function analyze(
  events: readonly SessionEvent[],
  verified = true,
) {
  const measured: [number, number][] = []
  for (const event of events) {
    if (event.type === 'user/message') measured.push([event.seq, 7])
    if (event.type === 'assistant/message') measured.push([event.seq, 11])
  }
  return analyzeContext({
    sessionId: SessionId('lens-fixture'),
    events,
    requestHistoryLimit: 10,
    claims: configuredLens(),
    surfaceTokens: cutoff => new Map(measured.filter(([seq]) => seq < cutoff)),
    verifiedSections: (_requestKey, system) => verified && system.length > 0
      ? [{ name: 'policy', text: system }]
      : undefined,
  })
}

describe('request reconstruction', () => {
  it('inherits the latest full header and excludes the current response', () => {
    const session = fixture()
    const records = requestRecords(session.events)

    expect(records).toHaveLength(2)
    expect(records[1]).toMatchObject({ key: '1:2', status: 'complete', header: header() })
    expect(records[1]!.cutoffSeq).toBeLessThan(
      session.events.find(event => event.type === 'step/end' && event.data.step === 2)!.seq,
    )
  })
})

describe('context analysis', () => {
  it('conserves estimated totals and keeps provider cache accounting separate', () => {
    const session = fixture()
    const before = structuredClone(session.events)
    const result = analyze(session.events)
    const snapshot = result.snapshot
    const contributionTotal = snapshot.contributors.reduce((sum, row) => sum + row.tokens, 0)
    const documentTotal = result.document.blocks.reduce((sum, block) => sum + block.tokens, 0)

    expect(contributionTotal).toBe(snapshot.estimatedTokens)
    expect(documentTotal).toBe(snapshot.estimatedTokens)
    expect(result.document.blocks.map(block => block.order)).toEqual(
      result.document.blocks.map(block => block.order).toSorted((left, right) => left - right),
    )
    expect(result.document.blocks.map(block => block.plane)).toEqual([
      'system',
      'system',
      'tools',
      'tools',
      'messages',
      'messages',
    ])
    expect(snapshot.estimatedTokens).toBe(estimateSystem('Stable policy') + estimateTools(TOOLS) + 7 + 11)
    expect(snapshot.reportedTokens).toBe(200)
    expect(snapshot.cache).toEqual({
      reported: true,
      uncachedInputTokens: 50,
      cacheReadTokens: 150,
      cacheWriteTokens: 0,
      billedInputTokens: 200,
      hitPercent: 75,
    })
    expect(snapshot.mode).toBe('live-verified')
    expect(snapshot.changes.some(change => change.change === 'added')).toBe(true)
    expect(session.events).toEqual(before)
  })

  it('falls back to one Unattributed rendered prompt when assembly validation fails', () => {
    const snapshot = analyze(fixture().events, false).snapshot
    const system = snapshot.contributors
      .flatMap(row => row.contributions)
      .find(row => row.kind === 'system-prompt')

    expect(system?.owner).toMatchObject({ id: 'unattributed', category: 'unattributed' })
    expect(snapshot.mode).toBe('reconstructed')
    expect(snapshot.warnings).toContain(
      'Structured system sections were unavailable or did not match the final request header.',
    )
  })

  it('uses event provenance for plugin messages before any name claim', () => {
    const session = Session.create(SessionId('plugin-source'))
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'injected' }],
      source: { kind: 'plugin', plugin: '@example/runtime' },
    }), { surfaceOp: 'append' })
    appendStep(session, 1, 1, { inputTokens: 8, outputTokens: 2 }, header(''))

    const snapshot = analyze(session.events).snapshot
    const pluginMessage = snapshot.contributors
      .flatMap(row => row.contributions)
      .find(row => row.kind === 'plugin-message')

    expect(pluginMessage?.owner).toMatchObject({
      id: '@example/runtime',
      source: 'event',
    })
  })

  it('does not invent cache figures when the provider omitted them', () => {
    const session = Session.create(SessionId('no-cache'))
    session.append('turn/start', { turn: 1 })
    appendStep(session, 1, 1, { inputTokens: 8, outputTokens: 2 }, header(''))

    const snapshot = analyze(session.events).snapshot
    expect(snapshot.cache).toEqual({ reported: false })
    expect(snapshot.reportedTokens).toBe(8)
  })

  it('measures the folded surface after a compaction-style replacement', () => {
    const session = Session.create(SessionId('replacement'))
    session.append('turn/start', { turn: 1 })
    const old = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'old context that should disappear' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const summary = createUserMessage({
      content: [{ type: 'text', text: 'replacement summary' }],
      source: { kind: 'plugin', plugin: '@example/compactor' },
    })
    session.append('user/message', summary, {
      surfaceOp: { op: 'replace', start: old.seq, end: old.seq },
      sourceEventSeqs: [old.seq],
    })
    appendStep(session, 1, 1, { inputTokens: 8, outputTokens: 2 }, header(''))

    const contributions = analyze(session.events).snapshot.contributors
      .flatMap(row => row.contributions)
    expect(contributions.some(row => row.id.endsWith(old.data.id))).toBe(false)
    expect(contributions).toContainEqual(expect.objectContaining({
      id: `plugin-message:${summary.id}`,
      owner: expect.objectContaining({ id: '@example/compactor' }),
    }))
  })

  it('reads usage from an assistant/chunk when the assembled message has none', () => {
    const session = Session.create(SessionId('chunk-usage'))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('request/header', { header: header(''), reason: 'initial' })
    session.append('assistant/chunk', {
      turn: 1,
      step: 1,
      chunk: {
        type: 'usage',
        usage: { inputTokens: 40, outputTokens: 6, cacheReadTokens: 80 },
      },
    })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: assistant('chunk only'),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })

    const snapshot = analyze(session.events).snapshot
    expect(snapshot.reportedTokens).toBe(120)
    expect(snapshot.cache).toEqual({
      reported: true,
      uncachedInputTokens: 40,
      cacheReadTokens: 80,
      billedInputTokens: 120,
      hitPercent: 80 / 120 * 100,
    })
  })

  it('lets a later usage sample replace an earlier one', () => {
    const session = Session.create(SessionId('later-usage'))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('request/header', { header: header(''), reason: 'initial' })
    session.append('assistant/chunk', {
      turn: 1,
      step: 1,
      chunk: {
        type: 'usage',
        usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 90 },
      },
    })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: assistant('later wins'),
      usage: { inputTokens: 12, outputTokens: 2, cacheReadTokens: 88 },
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })

    const snapshot = analyze(session.events).snapshot
    expect(snapshot.reportedTokens).toBe(100)
    expect(snapshot.cache.cacheReadTokens).toBe(88)
    expect(snapshot.cache.hitPercent).toBe(88)
  })

  it('omits cache write and still reports a hit rate from prompt tokens', () => {
    const session = Session.create(SessionId('no-write'))
    session.append('turn/start', { turn: 1 })
    appendStep(session, 1, 1, {
      inputTokens: 123,
      outputTokens: 4,
      cacheReadTokens: 896,
    }, header(''))

    const snapshot = analyze(session.events).snapshot
    expect(snapshot.reportedTokens).toBe(1019)
    expect(snapshot.cache).toEqual({
      reported: true,
      uncachedInputTokens: 123,
      cacheReadTokens: 896,
      billedInputTokens: 1019,
      hitPercent: 896 / 1019 * 100,
    })
    expect(snapshot.cache).not.toHaveProperty('cacheWriteTokens')
  })

  it('does not put cache write in the hit-rate denominator', () => {
    const session = Session.create(SessionId('write-excluded'))
    session.append('turn/start', { turn: 1 })
    appendStep(session, 1, 1, {
      inputTokens: 50,
      outputTokens: 4,
      cacheReadTokens: 150,
      cacheWriteTokens: 20,
    }, header(''))

    const snapshot = analyze(session.events).snapshot
    expect(snapshot.reportedTokens).toBe(200)
    expect(snapshot.cache).toEqual({
      reported: true,
      uncachedInputTokens: 50,
      cacheReadTokens: 150,
      cacheWriteTokens: 20,
      billedInputTokens: 200,
      hitPercent: 75,
    })
  })

  it('does not invent a hit rate when only cache write is present', () => {
    const session = Session.create(SessionId('write-only'))
    session.append('turn/start', { turn: 1 })
    appendStep(session, 1, 1, {
      inputTokens: 40,
      outputTokens: 4,
      cacheWriteTokens: 12,
    }, header(''))

    const snapshot = analyze(session.events).snapshot
    expect(snapshot.reportedTokens).toBe(40)
    expect(snapshot.cache).toEqual({
      reported: true,
      uncachedInputTokens: 40,
      cacheWriteTokens: 12,
      billedInputTokens: 40,
    })
    expect(snapshot.cache).not.toHaveProperty('hitPercent')
    expect(snapshot.cache).not.toHaveProperty('cacheReadTokens')
  })
})
