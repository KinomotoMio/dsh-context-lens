import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  renderPrompt,
  type AssembleContext,
  type AssembledSection,
  type PromptAssembly,
} from '@deepseek-ai/dsh-system-prompt'

/** Rendered section boundary retained only for the two most recent live requests. */
export interface VerifiedSystemSection {
  readonly name: string
  readonly text: string
}

interface SystemAssemblySnapshot {
  readonly sections: readonly AssembledSection[]
  readonly variables: Readonly<Record<string, string | undefined>>
}

function requestKey(turn: number, step: number): string {
  return `${turn}:${step}`
}

function snapshotOf(assembly: PromptAssembly): SystemAssemblySnapshot {
  return structuredClone({ sections: assembly.sections, variables: assembly.variables })
}

function agentOf(context: AssembleContext): Agent | undefined {
  return (context as AssembleContext & { agent?: Agent }).agent
}

/** Process-local observer for structured system sections. It never mutates an assembly or Session. */
export class LiveAssemblyStore {
  private readonly pending = new Map<SessionId, SystemAssemblySnapshot>()
  private readonly bySession = new Map<SessionId, Map<string, SystemAssemblySnapshot>>()
  private readonly retention: number

  constructor(ctx: Context, retention: number) {
    this.retention = retention
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const assembled = await next()
      const agent = agentOf(context)
      if (agent !== undefined) this.pending.set(agent.session.id, snapshotOf(assembled))
      return assembled
    }, { global: true, prepend: true })

    ctx.on('session/event', (session, event) => {
      if (event.type !== 'step/start') return
      const pending = this.pending.get(session.id)
      if (pending === undefined) return
      this.pending.delete(session.id)
      const requests = this.bySession.get(session.id) ?? new Map<string, SystemAssemblySnapshot>()
      requests.set(requestKey(event.data.turn, event.data.step), pending)
      while (requests.size > this.retention) {
        const oldest = requests.keys().next().value as string | undefined
        if (oldest === undefined) break
        requests.delete(oldest)
      }
      this.bySession.set(session.id, requests)
    })

    ctx.on('session/disposed', (session) => {
      this.pending.delete(session.id)
      this.bySession.delete(session.id)
    })
  }

  /** Return section boundaries only when they render to the exact final system string. */
  verifiedSections(
    sessionId: SessionId,
    key: string,
    finalSystem: string,
  ): readonly VerifiedSystemSection[] | undefined {
    const snapshot = this.bySession.get(sessionId)?.get(key)
    if (snapshot === undefined) return undefined
    const assembly: PromptAssembly = {
      sections: [...snapshot.sections],
      contexts: [],
      tools: [],
      variables: { ...snapshot.variables },
    }
    if (renderPrompt(assembly) !== finalSystem) return undefined
    return snapshot.sections.flatMap((section) => {
      const text = renderPrompt({ ...assembly, sections: [section] })
      return text.length === 0 ? [] : [{ name: section.name, text }]
    })
  }
}
