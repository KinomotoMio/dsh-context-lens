import { Context, Service } from '@deepseek-ai/cordis'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type {
  ConnectionRpcHandler,
  HostConnectionHandle,
} from '@deepseek-ai/dsh-client-connection'
import { describe, expect, it, vi } from 'vitest'
import * as ContextLens from '../src/index.ts'
import {
  CONTEXT_LENS_RPC_CHANNEL,
  CONTEXT_LENS_WIRE_VERSION,
  snapshotSchema,
} from '../src/contracts.ts'

function requestSession(id: string): Session {
  const session = Session.create(SessionId(id))
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'hello host' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('request/header', {
    header: {
      config: { provider: 'mock', model: 'deepseek-test' },
      system: 'read-only policy',
    },
    reason: 'initial',
  })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'done' }],
      source: { kind: 'model', provider: 'mock', model: 'deepseek-test' },
    }),
    usage: {
      inputTokens: 12,
      outputTokens: 3,
      cacheReadTokens: 18,
    },
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return session
}

class TestConnection extends Service implements HostConnectionHandle {
  handler: ConnectionRpcHandler | undefined

  constructor(ctx: Context) {
    super(ctx, 'connection')
  }

  get rpc(): HostConnectionHandle['rpc'] {
    const owner = this.ctx
    return {
      handle: (channel, value, options) => {
        expect(channel).toBe(CONTEXT_LENS_RPC_CHANNEL)
        expect(options.authority).toBe('trusted-host')
        this.handler = value
        return owner.effect(
          () => async () => { this.handler = undefined },
          'host test rpc',
        )
      },
      intercept: () => async () => {},
    }
  }
}

describe('Host RPC', () => {
  it('reads live and cold sessions without appending events and unregisters with its fiber', async () => {
    const ctx = new Context()
    const live = requestSession('live')
    const cold = requestSession('cold')
    const beforeLive = structuredClone(live.events)
    const beforeCold = structuredClone(cold.events)
    const inspect = vi.fn(async () => ({ events: cold.events }))
    const connection = new TestConnection(ctx)
    ctx.provide('sessions', { get: (id: SessionId) => id === live.id ? live : undefined } as never)
    ctx.provide('sessionPersistence', { inspect } as never)
    ctx.provide('systemPrompt', {} as never)
    ctx.provide('tokenMeter', {
      measure: (session: Session) => ({
        nodes: session.events.flatMap(event =>
          event.type === 'user/message' || event.type === 'assistant/message'
            ? [{ seq: event.seq, tokens: 5 }]
            : []),
      }),
    } as never)

    const fiber = await ctx.plugin(ContextLens, { requestHistoryLimit: 5 })
    expect(connection.handler).toBeDefined()
    const signal = new AbortController().signal
    const liveResult = await connection.handler!('snapshot', {
      version: CONTEXT_LENS_WIRE_VERSION,
      sessionId: 'live',
    }, signal)
    expect(liveResult.ok).toBe(true)
    expect(inspect).not.toHaveBeenCalled()

    const coldResult = await connection.handler!('snapshot', {
      version: CONTEXT_LENS_WIRE_VERSION,
      sessionId: 'cold',
    }, signal)
    expect(coldResult.ok).toBe(true)
    expect(inspect).toHaveBeenCalledOnce()

    if (!coldResult.ok) throw new Error('expected a snapshot')
    const coldSnapshot = snapshotSchema.parse(coldResult.value)
    const detailRef = coldSnapshot.contributors[0]?.contributions[0]?.detailRef
    expect(detailRef).toBeTypeOf('string')
    const detail = await connection.handler!('detail', {
      version: CONTEXT_LENS_WIRE_VERSION,
      sessionId: 'cold',
      ref: detailRef,
    }, signal)
    expect(detail.ok).toBe(true)

    const document = await connection.handler!('document', {
      version: CONTEXT_LENS_WIRE_VERSION,
      sessionId: 'cold',
    }, signal)
    expect(document.ok).toBe(true)
    if (!document.ok) throw new Error('expected a document')
    expect(document.value).toMatchObject({
      version: CONTEXT_LENS_WIRE_VERSION,
      sessionId: 'cold',
      requestKey: '1:1',
      blocks: [
        {
          order: 0,
          plane: 'system',
          kind: 'system-prompt',
          content: 'read-only policy',
        },
        {
          order: 1,
          plane: 'messages',
          kind: 'conversation-message',
          content: 'hello host',
        },
      ],
    })

    const invalid = await connection.handler!('snapshot', { version: 999, sessionId: 'cold' }, signal)
    expect(invalid).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect(live.events).toEqual(beforeLive)
    expect(cold.events).toEqual(beforeCold)

    await fiber.dispose()
    expect(connection.handler).toBeUndefined()
  })
})
