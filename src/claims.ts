import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { ContributionOwner } from './contracts.ts'
import { DSH_RC7_MANIFEST, type BuiltinManifestEntry } from './manifest.ts'

export type ClaimKind = 'section' | 'context' | 'tool'

/** Exact names one plugin claims in the assembled model input. */
export interface ContextLensClaim {
  readonly label?: string
  readonly sections?: readonly string[]
  readonly contexts?: readonly string[]
  readonly tools?: readonly string[]
}

/** Operator-authored claim for a plugin that cannot call the live seam itself. */
export interface ConfiguredContextLensClaim extends ContextLensClaim {
  readonly plugin: string
}

interface OwnerRecord {
  readonly id: string
  readonly label: string
}

type ClaimTable = Map<string, OwnerRecord[]>

const require = createRequire(import.meta.url)

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Read-only diagnostics registry for exact model-input contribution names. */
    pluginContextLens: PluginContextLens
  }
}

export const CONVERSATION_OWNER: ContributionOwner = {
  id: 'conversation',
  label: 'Conversation',
  category: 'conversation',
  source: 'reserved',
}

export const UNATTRIBUTED_OWNER: ContributionOwner = {
  id: 'unattributed',
  label: 'Unattributed',
  category: 'unattributed',
  source: 'none',
}

export const REQUEST_FRAMING_OWNER: ContributionOwner = {
  id: '@deepseek-ai/dsh-llm',
  label: 'LLM Request Framing',
  category: 'plugin',
  source: 'reserved',
}

function tableKey(kind: ClaimKind, name: string): string {
  return `${kind}:${name}`
}

/** Convert a package/fiber id into a compact diagnostic label. */
export function pluginLabel(plugin: string): string {
  const tail = plugin.split('/').at(-1) ?? plugin
  return tail.replace(/^dsh-(?:tool-)?/, '').split('-')
    .map(word => word.length === 0 ? word : word[0]!.toUpperCase() + word.slice(1))
    .join(' ')
}

function namesOf(claim: ContextLensClaim): readonly [ClaimKind, readonly string[] | undefined][] {
  return [
    ['section', claim.sections],
    ['context', claim.contexts],
    ['tool', claim.tools],
  ]
}

function hasNames(claim: ContextLensClaim): boolean {
  return namesOf(claim).some(([, names]) => names !== undefined && names.length > 0)
}

function add(table: ClaimTable, owner: OwnerRecord, claim: ContextLensClaim): () => void {
  const inserted: string[] = []
  for (const [kind, names] of namesOf(claim)) {
    for (const name of new Set(names ?? [])) {
      if (name.length === 0) throw new Error('context lens: contribution names must be non-empty')
      const key = tableKey(kind, name)
      const owners = table.get(key) ?? []
      owners.push(owner)
      table.set(key, owners)
      inserted.push(key)
    }
  }
  return () => {
    for (const key of inserted) {
      const owners = table.get(key)
      if (owners === undefined) continue
      const index = owners.indexOf(owner)
      if (index !== -1) owners.splice(index, 1)
      if (owners.length === 0) table.delete(key)
    }
  }
}

function packageVersion(plugin: string): string | undefined {
  try {
    const path = require.resolve(`${plugin}/package.json`)
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : undefined
  } catch {
    return undefined
  }
}

function enableManifest(
  table: ClaimTable,
  manifest: readonly BuiltinManifestEntry[],
): string[] {
  const warnings: string[] = []
  for (const entry of manifest) {
    const installed = packageVersion(entry.plugin)
    if (installed !== entry.version) {
      if (installed !== undefined) {
        warnings.push(`${entry.plugin} ${installed} does not match attribution manifest ${entry.version}`)
      }
      continue
    }
    add(table, { id: entry.plugin, label: entry.label }, entry)
  }
  return warnings
}

function ownerResult(
  records: readonly OwnerRecord[] | undefined,
  source: ContributionOwner['source'],
): ContributionOwner | undefined {
  if (records === undefined || records.length === 0) return undefined
  const unique = [...new Map(records.map(record => [record.id, record])).values()]
  if (unique.length === 1) {
    return { ...unique[0]!, category: 'plugin', source }
  }
  return {
    id: `conflicted:${unique.map(record => record.id).sort().join('|')}`,
    label: `Conflicted: ${unique.map(record => record.label).sort().join(', ')}`,
    category: 'conflicted',
    source: 'conflict',
  }
}

/**
 * Exact contribution registry. Live callers are resolved before operator config,
 * then the version-verified first-party manifest.
 */
export class PluginContextLens extends Service {
  private readonly live: ClaimTable = new Map()
  private readonly configured: ClaimTable = new Map()
  private readonly builtin: ClaimTable = new Map()
  readonly manifestWarnings: readonly string[]

  constructor(ctx: Context, configured: readonly ConfiguredContextLensClaim[]) {
    super(ctx, 'pluginContextLens')
    for (const claim of configured) {
      if (!hasNames(claim)) throw new Error(`context lens: configured claim for ${claim.plugin} has no names`)
      add(this.configured, {
        id: claim.plugin,
        label: claim.label ?? pluginLabel(claim.plugin),
      }, claim)
    }
    this.manifestWarnings = enableManifest(this.builtin, DSH_RC7_MANIFEST)
  }

  /**
   * Claim exact contribution names for the calling Cordis plugin fiber.
   * The registration belongs to that caller and disappears with its effect scope.
   */
  claim(claim: ContextLensClaim): () => void {
    if (!hasNames(claim)) throw new Error('context lens: claim has no contribution names')
    const plugin = this.ctx.fiber.name
    const owner = { id: plugin, label: claim.label ?? pluginLabel(plugin) }
    return this.ctx.effect(
      () => add(this.live, owner, claim),
      `plugin-context-lens: claim ${plugin}`,
    )
  }

  /** Resolve one exact section, context, or tool name without inference. */
  resolve(kind: ClaimKind, name: string): ContributionOwner {
    const key = tableKey(kind, name)
    return ownerResult(this.live.get(key), 'claim')
      ?? ownerResult(this.configured.get(key), 'config')
      ?? ownerResult(this.builtin.get(key), 'manifest')
      ?? UNATTRIBUTED_OWNER
  }
}
