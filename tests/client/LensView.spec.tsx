// @vitest-environment jsdom

import type { ComponentProps } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type { ContextLensDocument, ContextLensSnapshot } from '../../src/contracts.ts'
import { CONTEXT_LENS_WIRE_VERSION } from '../../src/contracts.ts'
import { LensView } from '../../src/client/LensView.tsx'
import { en, type LocaleKey } from '../../src/client/locales.ts'

const OWNER = {
  id: '@example/plugin',
  label: 'Plugin One',
  category: 'plugin',
  source: 'claim',
} as const

afterEach(cleanup)

function snapshot(cacheReported = true): ContextLensSnapshot {
  return {
    version: CONTEXT_LENS_WIRE_VERSION,
    sessionId: 'session-1',
    logRevision: 8,
    mode: 'live-verified',
    requests: [{
      key: '1:1',
      turn: 1,
      step: 1,
      status: 'complete',
      startedAt: 1,
      model: 'deepseek-test',
      provider: 'mock',
    }],
    selected: {
      key: '1:1',
      turn: 1,
      step: 1,
      status: 'complete',
      startedAt: 1,
      model: 'deepseek-test',
      provider: 'mock',
    },
    estimatedTokens: 120,
    reportedTokens: 100,
    attributedTokens: 120,
    attributionPercent: 100,
    contributors: [{
      owner: OWNER,
      tokens: 120,
      percent: 100,
      deltaTokens: 12,
      contributions: [{
        id: 'system-section:policy',
        kind: 'system-section',
        name: 'policy',
        owner: OWNER,
        tokens: 120,
        percent: 100,
        deltaTokens: 12,
        change: 'changed',
        order: 0,
        detailRef: '1:1:0:abc',
      }],
    }],
    changes: [{
      id: 'system-section:policy',
      name: 'policy',
      kind: 'system-section',
      owner: OWNER,
      change: 'changed',
      deltaTokens: 12,
    }],
    cache: cacheReported
      ? {
          reported: true,
          uncachedInputTokens: 20,
          cacheReadTokens: 70,
          cacheWriteTokens: 10,
          billedInputTokens: 100,
          hitPercent: 70,
        }
      : { reported: false },
    warnings: [],
  }
}

function props(rpc: ClientConnectionRpc): ComponentProps<typeof LensView> {
  const session = {
    nodes: [],
    running: false,
    partial: null,
    turnEnds: new Map(),
    removed: false,
  }
  return {
    sessionId: 'session-1',
    useSession: selector => selector(session as never),
    rpc,
    t: key => en[key as LocaleKey],
  } as ComponentProps<typeof LensView>
}

function document(): ContextLensDocument {
  const pluginTwo = {
    id: '@example/plugin-two',
    label: 'Plugin Two',
    category: 'plugin',
    source: 'claim',
  } as const
  return {
    version: CONTEXT_LENS_WIRE_VERSION,
    sessionId: 'session-1',
    requestKey: '1:1',
    estimatedTokens: 120,
    blocks: [
      {
        id: 'system-section:policy',
        plane: 'system',
        kind: 'system-section',
        name: 'policy',
        owner: OWNER,
        tokens: 40,
        order: 0,
        format: 'text',
        content: 'System from Plugin One.',
      },
      {
        id: 'tool:search',
        plane: 'tools',
        kind: 'tool',
        name: 'search',
        owner: pluginTwo,
        tokens: 30,
        order: 1,
        format: 'json',
        content: '{"name":"search","description":"Search indexed files.","parameters":{"type":"object"}}',
      },
      {
        id: 'plugin-message:follow-up',
        plane: 'messages',
        kind: 'plugin-message',
        name: 'follow-up',
        owner: OWNER,
        tokens: 50,
        order: 2,
        format: 'text',
        content: 'Message from Plugin One.',
      },
    ],
  }
}

