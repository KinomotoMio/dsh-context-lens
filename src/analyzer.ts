import type { ContentBlock, Message, TokenUsage, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { EpochHeader, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { deriveEventMessage, foldSurface } from '@deepseek-ai/dsh-session/surface'
import {
  CONVERSATION_OWNER,
  REQUEST_FRAMING_OWNER,
  UNATTRIBUTED_OWNER,
  pluginLabel,
  type PluginContextLens,
} from './claims.ts'
import {
  CONTEXT_LENS_WIRE_VERSION,
  type CacheSummary,
  type ContextLensDocument,
  type ContextLensDetail,
  type ContextLensSnapshot,
  type ContributionChange,
  type ContributionKind,
  type ContributionOwner,
  type LensContribution,
  type LensContributor,
  type LensRequestCatalogItem,
} from './contracts.ts'
import {
  allocateTokens,
  digest,
  estimateMessage,
  estimateSystem,
  estimateTools,
} from './estimate.ts'
import type { VerifiedSystemSection } from './live-assembly.ts'

interface RequestRecord {
  readonly key: string
  readonly turn: number
  readonly step: number
  readonly startSeq: number
  readonly startedAt: number
  readonly cutoffSeq: number
  readonly status: 'running' | 'complete' | 'error'
  readonly header: EpochHeader | undefined
  readonly usage: TokenUsage | undefined
}

interface MutableRequestRecord {
  key: string
  turn: number
  step: number
  startSeq: number
  startedAt: number
  cutoffSeq?: number
  status: 'running' | 'complete' | 'error'
  header: EpochHeader | undefined
  usage: TokenUsage | undefined
  producedAssistant: boolean
}

interface RawContribution {
  readonly identity: string
  readonly kind: ContributionKind
  readonly name: string
  readonly owner: ContributionOwner
  readonly plane: ContextLensDocument['blocks'][number]['plane']
  readonly tokens: number
  readonly order: number
  readonly contentDigest: string
  readonly format: ContextLensDetail['format']
  readonly content: string
}

export interface AnalysisResult {
  readonly snapshot: ContextLensSnapshot
  readonly document: ContextLensDocument
  readonly details: ReadonlyMap<string, ContextLensDetail>
}

export interface AnalyzeOptions {
  readonly sessionId: SessionId
  readonly events: readonly SessionEvent[]
  readonly requestKey?: string
  readonly requestHistoryLimit: number
  readonly claims: PluginContextLens
  readonly surfaceTokens: (cutoffSeq: number) => ReadonlyMap<number, number>
  readonly verifiedSections: (
    requestKey: string,
    system: string,
  ) => readonly VerifiedSystemSection[] | undefined
  readonly warnings?: readonly string[]
}

function keyOf(turn: number, step: number): string {
  return `${turn}:${step}`
}

function finalize(open: MutableRequestRecord, endSeq: number): RequestRecord {
  return {
    key: open.key,
    turn: open.turn,
    step: open.step,
    startSeq: open.startSeq,
    startedAt: open.startedAt,
    cutoffSeq: open.cutoffSeq ?? endSeq,
    status: open.status,
    header: open.header,
    usage: open.usage,
  }
}

/** Reconstruct ordinary Agent requests and the exact surface cutoff each request consumed. */
export function requestRecords(events: readonly SessionEvent[]): readonly RequestRecord[] {
  const requests: RequestRecord[] = []
  let header: EpochHeader | undefined
  let open: MutableRequestRecord | undefined
  for (const event of events) {
    if (event.type === 'request/header') {
      header = event.data.header
      if (open !== undefined) open.header = header
      continue
    }
    if (event.type === 'step/start') {
      if (open !== undefined) requests.push(finalize(open, event.seq))
      open = {
        key: keyOf(event.data.turn, event.data.step),
        turn: event.data.turn,
        step: event.data.step,
        startSeq: event.seq,
        startedAt: event.time,
        status: 'running',
        header,
        usage: undefined,
        producedAssistant: false,
      }
      continue
    }
    if (open === undefined) continue
    if (event.type === 'assistant/chunk'
      && event.data.turn === open.turn
      && event.data.step === open.step) {
      open.cutoffSeq ??= event.seq
      continue
    }
    if (event.type === 'assistant/message'
      && event.data.turn === open.turn
      && event.data.step === open.step) {
      open.cutoffSeq ??= event.seq
      open.usage = event.data.usage
      open.producedAssistant = true
      continue
    }
    if (event.type === 'step/end'
      && event.data.turn === open.turn
      && event.data.step === open.step) {
      open.status = open.producedAssistant ? 'complete' : 'error'
      requests.push(finalize(open, event.seq))
      open = undefined
    }
  }
  if (open !== undefined) requests.push(finalize(open, events.length))
  return requests
}

function cacheSummary(usage: TokenUsage | undefined): CacheSummary {
  const reported = usage !== undefined
    && (usage.cacheReadTokens !== undefined || usage.cacheWriteTokens !== undefined)
  if (!reported || usage === undefined) return { reported: false }
  const uncachedInputTokens = usage.inputTokens
  const cacheReadTokens = usage.cacheReadTokens ?? 0
  const cacheWriteTokens = usage.cacheWriteTokens ?? 0
  const billedInputTokens = uncachedInputTokens + cacheReadTokens + cacheWriteTokens
  return {
    reported: true,
    uncachedInputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    billedInputTokens,
    ...(billedInputTokens === 0
      ? {}
      : { hitPercent: cacheReadTokens / billedInputTokens * 100 }),
  }
}

function catalogItem(record: RequestRecord): LensRequestCatalogItem {
  const header = record.header
  const cache = cacheSummary(record.usage)
  return {
    key: record.key,
    turn: record.turn,
    step: record.step,
    status: record.status,
    startedAt: record.startedAt,
    ...(typeof header?.config.model === 'string' ? { model: header.config.model } : {}),
    ...(typeof header?.config.provider === 'string' ? { provider: header.config.provider } : {}),
    ...(cache.reported ? { cacheReadTokens: cache.cacheReadTokens } : {}),
  }
}

function eventOwner(plugin: string): ContributionOwner {
  return {
    id: plugin,
    label: pluginLabel(plugin),
    category: 'plugin',
    source: 'event',
  }
}

function contentDetail(message: Message): Pick<RawContribution, 'format' | 'content'> {
  if (message.content.length === 1 && message.content[0]?.type === 'text') {
    return { format: 'text', content: message.content[0].text }
  }
  return { format: 'json', content: JSON.stringify(message.content, null, 2) }
}

function rawContribution(
  input: Omit<RawContribution, 'contentDigest'>,
): RawContribution {
  return { ...input, contentDigest: digest(input.content) }
}

function systemContributions(
  request: RequestRecord,
  claims: PluginContextLens,
  sections: readonly VerifiedSystemSection[] | undefined,
  orderStart: number,
): { rows: RawContribution[]; verified: boolean } {
  const system = request.header?.system ?? ''
  if (system.length === 0) return { rows: [], verified: sections !== undefined }
  const total = estimateSystem(system)
  if (sections === undefined) {
    return {
      verified: false,
      rows: [rawContribution({
        identity: 'system-prompt:rendered',
        kind: 'system-prompt',
        name: 'Rendered system prompt',
        owner: UNATTRIBUTED_OWNER,
        plane: 'system',
        tokens: total,
        order: orderStart,
        format: 'text',
        content: system,
      })],
    }
  }

  const weights = [
    ...sections.map((section, index) => ({
      id: `section:${index}`,
      weight: section.text.length + (index === sections.length - 1 ? 0 : 2),
    })),
    { id: 'framing', weight: 16 },
  ]
  const allocation = allocateTokens(total, weights)
  const rows = sections.map((section, index) => rawContribution({
    identity: `system-section:${section.name}`,
    kind: 'system-section',
    name: section.name,
    owner: claims.resolve('section', section.name),
    plane: 'system',
    tokens: allocation.get(`section:${index}`) ?? 0,
    order: orderStart + index,
    format: 'text',
    content: section.text,
  }))
  rows.push(rawContribution({
    identity: 'framing:system',
    kind: 'framing',
    name: 'System message framing',
    owner: REQUEST_FRAMING_OWNER,
    plane: 'system',
    tokens: allocation.get('framing') ?? 0,
    order: orderStart + sections.length,
    format: 'text',
    content: 'Provider-neutral system role and section separators.',
  }))
  return { rows, verified: true }
}

function toolContributions(
  tools: readonly ToolSchema[],
  claims: PluginContextLens,
  orderStart: number,
): RawContribution[] {
  if (tools.length === 0) return []
  const total = estimateTools(tools)
  const serialized = tools.map(tool => JSON.stringify(tool))
  const punctuation = Math.max(1, JSON.stringify(tools).length
    - serialized.reduce((sum, value) => sum + value.length, 0) + 16)
  const allocation = allocateTokens(total, [
    ...serialized.map((value, index) => ({ id: `tool:${index}`, weight: value.length })),
    { id: 'framing', weight: punctuation },
  ])
  const rows = tools.map((tool, index) => rawContribution({
    identity: `tool:${tool.name}`,
    kind: 'tool',
    name: tool.name,
    owner: claims.resolve('tool', tool.name),
    plane: 'tools',
    tokens: allocation.get(`tool:${index}`) ?? 0,
    order: orderStart + index,
    format: 'json',
    content: JSON.stringify(tool, null, 2),
  }))
  rows.push(rawContribution({
    identity: 'framing:tools',
    kind: 'framing',
    name: 'Tool catalog framing',
    owner: REQUEST_FRAMING_OWNER,
    plane: 'tools',
    tokens: allocation.get('framing') ?? 0,
    order: orderStart + tools.length,
    format: 'text',
    content: 'Provider-neutral tool array delimiters and schema framing.',
  }))
  return rows
}

interface SnapshotSource {
  readonly kind: 'plugin'
  readonly plugin: string
  readonly form: 'snapshot'
  readonly sections: readonly { readonly name: string; readonly text: string }[]
}

function isSnapshotSource(source: Message['source']): source is SnapshotSource {
  const candidate = source as Partial<SnapshotSource>
  return candidate.kind === 'plugin'
    && candidate.form === 'snapshot'
    && Array.isArray(candidate.sections)
}

function snapshotMessageContributions(
  message: Message,
  source: SnapshotSource,
  total: number,
  claims: PluginContextLens,
  orderStart: number,
): RawContribution[] {
  const sectionLength = source.sections.reduce((sum, section) => sum + section.text.length, 0)
  const contentLength = JSON.stringify(message.content).length
  const framingWeight = Math.max(1, contentLength - sectionLength + 16)
  const allocation = allocateTokens(total, [
    ...source.sections.map((section, index) => ({ id: `context:${index}`, weight: section.text.length })),
    { id: 'framing', weight: framingWeight },
  ])
  const rows = source.sections.map((section, index) => rawContribution({
    identity: `runtime-context:${section.name}`,
    kind: 'runtime-context',
    name: section.name,
    owner: claims.resolve('context', section.name),
    plane: 'messages',
    tokens: allocation.get(`context:${index}`) ?? 0,
    order: orderStart + index,
    format: 'text',
    content: section.text,
  }))
  rows.push(rawContribution({
    identity: `framing:runtime-context:${source.plugin}`,
    kind: 'framing',
    name: 'Runtime context framing',
    owner: eventOwner(source.plugin),
    plane: 'messages',
    tokens: allocation.get('framing') ?? 0,
    order: orderStart + source.sections.length,
    format: 'text',
    content: 'Runtime snapshot wrapper, separators, and user-role message framing.',
  }))
  return rows
}

function messageContributions(
  events: readonly SessionEvent[],
  cutoffSeq: number,
  claims: PluginContextLens,
  meteredTokens: ReadonlyMap<number, number>,
  orderStart: number,
): RawContribution[] {
  const prefix = events.slice(0, cutoffSeq)
  const surface = foldSurface(prefix)
  const rows: RawContribution[] = []
  for (const seq of surface.nodes) {
    const event = prefix[seq]
    if (event === undefined) continue
    const message = deriveEventMessage(event)
    if (message === null) continue
    const tokens = meteredTokens.get(seq) ?? estimateMessage(message)
    if (isSnapshotSource(message.source)) {
      rows.push(...snapshotMessageContributions(
        message,
        message.source,
        tokens,
        claims,
        orderStart + rows.length,
      ))
      continue
    }
    const plugin = message.source.kind === 'plugin' ? message.source.plugin : undefined
    const detail = contentDetail(message)
    rows.push(rawContribution({
      identity: `${plugin === undefined ? 'conversation-message' : 'plugin-message'}:${message.id}`,
      kind: plugin === undefined ? 'conversation-message' : 'plugin-message',
      name: plugin === undefined ? `${message.role} message` : `${plugin} message`,
      owner: plugin === undefined ? CONVERSATION_OWNER : eventOwner(plugin),
      plane: 'messages',
      tokens,
      order: orderStart + rows.length,
      ...detail,
    }))
  }
  return rows
}

function contributionsFor(
  request: RequestRecord,
  events: readonly SessionEvent[],
  claims: PluginContextLens,
  verifiedSections: readonly VerifiedSystemSection[] | undefined,
  meteredTokens: ReadonlyMap<number, number>,
): { rows: RawContribution[]; verified: boolean } {
  const system = systemContributions(request, claims, verifiedSections, 0)
  const tools = toolContributions(request.header?.tools ?? [], claims, system.rows.length)
  const messages = messageContributions(
    events,
    request.cutoffSeq,
    claims,
    meteredTokens,
    system.rows.length + tools.length,
  )
  return { rows: [...system.rows, ...tools, ...messages], verified: system.verified }
}

function detailRef(requestKey: string, index: number, row: RawContribution): string {
  return `${requestKey}:${index}:${digest(`${row.identity}:${row.contentDigest}`)}`
}

function contributionRows(
  current: readonly RawContribution[],
  previous: readonly RawContribution[],
  requestKey: string,
): { rows: LensContribution[]; details: Map<string, ContextLensDetail>; changes: ContributionChange[] } {
  const previousById = new Map(previous.map(row => [row.identity, row]))
  const currentIds = new Set(current.map(row => row.identity))
  const total = current.reduce((sum, row) => sum + row.tokens, 0)
  const details = new Map<string, ContextLensDetail>()
  const rows = current.map((row, index): LensContribution => {
    const before = previousById.get(row.identity)
    const change = before === undefined
      ? 'added'
      : before.contentDigest !== row.contentDigest
        ? 'changed'
        : before.order !== row.order
          ? 'moved'
          : 'unchanged'
    const ref = detailRef(requestKey, index, row)
    details.set(ref, {
      version: CONTEXT_LENS_WIRE_VERSION,
      ref,
      format: row.format,
      content: row.content,
    })
    return {
      id: row.identity,
      kind: row.kind,
      name: row.name,
      owner: row.owner,
      tokens: row.tokens,
      percent: total === 0 ? 0 : row.tokens / total * 100,
      deltaTokens: row.tokens - (before?.tokens ?? 0),
      change,
      order: row.order,
      detailRef: ref,
    }
  })
  const changes: ContributionChange[] = rows.flatMap(row => row.change === 'unchanged'
    ? []
    : [{
        id: row.id,
        name: row.name,
        kind: row.kind,
        owner: row.owner,
        change: row.change,
        deltaTokens: row.deltaTokens,
      }])
  for (const row of previous) {
    if (currentIds.has(row.identity)) continue
    changes.push({
      id: row.identity,
      name: row.name,
      kind: row.kind,
      owner: row.owner,
      change: 'removed',
      deltaTokens: -row.tokens,
    })
  }
  return { rows, details, changes }
}

function contributors(
  rows: readonly LensContribution[],
  previous: readonly RawContribution[],
): LensContributor[] {
  const total = rows.reduce((sum, row) => sum + row.tokens, 0)
  const previousTotals = new Map<string, number>()
  for (const row of previous) {
    previousTotals.set(row.owner.id, (previousTotals.get(row.owner.id) ?? 0) + row.tokens)
  }
  const grouped = new Map<string, LensContributor>()
  for (const row of rows) {
    const existing = grouped.get(row.owner.id)
    if (existing === undefined) {
      grouped.set(row.owner.id, {
        owner: row.owner,
        tokens: row.tokens,
        percent: 0,
        deltaTokens: row.tokens - (previousTotals.get(row.owner.id) ?? 0),
        contributions: [row],
      })
      continue
    }
    existing.tokens += row.tokens
    existing.contributions.push(row)
  }
  return [...grouped.values()]
    .map(group => ({
      ...group,
      percent: total === 0 ? 0 : group.tokens / total * 100,
      contributions: group.contributions.sort((left, right) => left.order - right.order),
    }))
    .sort((left, right) => right.tokens - left.tokens || left.owner.label.localeCompare(right.owner.label))
}

/** Analyze one selected ordinary request without mutating the supplied event log. */
export function analyzeContext(options: AnalyzeOptions): AnalysisResult {
  const records = requestRecords(options.events)
  if (records.length === 0) throw new Error('No ordinary model request is available in this session.')
  const selectedIndex = options.requestKey === undefined
    ? records.length - 1
    : records.findIndex(record => record.key === options.requestKey)
  if (selectedIndex < 0) throw new Error(`Request ${options.requestKey} is not available in this session.`)
  const selected = records[selectedIndex]!
  const previous = selectedIndex > 0 ? records[selectedIndex - 1] : undefined
  const system = selected.header?.system ?? ''
  const selectedVerified = options.verifiedSections(selected.key, system)
  const currentSet = contributionsFor(
    selected,
    options.events,
    options.claims,
    selectedVerified,
    options.surfaceTokens(selected.cutoffSeq),
  )
  const previousSet = previous === undefined
    ? { rows: [] as RawContribution[], verified: false }
    : contributionsFor(
        previous,
        options.events,
        options.claims,
        options.verifiedSections(previous.key, previous.header?.system ?? ''),
        options.surfaceTokens(previous.cutoffSeq),
      )
  const built = contributionRows(currentSet.rows, previousSet.rows, selected.key)
  const grouped = contributors(built.rows, previousSet.rows)
  const estimatedTokens = built.rows.reduce((sum, row) => sum + row.tokens, 0)
  const attributedTokens = built.rows.reduce((sum, row) =>
    row.owner.category === 'unattributed' || row.owner.category === 'conflicted'
      ? sum
      : sum + row.tokens, 0)
  const warnings = [...(options.warnings ?? [])]
  if (system.length > 0 && !currentSet.verified) {
    warnings.push('Structured system sections were unavailable or did not match the final request header.')
  }
  const requestCatalog = records.slice(-options.requestHistoryLimit).map(catalogItem)
  return {
    snapshot: {
      version: CONTEXT_LENS_WIRE_VERSION,
      sessionId: options.sessionId,
      logRevision: options.events.length,
      mode: system.length > 0 && currentSet.verified ? 'live-verified' : 'reconstructed',
      requests: requestCatalog,
      selected: catalogItem(selected),
      ...(previous === undefined ? {} : { previousKey: previous.key }),
      estimatedTokens,
      attributedTokens,
      attributionPercent: estimatedTokens === 0 ? 100 : attributedTokens / estimatedTokens * 100,
      contributors: grouped,
      changes: built.changes,
      cache: cacheSummary(selected.usage),
      warnings,
    },
    document: {
      version: CONTEXT_LENS_WIRE_VERSION,
      sessionId: options.sessionId,
      requestKey: selected.key,
      estimatedTokens,
      blocks: currentSet.rows.map(row => ({
        id: row.identity,
        plane: row.plane,
        kind: row.kind,
        name: row.name,
        owner: row.owner,
        tokens: row.tokens,
        order: row.order,
        format: row.format,
        content: row.content,
      })),
    },
    details: built.details,
  }
}

/** Estimate raw blocks for parity tests without exposing analyzer internals. */
export function estimateBlocksForTest(blocks: readonly ContentBlock[]): number {
  return estimateMessage({
    id: 'lens-test' as Message['id'],
    role: 'user',
    content: [...blocks],
    source: { kind: 'plugin', plugin: 'lens-test' },
  })
}
