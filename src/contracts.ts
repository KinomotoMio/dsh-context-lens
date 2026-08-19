import { z } from 'zod'

/** Wire revision for the private Host-to-Lens RPC. v2 adds optional snapshot.reportedTokens. */
export const CONTEXT_LENS_WIRE_VERSION = 2 as const

export const ownerCategorySchema = z.enum([
  'plugin',
  'conversation',
  'unattributed',
  'conflicted',
])

export type OwnerCategory = z.infer<typeof ownerCategorySchema>

export const contributionKindSchema = z.enum([
  'system-section',
  'system-prompt',
  'tool',
  'runtime-context',
  'plugin-message',
  'conversation-message',
  'framing',
])

export type ContributionKind = z.infer<typeof contributionKindSchema>

export const contextPlaneSchema = z.enum([
  'system',
  'tools',
  'messages',
])

export type ContextPlane = z.infer<typeof contextPlaneSchema>

export const changeKindSchema = z.enum([
  'added',
  'removed',
  'changed',
  'moved',
  'unchanged',
])

export type ChangeKind = z.infer<typeof changeKindSchema>

export const ownerSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  category: ownerCategorySchema,
  source: z.enum(['event', 'observe', 'claim', 'config', 'manifest', 'reserved', 'none', 'conflict']),
}).strict()

export type ContributionOwner = z.infer<typeof ownerSchema>

export const contributionSchema = z.object({
  id: z.string().min(1),
  kind: contributionKindSchema,
  name: z.string().min(1),
  owner: ownerSchema,
  tokens: z.number().int().nonnegative(),
  percent: z.number().nonnegative(),
  deltaTokens: z.number().int(),
  change: changeKindSchema,
  order: z.number().int().nonnegative(),
  detailRef: z.string().min(1),
}).strict()

export type LensContribution = z.infer<typeof contributionSchema>

export const contributorSchema = z.object({
  owner: ownerSchema,
  tokens: z.number().int().nonnegative(),
  percent: z.number().nonnegative(),
  deltaTokens: z.number().int(),
  contributions: z.array(contributionSchema),
}).strict()

export type LensContributor = z.infer<typeof contributorSchema>

export const requestCatalogItemSchema = z.object({
  key: z.string().min(1),
  turn: z.number().int().positive(),
  step: z.number().int().positive(),
  status: z.enum(['running', 'complete', 'error']),
  startedAt: z.number().int().nonnegative(),
  model: z.string().optional(),
  provider: z.string().optional(),
  cacheReadTokens: z.number().int().nonnegative().optional(),
}).strict()

export type LensRequestCatalogItem = z.infer<typeof requestCatalogItemSchema>

export const cacheSummarySchema = z.object({
  reported: z.boolean(),
  uncachedInputTokens: z.number().int().nonnegative().optional(),
  cacheReadTokens: z.number().int().nonnegative().optional(),
  cacheWriteTokens: z.number().int().nonnegative().optional(),
  billedInputTokens: z.number().int().nonnegative().optional(),
  hitPercent: z.number().min(0).max(100).optional(),
}).strict()

export type CacheSummary = z.infer<typeof cacheSummarySchema>

export const contributionChangeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: contributionKindSchema,
  owner: ownerSchema,
  change: z.enum(['added', 'removed', 'changed', 'moved']),
  deltaTokens: z.number().int(),
}).strict()

export type ContributionChange = z.infer<typeof contributionChangeSchema>

export const snapshotSchema = z.object({
  version: z.literal(CONTEXT_LENS_WIRE_VERSION),
  sessionId: z.string().min(1),
  logRevision: z.number().int().nonnegative(),
  mode: z.enum(['live-verified', 'reconstructed']),
  requests: z.array(requestCatalogItemSchema),
  selected: requestCatalogItemSchema,
  previousKey: z.string().optional(),
  estimatedTokens: z.number().int().nonnegative(),
  reportedTokens: z.number().int().nonnegative().optional(),
  attributedTokens: z.number().int().nonnegative(),
  attributionPercent: z.number().min(0).max(100),
  contributors: z.array(contributorSchema),
  changes: z.array(contributionChangeSchema),
  cache: cacheSummarySchema,
  warnings: z.array(z.string()),
}).strict()

export type ContextLensSnapshot = z.infer<typeof snapshotSchema>

export const detailSchema = z.object({
  version: z.literal(CONTEXT_LENS_WIRE_VERSION),
  ref: z.string().min(1),
  format: z.enum(['text', 'json']),
  content: z.string(),
}).strict()

export type ContextLensDetail = z.infer<typeof detailSchema>

export const documentBlockSchema = z.object({
  id: z.string().min(1),
  plane: contextPlaneSchema,
  kind: contributionKindSchema,
  name: z.string().min(1),
  owner: ownerSchema,
  tokens: z.number().int().nonnegative(),
  order: z.number().int().nonnegative(),
  format: z.enum(['text', 'json']),
  content: z.string(),
}).strict()

export type ContextLensDocumentBlock = z.infer<typeof documentBlockSchema>

export const documentSchema = z.object({
  version: z.literal(CONTEXT_LENS_WIRE_VERSION),
  sessionId: z.string().min(1),
  requestKey: z.string().min(1),
  estimatedTokens: z.number().int().nonnegative(),
  blocks: z.array(documentBlockSchema),
}).strict()

export type ContextLensDocument = z.infer<typeof documentSchema>

export const snapshotRequestSchema = z.object({
  version: z.literal(CONTEXT_LENS_WIRE_VERSION),
  sessionId: z.string().min(1),
  requestKey: z.string().min(1).optional(),
}).strict()

export type SnapshotRequest = z.infer<typeof snapshotRequestSchema>

export const documentRequestSchema = snapshotRequestSchema

export type DocumentRequest = z.infer<typeof documentRequestSchema>

export const detailRequestSchema = z.object({
  version: z.literal(CONTEXT_LENS_WIRE_VERSION),
  sessionId: z.string().min(1),
  ref: z.string().min(1),
}).strict()

export type DetailRequest = z.infer<typeof detailRequestSchema>

/** Logical RPC channel reserved by this package. */
export const CONTEXT_LENS_RPC_CHANNEL = '/dsh-plugin-context-lens'
