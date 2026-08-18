import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, IconChevronDownOutline14, IconPlayOutline16, IconSettingsOutline16, IconSparkle16, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  CONTEXT_LENS_RPC_CHANNEL,
  CONTEXT_LENS_WIRE_VERSION,
  detailSchema,
  snapshotSchema,
  type ChangeKind,
  type ContextLensDetail,
  type ContextLensSnapshot,
  type ContributionKind,
  type LensContribution,
  type LensContributor,
} from '../contracts.ts'
import type { LocaleKey } from './locales.ts'
import { ReaderView } from './ReaderView.tsx'
import css from './lens.module.css'

export interface LensViewInjected {
  readonly rpc: ClientConnectionRpc
}

type LensProps = ConvViewProps
  & InjectFace<LensViewInjected>
  & PropsLocale<'plugin-context-lens'>

type Translate = (key: LocaleKey) => string

type InventoryGroup = 'contexts' | 'tools' | 'operations' | 'messages' | 'framing'

const KIND_GROUP = {
  'runtime-context': 'contexts',
  'system-section': 'contexts',
  'system-prompt': 'contexts',
  'tool': 'tools',
  'plugin-message': 'operations',
  'conversation-message': 'messages',
  'framing': 'framing',
} as const satisfies Record<ContributionKind, InventoryGroup>

const GROUP_ORDER = ['contexts', 'tools', 'operations', 'messages', 'framing'] as const satisfies readonly InventoryGroup[]

const GROUP_LABEL = {
  contexts: 'inventory.contexts',
  tools: 'inventory.tools',
  operations: 'inventory.operations',
  messages: 'inventory.messages',
  framing: 'inventory.framing',
} as const satisfies Record<InventoryGroup, LocaleKey>

function ToolWrenchIcon(): ReactNode {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      data-role-icon="wrench"
      aria-hidden="true"
    >
      <path d="M14 3.3a3.8 3.8 0 0 1-4.8 4.8l-5.1 5.1a1.6 1.6 0 1 1-2.3-2.3l5.1-5.1A3.8 3.8 0 0 1 11.7 1l-2.3 2.3 2.3 2.3L14 3.3Z" />
    </svg>
  )
}

function InformationIcon(): ReactNode {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      data-role-icon="information"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6.7" />
      <circle cx="8" cy="5.5" r=".85" fill="currentColor" stroke="none" />
      <path d="M8 7.75v3.4" strokeWidth="1.8" />
    </svg>
  )
}

const GROUP_ICON = {
  contexts: <InformationIcon />,
  tools: <ToolWrenchIcon />,
  operations: <IconPlayOutline16 size={13} />,
  messages: <IconSparkle16 size={13} />,
  framing: <IconSettingsOutline16 size={13} />,
} as const satisfies Record<InventoryGroup, ReactNode>

const CHANGE_MARK = {
  added: '+',
  removed: '−',
  changed: '~',
  moved: '↕',
} as const satisfies Record<Exclude<ChangeKind, 'unchanged'>, string>

function inventoryGroups(contributions: readonly LensContribution[]): { key: InventoryGroup; items: LensContribution[] }[] {
  const buckets = new Map<InventoryGroup, LensContribution[]>()
  for (const item of contributions) {
    const key = KIND_GROUP[item.kind]
    const list = buckets.get(key)
    if (list === undefined) buckets.set(key, [item])
    else list.push(item)
  }
  return GROUP_ORDER.flatMap((key) => {
    const items = buckets.get(key)
    return items === undefined || items.length === 0 ? [] : [{ key, items }]
  })
}

type LensMode = 'breakdown' | 'reader'

const MODES = ['breakdown', 'reader'] as const satisfies readonly LensMode[]

const COLORS = [
  'var(--dsw-static-neutral-bluish-400)',
  'var(--dsw-static-blue-450)',
  'var(--dsw-static-green-400)',
  'var(--dsw-static-amber-400)',
  'var(--dsw-static-deepseek-400)',
  'var(--dsw-static-neutral-500)',
] as const

