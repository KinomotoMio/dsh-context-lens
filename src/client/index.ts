/** Browser entry registering the Lens conversation view. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  ClientConnectionRpc,
  ConnectionHandle,
} from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { LensView, type LensViewInjected } from './LensView.tsx'
import { en, type LocaleKey, zh } from './locales.ts'

export const NS = 'plugin-context-lens'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'plugin-context-lens': LocaleKey
  }
}

/** Client services required by the Lens view. */
export const inject = ['connection', 'locale', 'slots']

/** Register dictionaries and the dedicated Lens tab. */
export function apply(ctx: Context): void {
  const connection = ctx.get('connection') as unknown as ConnectionHandle
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'plugin-context-lens: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'plugin-context-lens',
    order: 20,
    locale: NS,
    label: () => t('view.label'),
    inject: (_sessionId: SessionId): LensViewInjected => ({ rpc: connection.rpc }),
  }, LensView))
}

export type { LensViewInjected } from './LensView.tsx'
export type { ClientConnectionRpc }
