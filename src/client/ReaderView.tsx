import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  CONTEXT_LENS_RPC_CHANNEL,
  CONTEXT_LENS_WIRE_VERSION,
  documentSchema,
  type ContextLensDocument,
  type ContextLensDocumentBlock,
  type ContextPlane,
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

function ReaderBlock({ block, color, dimmed, formatTokens, raw, t }: {
  readonly block: ContextLensDocumentBlock
  readonly color: string
  readonly dimmed: boolean
  readonly formatTokens: (tokens: number) => string
  readonly raw: boolean
  readonly t: Translate
}) {
  return (
    <article
      className={css.readerBlock}
      data-dimmed={dimmed ? 'true' : undefined}
      data-owner={block.owner.id}
      style={{ '--lens-owner-color': color } as CSSProperties}
    >
      <div className={css.readerMeta}>
        <span className={css.readerOwner}>{block.owner.label}</span>
        <strong>{block.name}</strong>
        <span>{block.kind} · ≈{formatTokens(block.tokens)}</span>
      </div>
      <div className={css.readerContent}>
        <BlockContent block={block} raw={raw} t={t} />
      </div>
    </article>
  )
}

/** Lazily load and render one request as an ordered, provider-neutral document. */
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
  const request = useRef<AbortController | null>(null)
  const loaded = document?.requestKey === requestKey

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

      <div className={css.readerDocument}>
        {PLANES.map((plane) => {
          const blocks = document.blocks.filter(block => block.plane === plane)
          if (blocks.length === 0) return null
          const tokens = blocks.reduce((sum, block) => sum + block.tokens, 0)
          return (
            <section className={css.readerPlane} key={plane} aria-labelledby={`lens-reader-${plane}`}>
              <header className={css.readerPlaneHeader}>
                <h2 id={`lens-reader-${plane}`}>{t(`reader.plane.${plane}`)}</h2>
                <span>{blocks.length} · ≈{formatTokens(tokens)} {t('tokens')}</span>
              </header>
              <div>
                {blocks.map(block => (
                  <ReaderBlock
                    block={block}
                    color={colorFor(block.owner.id)}
                    dimmed={focusedOwner !== null && focusedOwner !== block.owner.id}
                    formatTokens={formatTokens}
                    key={`${block.order}:${block.id}`}
                    raw={raw}
                    t={t}
                  />
                ))}
              </div>
            </section>
          )
        })}
      </div>
    </section>
  )
}
