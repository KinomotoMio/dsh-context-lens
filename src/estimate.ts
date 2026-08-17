import type { ContentBlock, Message, ToolSchema } from '@deepseek-ai/dsh-llm'

const CHARS_PER_TOKEN = 4
const BLOCK_OVERHEAD = 4
const ROLE_OVERHEAD = 4

/** Estimate one content list with the same fixed-density rules as dsh-token-meter. */
export function estimateContent(blocks: readonly ContentBlock[]): number {
  let tokens = 0
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
      case 'reasoning':
        tokens += Math.ceil(block.text.length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
        break
      case 'tool-call':
        tokens += Math.ceil(block.name.length / CHARS_PER_TOKEN)
          + Math.ceil(block.arguments.length / CHARS_PER_TOKEN)
          + BLOCK_OVERHEAD
        break
      case 'tool-result':
        tokens += estimateContent(block.content) + BLOCK_OVERHEAD
        break
      default:
        tokens += BLOCK_OVERHEAD + Math.ceil(JSON.stringify(block).length / CHARS_PER_TOKEN)
    }
  }
  return tokens
}

/** Estimate one model-visible message. */
export function estimateMessage(message: Message): number {
  return estimateContent(message.content) + ROLE_OVERHEAD
}

/** Estimate the rendered system field. */
export function estimateSystem(system: string): number {
  return system.length === 0 ? 0 : Math.ceil(system.length / CHARS_PER_TOKEN) + ROLE_OVERHEAD
}

/** Estimate the complete tool array. */
export function estimateTools(tools: readonly ToolSchema[]): number {
  return tools.length === 0
    ? 0
    : Math.ceil(JSON.stringify(tools).length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
}

export interface WeightedAllocation {
  readonly id: string
  readonly weight: number
}

/**
 * Split one integer token total without losing rounding residue.
 * Largest remainders make the result deterministic and conserve the total.
 */
export function allocateTokens(
  total: number,
  entries: readonly WeightedAllocation[],
): ReadonlyMap<string, number> {
  if (entries.length === 0) return new Map()
  const weights = entries.map(entry => Math.max(0, entry.weight))
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0)
  if (weightTotal === 0) {
    const result = new Map(entries.map(entry => [entry.id, 0]))
    result.set(entries[0]!.id, total)
    return result
  }

  const rows = entries.map((entry, index) => {
    const exact = total * weights[index]! / weightTotal
    const floor = Math.floor(exact)
    return { entry, index, floor, remainder: exact - floor }
  })
  let remaining = total - rows.reduce((sum, row) => sum + row.floor, 0)
  rows.sort((left, right) => right.remainder - left.remainder || left.index - right.index)
  for (const row of rows) {
    if (remaining === 0) break
    row.floor += 1
    remaining -= 1
  }
  rows.sort((left, right) => left.index - right.index)
  return new Map(rows.map(row => [row.entry.id, row.floor]))
}

/** Stable non-cryptographic digest for change detection and opaque local refs. */
export function digest(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}
