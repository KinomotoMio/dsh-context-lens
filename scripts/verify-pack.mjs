import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const artifacts = resolve('.artifacts')
const archives = readdirSync(artifacts).filter(name => name.endsWith('.tgz')).sort()
const archive = archives.at(-1)
if (archive === undefined) throw new Error('pack check: no tarball found in .artifacts')

const temporary = mkdtempSync(join(tmpdir(), 'dsh-context-lens-pack-'))
try {
  execFileSync('tar', ['-xzf', join(artifacts, archive), '-C', temporary])
  const root = join(temporary, 'package')
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  if (manifest.name !== '@kinomotomio/dsh-context-lens' || manifest.version !== '0.1.0') {
    throw new Error('pack check: package identity drifted')
  }
  if (manifest.license !== 'MIT') throw new Error('pack check: package license drifted')
  for (const field of ['dependencies', 'peerDependencies']) {
    for (const value of Object.values(manifest[field] ?? {})) {
      if (typeof value === 'string' && /(?:^|:)\.\.?\//.test(value)) {
        throw new Error(`pack check: ${field} contains a local path`)
      }
    }
  }
  for (const file of [
    'LICENSE',
    'README.md',
    'README.zh-CN.md',
    'cordis.patch.yml',
    'lib/index.js',
    'lib/contracts.js',
    'lib/client.js',
    'lib/types/index.d.ts',
    'lib/types/contracts.d.ts',
  ]) {
    readFileSync(join(root, file))
  }
  const client = readFileSync(join(root, 'lib/client.js'), 'utf8')
  if (!client.includes('window.__ModuleLoader__.load')
    || !client.includes('@kinomotomio/dsh-context-lens')) {
    throw new Error('pack check: client bundle does not register its module id')
  }
  const consumer = join(temporary, 'consumer')
  const modules = join(consumer, 'node_modules')
  const scope = join(modules, '@kinomotomio')
  mkdirSync(scope, { recursive: true })
  symlinkSync(root, join(scope, 'dsh-context-lens'), 'dir')
  symlinkSync(resolve('node_modules'), join(root, 'node_modules'), 'dir')
  execFileSync(process.execPath, [
    '--input-type=module',
    '--eval',
    "const host = await import('@kinomotomio/dsh-context-lens'); if ('default' in host || !host.inject.includes('connection')) throw new Error('invalid Host plugin module'); await import('@kinomotomio/dsh-context-lens/contracts')",
  ], { cwd: consumer })
  process.stdout.write(`verified ${archive}\n`)
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