function formatTokens(value: number): string {
  if (value < 1_000) return String(value)
  if (value < 1_000_000) return `${Math.round(value / 100) / 10}K`
  return `${Math.round(value / 100_000) / 10}M`
}

function formatPercent(value: number): string {
  return `${value < 10 ? value.toFixed(1) : Math.round(value)}%`
}

function colorFor(value: string): string {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash, 31) + value.charCodeAt(index)
  }
  return COLORS[Math.abs(hash) % COLORS.length]!
}

function delta(value: number): string {
  if (value === 0) return '—'
  return value > 0 ? `+${formatTokens(value)}` : `−${formatTokens(Math.abs(value))}`
}

async function readSnapshot(
  rpc: ClientConnectionRpc,
  sessionId: string,
  requestKey: string | undefined,
  signal: AbortSignal,
): Promise<ContextLensSnapshot> {
  const result = await rpc.call(CONTEXT_LENS_RPC_CHANNEL, 'snapshot', {
    version: CONTEXT_LENS_WIRE_VERSION,
    sessionId,
    ...(requestKey === undefined ? {} : { requestKey }),
  }, signal)
  if (!result.ok) throw new Error(result.error.message)
  return snapshotSchema.parse(result.value)
}

async function readDetail(
  rpc: ClientConnectionRpc,
  sessionId: string,
  ref: string,
  signal: AbortSignal,
): Promise<ContextLensDetail> {
  const result = await rpc.call(CONTEXT_LENS_RPC_CHANNEL, 'detail', {
    version: CONTEXT_LENS_WIRE_VERSION,
    sessionId,
    ref,
  }, signal)
  if (!result.ok) throw new Error(result.error.message)
  return detailSchema.parse(result.value)
}

function LoadingState({ t }: { readonly t: Translate }) {
  return (
    <div className={css.state} role="status">{t('loading')}</div>
  )
}

function CachePanel({ snapshot, t }: { readonly snapshot: ContextLensSnapshot; readonly t: Translate }) {
  const cache = snapshot.cache
  return (
    <section className={css.cachePanel} aria-labelledby="lens-cache-title">
      <div className={css.sectionEyebrow} id="lens-cache-title">{t('cache.title')}</div>
      {!cache.reported ? (
        <p className={css.muted}>{t('cache.unavailable')}</p>
      ) : (
        <>
          {cache.hitPercent === undefined ? (
            <p className={css.muted}>{t('cache.rateUnavailable')}</p>
          ) : (
            <div className={css.cacheLead}>
              <strong>{formatPercent(cache.hitPercent)}</strong>
              <span>{t('cache.hit')}</span>
            </div>
          )}
          <dl className={css.cacheGrid}>
            {cache.cacheReadTokens !== undefined && (
              <div><dt>{t('cache.read')}</dt><dd>{formatTokens(cache.cacheReadTokens)}</dd></div>
            )}
            {cache.cacheWriteTokens !== undefined && (
              <div><dt>{t('cache.write')}</dt><dd>{formatTokens(cache.cacheWriteTokens)}</dd></div>
            )}
            {cache.uncachedInputTokens !== undefined && (
              <div><dt>{t('cache.uncached')}</dt><dd>{formatTokens(cache.uncachedInputTokens)}</dd></div>
            )}
          </dl>
        </>
      )}
    </section>
  )
}

