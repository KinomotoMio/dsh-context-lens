// @vitest-environment jsdom

import type { ComponentProps } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type { ContextLensDocument } from '../../src/contracts.ts'
import { CONTEXT_LENS_WIRE_VERSION } from '../../src/contracts.ts'
import { ReaderView } from '../../src/client/ReaderView.tsx'
import { en, type LocaleKey } from '../../src/client/locales.ts'

afterEach(cleanup)

const PLUGIN = {
  id: '@example/plugin',
  label: 'Plugin One',
  category: 'plugin',
  source: 'claim',
} as const

const CONVERSATION = {
  id: 'conversation',
  label: 'Conversation',
  category: 'conversation',
  source: 'event',
} as const

function document(): ContextLensDocument {
  return {
    version: CONTEXT_LENS_WIRE_VERSION,
    sessionId: 'session-1',
    requestKey: '1:1',
    estimatedTokens: 90,
    blocks: [
      {
        id: 'system-section:policy',
        plane: 'system',
        kind: 'system-section',
        name: 'policy',
        owner: PLUGIN,
        tokens: 20,
        order: 0,
        format: 'text',
        content: 'System from Plugin One.',
      },
      {
        id: 'runtime-context:cwd',
        plane: 'system',
        kind: 'runtime-context',
        name: 'cwd',
        owner: PLUGIN,
        tokens: 8,
        order: 1,
        format: 'text',
        content: '/tmp/work',
      },
      {
        id: 'tool:search',
        plane: 'tools',
        kind: 'tool',
        name: 'search',
        owner: PLUGIN,
        tokens: 22,
        order: 2,
        format: 'json',
        content: '{"name":"search","description":"Search indexed files."}',
      },
      {
        id: 'conversation-message:user',
        plane: 'messages',
        kind: 'conversation-message',
        name: 'user',
        owner: CONVERSATION,
        tokens: 20,
        order: 3,
        format: 'text',
        content: 'Please list the files.',
      },
      {
        id: 'plugin-message:note',
        plane: 'messages',
        kind: 'plugin-message',
        name: 'note',
        owner: PLUGIN,
        tokens: 12,
        order: 4,
        format: 'text',
        content: 'Plugin note after the user turn.',
      },
      {
        id: 'framing:tail',
        plane: 'messages',
        kind: 'framing',
        name: 'tail',
        owner: PLUGIN,
        tokens: 8,
        order: 5,
        format: 'text',
        content: 'Framing closer.',
      },
    ],
  }
}

function props(rpc: ClientConnectionRpc): ComponentProps<typeof ReaderView> {
  return {
    active: true,
    colorFor: () => 'var(--dsw-static-blue-450)',
    formatTokens: value => String(value),
    requestKey: '1:1',
    rpc,
    sessionId: 'session-1',
    t: key => en[key as LocaleKey],
  }
}

function rows() {
  return screen.getAllByRole('row').filter(row => row.hasAttribute('data-kind'))
}

describe('ReaderView', () => {
  it('renders a contribution ledger with kind pills and owners, not cards', async () => {
    const call = vi.fn<ClientConnectionRpc['call']>(async () => ({ ok: true, value: document() }))
    render(<ReaderView {...props({ call })} />)

    expect(await screen.findByRole('table')).toBeTruthy()
    expect(screen.queryAllByRole('article')).toEqual([])
    expect(screen.getByText('System')).toBeTruthy()
    expect(screen.getByText('Tools')).toBeTruthy()
    expect(screen.getByText('Messages')).toBeTruthy()

    const ledger = rows()
    expect(ledger.map(row => row.getAttribute('data-kind'))).toEqual([
      'system-section',
      'runtime-context',
      'tool',
      'conversation-message',
      'plugin-message',
      'framing',
    ])
    expect(ledger.map(row => within(row).getAllByText(/SYSTEM|CONTEXT|TOOL|MESSAGE|FRAMING/)[0]?.textContent)).toEqual([
      'SYSTEM',
      'CONTEXT',
      'TOOL',
      'MESSAGE',
      'MESSAGE',
      'FRAMING',
    ])
    expect(within(ledger[0]!).getByText('Plugin One')).toBeTruthy()
    expect(within(ledger[3]!).getByText('Conversation')).toBeTruthy()
    expect(screen.getByText('System from Plugin One.')).toBeTruthy()
    expect(screen.queryByRole('complementary')).toBeNull()
  })

  it('selects a row to inspect instead of expanding inline', async () => {
    const call = vi.fn<ClientConnectionRpc['call']>(async () => ({ ok: true, value: document() }))
    render(<ReaderView {...props({ call })} />)
    expect(await screen.findByText('System from Plugin One.')).toBeTruthy()

    fireEvent.click(rows()[2]!)
    const inspector = screen.getByRole('complementary', { name: 'Inspect contribution' })
    expect(within(inspector).getByText('description')).toBeTruthy()
    expect(within(inspector).getByText('Plugin One · ≈22 tokens')).toBeTruthy()
    expect(rows()[2]!.getAttribute('data-selected')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: 'Raw' }))
    expect(within(inspector).getByText(/"name":"search"/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('complementary')).toBeNull()
  })

  it('dims records that are not the focused owner', async () => {
    const call = vi.fn<ClientConnectionRpc['call']>(async () => ({ ok: true, value: document() }))
    render(<ReaderView {...props({ call })} />)
    expect(await screen.findByText('Please list the files.')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Conversation' }))
    expect(rows().map(row => row.getAttribute('data-dimmed'))).toEqual([
      'true',
      'true',
      'true',
      null,
      'true',
      'true',
    ])
  })

  it('moves keyboard focus into the inspector and back to the row', async () => {
    const call = vi.fn<ClientConnectionRpc['call']>(async () => ({ ok: true, value: document() }))
    render(<ReaderView {...props({ call })} />)
    expect(await screen.findByText('System from Plugin One.')).toBeTruthy()

    const row = rows()[2]!
    fireEvent.keyDown(row, { key: 'Enter' })
    const inspector = screen.getByRole('complementary', { name: 'Inspect contribution' })
    expect(inspector === document.activeElement || inspector.contains(document.activeElement)).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('complementary')).toBeNull()
    expect(document.activeElement).toBe(row)
  })

  it('does not restore row focus when a new request loads', async () => {
    const call = vi.fn<ClientConnectionRpc['call']>(async (_channel, _method, params) => {
      const requestKey = (params as { requestKey: string }).requestKey
      return { ok: true, value: { ...document(), requestKey } }
    })
    const { rerender } = render(<ReaderView {...props({ call })} />)
    expect(await screen.findByText('System from Plugin One.')).toBeTruthy()

    fireEvent.click(rows()[0]!)
    expect(screen.getByRole('complementary', { name: 'Inspect contribution' })).toBeTruthy()

    rerender(<ReaderView {...props({ call })} requestKey="1:2" />)
    expect(await screen.findByRole('status')).toBeTruthy()
    expect(await screen.findByRole('table')).toBeTruthy()
    expect(screen.queryByRole('complementary')).toBeNull()
    expect(rows().some(row => row === globalThis.document.activeElement)).toBe(false)
  })
})
