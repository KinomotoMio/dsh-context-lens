import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  CONTEXT_LENS_RPC_CHANNEL,
  CONTEXT_LENS_WIRE_VERSION,
  documentSchema,
  type ContextLensDocument,
  type ContextLensDocumentBlock,
  type ContextPlane,
  type ContributionKind,
} from '../contracts.ts'
import type { LocaleKey } from './locales.ts'
import css from './lens.module.css'

type Translate = (key: LocaleKey) => string

interface ReaderViewProps {
  readonly active: boolean
  readonly colorFor: (ownerId: string) => string
  readonly formatTokens: (tokens: number) => string
  readonly requestKey: string
  readonly rpc: ClientConnectionRpc
  readonly sessionId: string
  readonly t: Translate
}

const PLANES = ['system', 'tools', 'messages'] as const satisfies readonly ContextPlane[]

type KindTone = 'user' | 'system' | 'context' | 'assistant' | 'tool'

const KIND_TONE = {
  'system-section': 'system',
  'system-prompt': 'system',
  'tool': 'tool',
  'runtime-context': 'context',
  'plugin-message': 'assistant',
  'conversation-message': 'user',
  'framing': 'system',
} as const satisfies Record<ContributionKind, KindTone>

const TONE_CLASS: Record<KindTone, string> = {
  user: css.readerKindUser ?? '',
  system: css.readerKindSystem ?? '',
  context: css.readerKindContext ?? '',
  assistant: css.readerKindAssistant ?? '',
  tool: css.readerKindTool ?? '',
}

function kindKey(kind: ContributionKind): LocaleKey {
  return `reader.kind.${kind}`
}

function blockKey(block: ContextLensDocumentBlock): string {
  return `${block.order}:${block.id}`
}

function previewText(content: string, fallback: string): string {
  const text = content.replace(/\s+/g, ' ').trim()
  return text.length === 0 ? fallback : text
}

async function readDocument(
  rpc: ClientConnectionRpc,
  sessionId: string,
  requestKey: string,
  signal: AbortSignal,
): Promise<ContextLensDocument> {
  const result = await rpc.call(CONTEXT_LENS_RPC_CHANNEL, 'document', {
    version: CONTEXT_LENS_WIRE_VERSION,
    sessionId,
    requestKey,
  }, signal)
  if (!result.ok) throw new Error(result.error.message)
  return documentSchema.parse(result.value)
}

function parsedObject(content: string): object | unknown[] | undefined {
  try {
    const value: unknown = JSON.parse(content)
    return typeof value === 'object' && value !== null ? value : undefined
  } catch {
    return undefined
  }
}

function jsonValue(value: unknown): ReactNode {
  if (Array.isArray(value)) {
    return (
      <ol className={css.readerJsonBranch}>
        {value.map((item, index) => <li key={index}>{jsonValue(item)}</li>)}
      </ol>
    )
  }
  if (typeof value === 'object' && value !== null) {
    return (
      <dl className={css.readerJsonBranch}>
        {Object.entries(value).map(([key, item]) => (
          <div key={key}>
            <dt>{key}</dt>
            <dd>{jsonValue(item)}</dd>
          </div>
        ))}
      </dl>
    )
  }
  if (typeof value === 'string') return <span className={css.readerJsonString}>{value}</span>
  if (value === null) return <span className={css.readerJsonLiteral}>null</span>
  return <span className={css.readerJsonLiteral}>{String(value)}</span>
}

function BlockContent({ block, raw, t }: {
  readonly block: ContextLensDocumentBlock
  readonly raw: boolean
  readonly t: Translate
}) {
  const parsed = block.format === 'json' && !raw ? parsedObject(block.content) : undefined
  if (parsed !== undefined) {
    return <div className={css.readerJsonTree} aria-label={`${block.name} ${t('reader.json')}`}>{jsonValue(parsed)}</div>
  }
  return <pre className={raw || block.format === 'json' ? css.readerRaw : css.readerText}>{block.content}</pre>
}