function ContributionDetail({
  refId,
  sessionId,
  rpc,
  t,
}: {
  readonly refId: string
  readonly sessionId: string
  readonly rpc: ClientConnectionRpc
  readonly t: Translate
}) {
  const [open, setOpen] = useState(false)
  const [detail, setDetail] = useState<ContextLensDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const request = useRef<AbortController | null>(null)

  useEffect(() => () => {
    const current = request.current
    request.current = null
    current?.abort()
  }, [])

  const toggle = useCallback(() => {
    if (open) {
      request.current?.abort()
      request.current = null
      setLoading(false)
      setOpen(false)
      return
    }
    setOpen(true)
    if (detail !== null || loading) return
    setLoading(true)
    setError(null)
    const abort = new AbortController()
    request.current = abort
    void readDetail(rpc, sessionId, refId, abort.signal)
      .then((value) => {
        if (!abort.signal.aborted) setDetail(value)
      })
      .catch((reason: unknown) => {
        if (abort.signal.aborted) return
        setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => {
        if (request.current !== abort) return
        request.current = null
        setLoading(false)
      })
  }, [detail, loading, open, refId, rpc, sessionId])

  return (
    <div className={css.detailWrap}>
      <Button
        className={css.revealButton}
        variant="ghost"
        size="sm"
        aria-expanded={open}
        icon={<IconChevronDownOutline14 className={`${css.chevron} ${open ? css.chevronOpen : ''}`} />}
        onClick={toggle}
      >
        {open ? t('details.hide') : t('details.load')}
      </Button>
      {open && loading && <div className={css.detailLoading} aria-live="polite">{t('loading')}</div>}
      {open && error !== null && <div className={css.inlineError} role="alert">{error}</div>}
      {open && detail !== null && (
        <pre className={css.detail} data-format={detail.format}>{detail.content}</pre>
      )}
    </div>
  )
}

function ContributorRow({
  contributor,
  sessionId,
  rpc,
  t,
}: {
  readonly contributor: LensContributor
  readonly sessionId: string
  readonly rpc: ClientConnectionRpc
  readonly t: Translate
}) {
  const [open, setOpen] = useState(false)
  const color = colorFor(contributor.owner.id)
  const groups = inventoryGroups(contributor.contributions)
  return (
    <article className={css.contributor}>
      <button
        type="button"
        className={css.contributorSummary}
        aria-expanded={open}
        onClick={() => { setOpen(value => !value) }}
      >
        <span className={css.contributorLead}>
          <span className={css.swatch} style={{ backgroundColor: color }} aria-hidden="true" />
          <span className={css.ownerText}>
            <strong>{contributor.owner.label}</strong>
            <small>{contributor.owner.id}</small>
          </span>
          <span className={css.ownerDelta} data-positive={contributor.deltaTokens > 0}>
            {delta(contributor.deltaTokens)}
          </span>
          <span className={css.ownerTokens}>≈{formatTokens(contributor.tokens)}</span>
          <span className={css.ownerPercent}>{formatPercent(contributor.percent)}</span>
          <IconChevronDownOutline14 className={`${css.chevron} ${open ? css.chevronOpen : ''}`} />
        </span>
        {groups.length > 0 && (
          <span className={css.ownerInventory}>
            {groups.map(group => (
              <span className={css.inventoryGroup} key={group.key}>
                <span className={css.inventoryLabel}>
                  <span aria-hidden="true">{GROUP_ICON[group.key]}</span>
                  {t(GROUP_LABEL[group.key])}
                </span>
                {group.items.map(item => (
                  <span
                    className={css.inventoryItem}
                    key={item.id}
                    title={item.change === 'unchanged'
                      ? item.name
                      : `${item.name} · ${t(`change.${item.change}` as LocaleKey)}`}
                  >
                    <span className={css.inventoryName}>{item.name}</span>
                    {item.change !== 'unchanged' && (
                      <>
                        <span className={css.inventoryMark} data-change={item.change} aria-hidden="true">
                          {CHANGE_MARK[item.change]}
                        </span>
                        <span className={css.srOnly}>{t(`change.${item.change}` as LocaleKey)}</span>
                      </>
                    )}
                  </span>
                ))}
              </span>
            ))}
          </span>
        )}
      </button>
      {open && (
        <div className={css.contributionList}>
          {contributor.contributions.map(item => (
            <div className={css.contributionItem} key={item.id}>
              <div className={css.contributionMeta}>
                <span className={css.kind}>{item.kind}</span>
                <strong>{item.name}</strong>
                <span className={css.itemChange} data-change={item.change}>{item.change}</span>
                <span className={css.itemTokens}>≈{formatTokens(item.tokens)}</span>
              </div>
              <ContributionDetail
                refId={item.detailRef}
                sessionId={sessionId}
                rpc={rpc}
                t={t}
              />
            </div>
          ))}
        </div>
      )}
    </article>
  )
}

function ChangeList({ snapshot, t }: { readonly snapshot: ContextLensSnapshot; readonly t: Translate }) {
  const changes = snapshot.changes.slice(0, 12)
  return (
    <section className={css.changes} aria-labelledby="lens-changes-title">
      <div className={css.sectionEyebrow} id="lens-changes-title">{t('changes')}</div>
      {changes.length === 0 ? (
        <p className={css.muted}>{t('changes.none')}</p>
      ) : (
        <ul>
          {changes.map(change => (
            <li key={`${change.change}:${change.id}`}>
              <span className={css.changeKind} data-change={change.change}>
                {t(`change.${change.change}` as LocaleKey)}
              </span>
              <strong>{change.name}</strong>
              <span>{change.owner.label}</span>
              <code>{delta(change.deltaTokens)}</code>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export function LensView({ useSession, sessionId, rpc, t }: LensProps) {
  const tabsId = useId()
  const session = useSession(value => value)
  const refreshKey = `${session.nodes.length}:${String(session.running)}:${String(session.partial !== null)}:${session.turnEnds.size}:${String(session.removed)}`
  const [selectedKey, setSelectedKey] = useState<string | undefined>()
  const [snapshot, setSnapshot] = useState<ContextLensSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [retry, setRetry] = useState(0)
  const [mode, setMode] = useState<LensMode>('breakdown')

  useEffect(() => {
    const abort = new AbortController()
    let ignore = false
    setLoading(true)
    setError(null)
    void readSnapshot(rpc, sessionId, selectedKey, abort.signal)
      .then((value) => {
        if (!ignore) setSnapshot(value)
      })
      .catch((reason: unknown) => {
        if (ignore || abort.signal.aborted) return
        setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => {
        if (!ignore) setLoading(false)
      })
    return () => {
      ignore = true
      abort.abort()
    }
  }, [refreshKey, retry, rpc, selectedKey, sessionId])

  const segments = useMemo(() => snapshot?.contributors.filter(item => item.tokens > 0) ?? [], [snapshot])

  if (loading && snapshot === null) return <LoadingState t={t} />
  if (error !== null && snapshot === null) {
    const empty = error.includes('No ordinary model request')
    return (
      <div className={css.state}>
        <strong>{empty ? t('empty') : error}</strong>
        {!empty && (
          <Button variant="outline" size="sm" onClick={() => { setRetry(value => value + 1) }}>
            {t('retry')}
          </Button>
        )}
      </div>
    )
  }
  if (snapshot === null) return null

  return (
    <div className={css.root} aria-busy={loading}>
      <header className={css.header}>
        <div>
          <h1>{t('title')}</h1>
          <p>{t('subtitle')}</p>
        </div>
        <label className={css.requestSelect}>
          <span>{t('request')}</span>
          <select
            value={selectedKey ?? snapshot.selected.key}
            onChange={(event) => { setSelectedKey(event.target.value) }}
          >
            {snapshot.requests.map((request, index) => (
              <option key={request.key} value={request.key}>
                {index === snapshot.requests.length - 1 ? `${t('latest')} · ` : ''}
                T{request.turn} / S{request.step} · {request.model ?? 'model'}
              </option>
            ))}
          </select>
        </label>
      </header>

      <div className={css.modeTabs} role="tablist" aria-label={t('mode.label')}>
        {MODES.map((value, index) => (
          <button
            className={css.modeTab}
            data-active={mode === value ? 'true' : undefined}
            id={`${tabsId}-${value}-tab`}
            key={value}
            type="button"
            role="tab"
            aria-controls={`${tabsId}-${value}-panel`}
            aria-selected={mode === value}
            tabIndex={mode === value ? 0 : -1}
            onClick={() => { setMode(value) }}
            onKeyDown={(event) => {
              const next = event.key === 'Home'
                ? MODES[0]
                : event.key === 'End'
                  ? MODES.at(-1)
                  : event.key === 'ArrowRight'
                    ? MODES[(index + 1) % MODES.length]
                    : event.key === 'ArrowLeft'
                      ? MODES[(index - 1 + MODES.length) % MODES.length]
                      : undefined
              if (next === undefined) return
              event.preventDefault()
              setMode(next)
              event.currentTarget.ownerDocument.getElementById(`${tabsId}-${next}-tab`)?.focus()
            }}
          >
            {t(`mode.${value}`)}
          </button>
        ))}
      </div>

      <div
        id={`${tabsId}-breakdown-panel`}
        role="tabpanel"
        aria-labelledby={`${tabsId}-breakdown-tab`}
        hidden={mode !== 'breakdown'}
      >
        <div className={css.overview}>
        <section className={css.contextPanel} aria-labelledby="lens-estimated-title">
          <div className={css.sectionEyebrow} id="lens-estimated-title">
            {snapshot.reportedTokens === undefined ? t('estimated') : t('reported')}
          </div>
          <div className={css.contextLead}>
            <strong>
              {snapshot.reportedTokens === undefined
                ? `≈${formatTokens(snapshot.estimatedTokens)}`
                : formatTokens(snapshot.reportedTokens)}
            </strong>
            <span>{t('tokens')}</span>
          </div>
          <div className={css.coverageLine}>
            <span>{formatPercent(snapshot.attributionPercent)} {t('coverage')}</span>
            <Pill>{snapshot.mode === 'live-verified' ? t('live') : t('reconstructed')}</Pill>
          </div>
          <div className={css.stack} aria-label={snapshot.reportedTokens === undefined
            ? `${snapshot.estimatedTokens} estimated tokens`
            : `${snapshot.reportedTokens} reported tokens`}>
            {segments.map(segment => (
              <span
                key={segment.owner.id}
                title={`${segment.owner.label}: ${formatPercent(segment.percent)}`}
                style={{
                  backgroundColor: colorFor(segment.owner.id),
                  flexGrow: Math.max(segment.percent, 0.35),
                }}
              />
            ))}
          </div>
        </section>
        <CachePanel snapshot={snapshot} t={t} />
        </div>

        {snapshot.warnings.length > 0 && (
          <details className={css.warnings}>
            <summary>{t('warning')} · {snapshot.warnings.length}</summary>
            <ul>{snapshot.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>
          </details>
        )}

        <section className={css.contributors} aria-labelledby="lens-contributors-title">
          <div className={css.listHeader}>
            <div className={css.sectionEyebrow} id="lens-contributors-title">{t('contributors')}</div>
            <span>{t('contributors.order')} · {snapshot.contributors.length}</span>
          </div>
          <div className={css.rows}>
            {snapshot.contributors.map(contributor => (
              <ContributorRow
                key={contributor.owner.id}
                contributor={contributor}
                sessionId={sessionId}
                rpc={rpc}
                t={t}
              />
            ))}
          </div>
        </section>

        <ChangeList snapshot={snapshot} t={t} />
        {error !== null && <div className={css.inlineError} role="alert">{error}</div>}
      </div>

      <div
        id={`${tabsId}-reader-panel`}
        role="tabpanel"
        aria-labelledby={`${tabsId}-reader-tab`}
        hidden={mode !== 'reader'}
      >
        <ReaderView
          active={mode === 'reader'}
          colorFor={colorFor}
          formatTokens={formatTokens}
          requestKey={snapshot.selected.key}
          rpc={rpc}
          sessionId={sessionId}
          t={t}
        />
      </div>
    </div>
  )
}