describe('LensView', () => {
  it('loads the ordered request document only after the reader is selected', async () => {
    const call = vi.fn<ClientConnectionRpc['call']>(async (_channel, endpoint) => {
      if (endpoint === 'snapshot') return { ok: true, value: snapshot() }
      if (endpoint === 'document') return { ok: true, value: document() }
      throw new Error(`unexpected endpoint ${endpoint}`)
    })
    render(<LensView {...props({ call })} />)

    expect(await screen.findByRole('tab', { name: 'Breakdown' })).toBeTruthy()
    expect(screen.queryByText('System from Plugin One.')).toBeNull()
    expect(call).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(screen.getByRole('tab', { name: 'Breakdown' }), { key: 'ArrowRight' })
    const panel = await screen.findByRole('tabpanel', { name: 'Reader' })
    expect(await within(panel).findByText('System from Plugin One.')).toBeTruthy()
    expect(within(panel).queryAllByRole('article')).toEqual([])
    const rows = within(panel).getAllByRole('row').filter(row => row.hasAttribute('data-kind'))
    expect(rows.map(row => row.getAttribute('data-owner'))).toEqual([
      '@example/plugin',
      '@example/plugin-two',
      '@example/plugin',
    ])
    expect(rows.map(row => row.getAttribute('data-kind'))).toEqual([
      'system-section',
      'tool',
      'plugin-message',
    ])
    expect(within(rows[0]!).getByText('SYSTEM')).toBeTruthy()
    expect(within(rows[0]!).getByText('Plugin One')).toBeTruthy()
    expect(within(rows[1]!).getByText('TOOL')).toBeTruthy()
    expect(within(rows[1]!).getByText('Plugin Two')).toBeTruthy()
    fireEvent.click(rows[1]!)
    const inspector = within(panel).getByRole('complementary', { name: 'Inspect contribution' })
    expect(within(inspector).getByText('description')).toBeTruthy()
    fireEvent.click(within(panel).getByRole('button', { name: 'Raw' }))
    expect(within(inspector).getByText(/"name":"search"/)).toBeTruthy()
    fireEvent.click(within(panel).getByRole('button', { name: 'Plugin Two' }))
    expect(rows.map(row => row.getAttribute('data-dimmed'))).toEqual(['true', null, 'true'])
    expect(call).toHaveBeenLastCalledWith(
      '/dsh-plugin-context-lens',
      'document',
      expect.objectContaining({ requestKey: '1:1' }),
      expect.any(AbortSignal),
    )
  })

  it('keeps contribution content behind two levels of disclosure', async () => {
    const call = vi.fn<ClientConnectionRpc['call']>(async (_channel, endpoint) => endpoint === 'snapshot'
      ? { ok: true, value: snapshot() }
      : {
          ok: true,
          value: {
            version: CONTEXT_LENS_WIRE_VERSION,
            ref: '1:1:0:abc',
            format: 'text',
            content: 'sensitive policy text',
          },
        })
    render(<LensView {...props({ call })} />)

    expect(await screen.findByText('Context Lens')).toBeTruthy()
    expect(screen.queryByText('Reveal content')).toBeNull()
    expect(call).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: /Plugin One/ }))
    expect(await screen.findByText('Reveal content')).toBeTruthy()
    expect(call).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Reveal content' }))
    expect(await screen.findByText('sensitive policy text')).toBeTruthy()
    expect(call).toHaveBeenCalledTimes(2)
  })

  it('renders provider cache figures and an explicit missing-data state', async () => {
    const reported = vi.fn<ClientConnectionRpc['call']>(async () => ({ ok: true, value: snapshot() }))
    const view = render(<LensView {...props({ call: reported })} />)
    expect(await screen.findByText('70%')).toBeTruthy()
    expect(screen.getByText('cache read / prompt tokens')).toBeTruthy()
    const reportedPanel = screen.getByRole('region', { name: 'Reported context' })
    expect(within(reportedPanel).getByText('100')).toBeTruthy()
    expect(within(reportedPanel).queryByText(/≈/)).toBeNull()
    expect(screen.getByLabelText('100 reported tokens')).toBeTruthy()

    view.unmount()
    const absent = snapshot(false)
    delete (absent as { reportedTokens?: number }).reportedTokens
    const absentCall = vi.fn<ClientConnectionRpc['call']>(async () => ({
      ok: true,
      value: absent,
    }))
    render(<LensView {...props({ call: absentCall })} />)
    expect(await screen.findByText('Provider did not report cache usage')).toBeTruthy()
    const estimatedPanel = screen.getByRole('region', { name: 'Estimated context' })
    expect(within(estimatedPanel).getByText('≈120')).toBeTruthy()
  })

  it('hides cache write and does not invent a hit rate', async () => {
    const value = snapshot()
    value.cache = {
      reported: true,
      uncachedInputTokens: 123,
      cacheReadTokens: 896,
      billedInputTokens: 1019,
      hitPercent: 896 / 1019 * 100,
    }
    value.reportedTokens = 1019
    const withRead = vi.fn<ClientConnectionRpc['call']>(async () => ({ ok: true, value }))
    const view = render(<LensView {...props({ call: withRead })} />)
    expect(await screen.findByText('cache read / prompt tokens')).toBeTruthy()
    expect(screen.queryByText('cache write')).toBeNull()

    view.unmount()
    const writeOnly = snapshot()
    writeOnly.cache = {
      reported: true,
      uncachedInputTokens: 40,
      cacheWriteTokens: 12,
      billedInputTokens: 40,
    }
    writeOnly.reportedTokens = 40
    const writeCall = vi.fn<ClientConnectionRpc['call']>(async () => ({ ok: true, value: writeOnly }))
    render(<LensView {...props({ call: writeCall })} />)
    expect(await screen.findByText('Provider did not report a cache read share')).toBeTruthy()
    expect(screen.getByText('cache write')).toBeTruthy()
    expect(screen.queryByText('70%')).toBeNull()
  })

  it('switches request keys through the snapshot RPC', async () => {
    const value = snapshot()
    value.requests.push({
      key: '1:2',
      turn: 1,
      step: 2,
      status: 'complete',
      startedAt: 2,
      model: 'deepseek-test',
      provider: 'mock',
    })
    value.selected = value.requests[1]!
    const call = vi.fn<ClientConnectionRpc['call']>(async () => ({ ok: true, value }))
    render(<LensView {...props({ call })} />)
    const selector = await screen.findByLabelText('Request')

    fireEvent.change(selector, { target: { value: '1:1' } })
    await waitFor(() => {
      expect(call).toHaveBeenLastCalledWith(
        '/dsh-plugin-context-lens',
        'snapshot',
        expect.objectContaining({ requestKey: '1:1' }),
        expect.any(AbortSignal),
      )
    })
  })

  it('keeps conflicted, unattributed, and version-drift states explicit', async () => {
    const value = snapshot(false)
    value.warnings = ['@deepseek-ai/dsh-tools 0.1.0-rc.8 does not match attribution manifest 0.1.0-rc.7']
    value.contributors[0]!.owner = {
      id: 'conflicted:@example/a|@example/b',
      label: 'Conflicted: A, B',
      category: 'conflicted',
      source: 'conflict',
    }
    value.contributors.push({
      owner: {
        id: 'unattributed',
        label: 'Unattributed',
        category: 'unattributed',
        source: 'none',
      },
      tokens: 0,
      percent: 0,
      deltaTokens: 0,
      contributions: [],
    })
    const call = vi.fn<ClientConnectionRpc['call']>(async () => ({ ok: true, value }))
    render(<LensView {...props({ call })} />)

    expect(await screen.findByText('Conflicted: A, B')).toBeTruthy()
    expect(screen.getByText('Unattributed')).toBeTruthy()
    expect(screen.getByText('Accuracy note · 1')).toBeTruthy()
  })
})