function ReaderRow({
  block,
  color,
  dimmed,
  selected,
  t,
  onSelect,
  rowRef,
}: {
  readonly block: ContextLensDocumentBlock
  readonly color: string
  readonly dimmed: boolean
  readonly selected: boolean
  readonly t: Translate
  readonly onSelect: () => void
  readonly rowRef: (element: HTMLTableRowElement | null) => void
}) {
  const tone = KIND_TONE[block.kind]
  const pill = t(kindKey(block.kind))
  const onKeyDown = (event: KeyboardEvent<HTMLTableRowElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    onSelect()
  }
  return (
    <tr
      ref={rowRef}
      data-kind={block.kind}
      data-owner={block.owner.id}
      data-dimmed={dimmed ? 'true' : undefined}
      data-selected={selected ? 'true' : undefined}
      style={{ '--lens-owner-color': color } as CSSProperties}
      tabIndex={0}
      aria-selected={selected}
      aria-label={`${pill} ${block.name} ${block.owner.label}`}
      onClick={onSelect}
      onKeyDown={onKeyDown}
    >
      <td className={css.readerEvent}>
        {selected && <span className={css.readerSelectionRail} aria-hidden="true" />}
        <span className={css.readerKindSlot}>
          <span className={`${css.readerKindTag} ${TONE_CLASS[tone]}`}>{pill}</span>
        </span>
      </td>
      <td className={css.readerRowOwner}>{block.owner.label}</td>
      <td>
        <span className={css.readerPreview}>{previewText(block.content, block.name)}</span>
      </td>
    </tr>
  )
}

