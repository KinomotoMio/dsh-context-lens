/**
 * DSH Context Lens Host plugin. It observes assembled input and serves local,
 * read-only diagnostics to the matching browser client.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {
  RpcErrorDetailsMap,
  RpcResult,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-token-meter'
import { analyzeContext, type AnalysisResult } from './analyzer.ts'
import {
  PluginContextLens,
  type ConfiguredContextLensClaim,
} from './claims.ts'
import {
  CONTEXT_LENS_RPC_CHANNEL,
  detailRequestSchema,
  detailSchema,
  documentRequestSchema,
  documentSchema,
  snapshotRequestSchema,
  snapshotSchema,
} from './contracts.ts'
import { LiveAssemblyStore } from './live-assembly.ts'

export type {
  ConfiguredContextLensClaim,
  ContextLensClaim,
} from './claims.ts'
export type {
  CacheSummary,
  ContextLensDocument,
  ContextLensDocumentBlock,
  ContextLensDetail,
  ContextLensSnapshot,
  ContributionChange,
  ContributionKind,
  ContributionOwner,
  LensContribution,
  LensContributor,
  LensRequestCatalogItem,
} from './contracts.ts'
export {
  CONTEXT_LENS_RPC_CHANNEL,
  CONTEXT_LENS_WIRE_VERSION,
} from './contracts.ts'

/** Plugin config: static exact claims plus bounded diagnostic retention. */
export interface Config {
  readonly claims?: readonly ConfiguredContextLensClaim[]
  readonly liveAssemblyRetention?: number
  readonly requestHistoryLimit?: number
}

const claimSchema = z.object({
  plugin: z.string().min(1).required(),
  label: z.string().min(1),
  sections: z.array(z.string().min(1)).default([]),
  contexts: z.array(z.string().min(1)).default([]),
  tools: z.array(z.string().min(1)).default([]),
})

/** Loader schema for {@link Config}. */
export const Config: z<Config> = z.object({
  claims: z.array(claimSchema).default([]),
  liveAssemblyRetention: z.natural().min(2).max(32).default(2),
  requestHistoryLimit: z.natural().min(1).max(200).default(50),
}).default({
  claims: [],
  liveAssemblyRetention: 2,
  requestHistoryLimit: 50,
}) as z<Config>

/** Cordis plugin name. */
export const name = 'plugin-context-lens'

/** Services used by the observer and its private RPC channel. */
export const inject = [
  'connection',
  'sessionPersistence',
  'sessions',
  'systemPrompt',
  'tokenMeter',
] as const

function badRequest(
  message: string,
  issues: RpcErrorDetailsMap['bad-request']['issues'] = [],
): RpcResult<never> {
  return {
    ok: false,
    error: {
      code: 'bad-request',
      message,
      details: { issues },
    },
  }
}

function internalError(error: unknown): RpcResult<never> {
  return {
    ok: false,
    error: {
      code: 'internal',
      message: error instanceof Error ? error.message : String(error),
      details: {},
    },
  }
}

/** Install the claim seam, live observer, and private read-only RPC channel. */
export function apply(ctx: Context, config: Config = {}): void {
  const claims = new PluginContextLens(ctx, config.claims ?? [])
  const assemblies = new LiveAssemblyStore(ctx, config.liveAssemblyRetention ?? 2)
  const requestHistoryLimit = config.requestHistoryLimit ?? 50

  const readEvents = async (rawSessionId: string, signal: AbortSignal): Promise<readonly SessionEvent[]> => {
    const sessionId = SessionId(rawSessionId)
    const attached = ctx.sessions.get(sessionId)
    if (attached !== undefined) return attached.events
    return (await ctx.sessionPersistence.inspect(sessionId, signal)).events
  }

  const analyze = async (
    rawSessionId: string,
    requestedKey: string | undefined,
    signal: AbortSignal,
  ): Promise<AnalysisResult> => {
    const sessionId = SessionId(rawSessionId)
    const events = await readEvents(rawSessionId, signal)
    return analyzeContext({
      sessionId,
      events,
      ...(requestedKey === undefined ? {} : { requestKey: requestedKey }),
      requestHistoryLimit,
      claims,
      verifiedSections: (requestKey, system) =>
        assemblies.verifiedSections(sessionId, requestKey, system),
      surfaceTokens: (cutoffSeq) => {
        const detached = Session.create(sessionId, events.slice(0, cutoffSeq))
        return new Map(ctx.tokenMeter.measure(detached).nodes.map(node => [node.seq, node.tokens]))
      },
      warnings: claims.manifestWarnings,
    })
  }

  ctx.connection.rpc.handle(CONTEXT_LENS_RPC_CHANNEL, async (endpoint, payload, signal) => {
    if (endpoint === 'snapshot') {
      const parsed = snapshotRequestSchema.safeParse(payload)
      if (!parsed.success) return badRequest('Invalid Context Lens snapshot request.', parsed.error.issues)
      try {
        const result = await analyze(parsed.data.sessionId, parsed.data.requestKey, signal)
        return { ok: true, value: snapshotSchema.parse(result.snapshot) }
      } catch (error) {
        return internalError(error)
      }
    }
    if (endpoint === 'detail') {
      const parsed = detailRequestSchema.safeParse(payload)
      if (!parsed.success) return badRequest('Invalid Context Lens detail request.', parsed.error.issues)
      try {
        const requestKey = /^(\d+:\d+):/.exec(parsed.data.ref)?.[1]
        const result = await analyze(parsed.data.sessionId, requestKey, signal)
        const detail = result.details.get(parsed.data.ref)
        if (detail === undefined) return badRequest('The requested Context Lens detail is stale or unavailable.')
        return { ok: true, value: detailSchema.parse(detail) }
      } catch (error) {
        return internalError(error)
      }
    }
    if (endpoint === 'document') {
      const parsed = documentRequestSchema.safeParse(payload)
      if (!parsed.success) return badRequest('Invalid Context Lens document request.', parsed.error.issues)
      try {
        const result = await analyze(parsed.data.sessionId, parsed.data.requestKey, signal)
        return { ok: true, value: documentSchema.parse(result.document) }
      } catch (error) {
        return internalError(error)
      }
    }
    return badRequest(`Unknown Context Lens endpoint ${JSON.stringify(endpoint)}.`)
  }, { authority: 'trusted-host' })
}
