import { symbols, type Context } from '@deepseek-ai/cordis'
import {
  add,
  pluginLabel,
  type ClaimKind,
  type ClaimTable,
  type ContextLensClaim,
} from './claims.ts'

interface CallerService {
  ctx: Context
}

interface Named {
  readonly name: string
}

function unwrap<T>(value: T): T {
  if (value === undefined || value === null || typeof value !== 'object') return value
  const original = (value as T & { readonly [symbols.original]?: T })[symbols.original]
  return original ?? value
}

function claimOf(kind: ClaimKind, name: string): ContextLensClaim {
  if (kind === 'tool') return { tools: [name] }
  if (kind === 'section') return { sections: [name] }
  return { contexts: [name] }
}

function wrapCallerMethod(
  service: object,
  method: string,
  kind: ClaimKind,
  table: ClaimTable,
): () => void {
  const target = service as CallerService & Record<string, (this: CallerService, item: Named) => unknown>
  const original = target[method]
  if (typeof original !== 'function') return () => undefined

  function wrapped(this: CallerService, item: Named): unknown {
    const result = original.call(this, item)
    const id = this.ctx.fiber.name
    if (id.length === 0) return result
    this.ctx.effect(
      () => add(table, { id, label: pluginLabel(id) }, claimOf(kind, item.name)),
      `plugin-context-lens: observe ${kind} ${item.name}`,
    )
    return result
  }

  target[method] = wrapped
  return () => {
    if (target[method] === wrapped) target[method] = original
  }
}

/**
 * Watch the existing DSH registration APIs and record the caller fiber.
 * Wraps the underlying service methods (unwrapped via `symbols.original`)
 * so `this.ctx` is the registering plugin, not Lens. Restores on dispose.
 */
export function observe(ctx: Context, table: ClaimTable): () => void {
  return ctx.effect(() => {
    const restores: Array<() => void> = []
    const tools = unwrap(ctx.get('tools') as object | undefined)
    if (tools !== undefined) {
      restores.push(wrapCallerMethod(tools, 'register', 'tool', table))
    }
    const systemPrompt = unwrap(ctx.get('systemPrompt') as object | undefined)
    if (systemPrompt !== undefined) {
      restores.push(wrapCallerMethod(systemPrompt, 'section', 'section', table))
      restores.push(wrapCallerMethod(systemPrompt, 'context', 'context', table))
    }
    return () => {
      for (const restore of restores.toReversed()) restore()
    }
  }, 'plugin-context-lens: observe registrations')
}