/** Lazily load and render one request as an ordered, provider-neutral ledger. */
export function ReaderView({
  active,
  colorFor,
  formatTokens,
  requestKey,
  rpc,
  sessionId,
  t,
}: ReaderViewProps) {
  const [document, setDocument] = useState<ContextLensDocument | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [retry, setRetry] = useState(0)
  const [raw, setRaw] = useState(false)
  const [focusedOwner, setFocusedOwner] = useState<string | null>(null)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const request = useRef<AbortController | null>(null)
  const detailsRef = useRef<HTMLElement | null>(null)
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>())
  const lastSelectedKey = useRef<string | null>(null)
  const restoreRowFocus = useRef(false)
  const loaded = document?.requestKey === requestKey

  const closeInspector = () => {
    restoreRowFocus.current = true
    setSelectedKey(null)
  }

  useEffect(() => {
    if (!active || loaded) return
    request.current?.abort()
    const abort = new AbortController()
    request.current = abort
    setDocument(null)
    setLoading(true)
    setError(null)
    void readDocument(rpc, sessionId, requestKey, abort.signal)
      .then((value) => {
        if (abort.signal.aborted) return
        setDocument(value)
        setFocusedOwner(null)
        restoreRowFocus.current = false
        lastSelectedKey.current = null
        setSelectedKey(null)
      })
      .catch((reason: unknown) => {
        if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => {
        if (request.current !== abort) return
        request.current = null
        setLoading(false)
      })
    return () => {
      abort.abort()
      if (request.current === abort) request.current = null
    }
  }, [active, loaded, requestKey, retry, rpc, sessionId])

  useEffect(() => () => { request.current?.abort() }, [])

  const owners = useMemo(() => {
    const seen = new Set<string>()
    return (document?.blocks ?? []).flatMap((block) => {
      if (seen.has(block.owner.id)) return []
      seen.add(block.owner.id)
      return [block.owner]
    })
  }, [document])

  const selected = useMemo(() => {
    if (document === null || selectedKey === null) return null
    return document.blocks.find(block => blockKey(block) === selectedKey) ?? null
  }, [document, selectedKey])

  useEffect(() => {
    if (selectedKey !== null) {
      lastSelectedKey.current = selectedKey
      detailsRef.current?.focus()
      return
    }
    if (!restoreRowFocus.current) {
      lastSelectedKey.current = null
      return
    }
    restoreRowFocus.current = false
    const previous = lastSelectedKey.current
    if (previous !== null) rowRefs.current.get(previous)?.focus()
    lastSelectedKey.current = null
  }, [selectedKey])

  if (document === null && loading) return <div className={css.readerState} role="status">{t('reader.loading')}</div>
  if (document === null && error !== null) {
    return (
      <div className={css.readerState} role="alert">
        <strong>{error}</strong>
        <Button variant="outline" size="sm" onClick={() => { setRetry(value => value + 1) }}>
          {t('retry')}
        </Button>
      </div>
    )
  }
  if (document === null) return null

  return (
    <section className={css.reader} aria-label={t('reader.title')} aria-busy={loading}>
      <div className={css.readerToolbar}>
        <div className={css.readerNotice}>
          <strong>{t('reader.title')}</strong>
          <span>{t('reader.note')}</span>
        </div>
        <div className={css.readerFormat} aria-label={t('reader.format')}>
          <button type="button" data-active={!raw} onClick={() => { setRaw(false) }}>{t('reader.readable')}</button>
          <button type="button" data-active={raw} onClick={() => { setRaw(true) }}>{t('reader.raw')}</button>
        </div>
      </div>

      <div className={css.readerOwners} aria-label={t('reader.focus')}>
        <button
          type="button"
          data-active={focusedOwner === null}
          onClick={() => { setFocusedOwner(null) }}
        >
          {t('reader.all')}
        </button>
        {owners.map(owner => (
          <button
            type="button"
            key={owner.id}
            data-active={focusedOwner === owner.id}
            onClick={() => { setFocusedOwner(current => current === owner.id ? null : owner.id) }}
          >
            <span style={{ backgroundColor: colorFor(owner.id) }} aria-hidden="true" />
            {owner.label}
          </button>
        ))}
      </div>

      <div className={css.readerLedger}>
        <div className={css.readerTablePane}>
          <table className={css.readerTable}>
            <caption className={css.readerCaption}>{t('reader.title')}</caption>
            <colgroup>
              <col className={css.readerEventColumn} />
              <col className={css.readerOwnerColumn} />
              <col />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">{t('reader.event')}</th>
                <th scope="col">{t('reader.owner')}</th>
                <th scope="col">{t('reader.content')}</th>
              </tr>
            </thead>
            <tbody>
              {PLANES.flatMap((plane) => {
                const blocks = document.blocks.filter(block => block.plane === plane)
                if (blocks.length === 0) return []
                const tokens = blocks.reduce((sum, block) => sum + block.tokens, 0)
                return [
                  <tr className={css.readerPlaneRow} data-plane={plane} key={`plane:${plane}`}>
                    <td colSpan={3}>
                      <strong id={`lens-reader-${plane}`}>{t(`reader.plane.${plane}`)}</strong>
                      <span>{blocks.length} · ≈{formatTokens(tokens)} {t('tokens')}</span>
                    </td>
                  </tr>,
                  ...blocks.map(block => (
                    <ReaderRow
                      block={block}
                      color={colorFor(block.owner.id)}
                      dimmed={focusedOwner !== null && focusedOwner !== block.owner.id}
                      key={blockKey(block)}
                      selected={selectedKey === blockKey(block)}
                      t={t}
                      onSelect={() => { setSelectedKey(blockKey(block)) }}
                      rowRef={(element) => {
                        const key = blockKey(block)
                        if (element === null) rowRefs.current.delete(key)
                        else rowRefs.current.set(key, element)
                      }}
                    />
                  )),
                ]
              })}
            </tbody>
          </table>
        </div>

        {selected !== null && (
          <aside
            ref={detailsRef}
            className={css.readerDetails}
            aria-label={t('reader.inspect')}
            tabIndex={-1}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return
              event.preventDefault()
              closeInspector()
            }}
          >
            <div className={css.readerDetailsHeader}>
              <div className={css.readerDetailsTitle}>
                <span className={`${css.readerKindTag} ${TONE_CLASS[KIND_TONE[selected.kind]]}`}>
                  {t(kindKey(selected.kind))}
                </span>
                <div className={css.readerDetailsCopy}>
                  <strong className={css.readerDetailsName}>{selected.name}</strong>
                  <span className={css.readerDetailsMeta} style={{ '--lens-owner-color': colorFor(selected.owner.id) } as CSSProperties}>
                    {selected.owner.label} · ≈{formatTokens(selected.tokens)} {t('tokens')}
                  </span>
                </div>
              </div>
              <button
                type="button"
                className={css.readerClose}
                aria-label={t('reader.close')}
                onClick={closeInspector}
              >
                ×
              </button>
            </div>
            <div className={css.readerDetailsBody}>
              <BlockContent block={selected} raw={raw} t={t} />
            </div>
          </aside>
        )}
      </div>
    </section>
  )
}
