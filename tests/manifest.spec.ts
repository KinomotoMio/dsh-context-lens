import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DSH_RC7_MANIFEST } from '../src/manifest.ts'

const RC7_SHA = '99f6f02fecdb7dff40c3fbc9470f5907c29f74ca'
const DSH_ROOT = fileURLToPath(new URL('../../deepseek-harness/', import.meta.url))
const PACKAGES_ROOT = join(DSH_ROOT, 'packages')

function filesBelow(root: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'lib' || entry.name === 'dist') continue
    const path = join(root, entry.name)
    if (entry.isDirectory()) files.push(...filesBelow(path))
    else files.push(path)
  }
  return files
}

function readableSource(root: string): string {
  return filesBelow(root)
    .filter(path => /\.(?:ts|tsx|js|mjs|md|ya?ml)$/.test(path))
    .map(path => readFileSync(path, 'utf8'))
    .join('\n')
}

function hasContributionEvidence(name: string, packageSource: string, presetSource: string): boolean {
  if (packageSource.includes(name)) return true
  const toolName = name.startsWith('tool:') ? name.slice('tool:'.length) : name
  if (!packageSource.includes('tool:${toolName}')) return false
  return packageSource.includes(`default('${toolName}')`)
    || packageSource.includes(`?? '${toolName}'`)
    || presetSource.includes(`toolName: ${toolName}`)
}

describe('DSH rc.7 attribution manifest', () => {
  it('is verified against the exact released source', () => {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: DSH_ROOT,
      encoding: 'utf8',
    }).trim()
    expect(head).toBe(RC7_SHA)

    const packages = new Map<string, { readonly dir: string; readonly version: string }>()
    for (const path of filesBelow(PACKAGES_ROOT).filter(file => file.endsWith('package.json'))) {
      const manifest = JSON.parse(readFileSync(path, 'utf8')) as { name?: unknown; version?: unknown }
      if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') continue
      packages.set(manifest.name, { dir: dirname(path), version: manifest.version })
    }

    const presetSource = readableSource(join(DSH_ROOT, 'apps/cli/config/agent-presets'))
    const missing: string[] = []
    for (const entry of DSH_RC7_MANIFEST) {
      const installed = packages.get(entry.plugin)
      if (installed === undefined) {
        missing.push(`${entry.plugin}: package`)
        continue
      }
      if (installed.version !== entry.version) {
        missing.push(`${entry.plugin}: version ${installed.version} != ${entry.version}`)
      }
      const packageSource = readableSource(installed.dir)
      for (const name of [...entry.sections ?? [], ...entry.contexts ?? [], ...entry.tools ?? []]) {
        if (!hasContributionEvidence(name, packageSource, presetSource)) {
          missing.push(`${entry.plugin}: ${name}`)
        }
      }
    }
    expect(missing).toEqual([])
  })
})
