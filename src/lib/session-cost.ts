import {claudeSessionCostUsd} from './claude'

/**
 * CYAU-155 — what an agent session cost, read from its own output: Claude reports `total_cost_usd`, OpenCode
 * (CYAU-228) prices each step in its `step_finish` events. Codex work is estimated from turn usage only when
 * its model is explicitly supplied; reviews remain unpriced. Null means no usable measurement.
 */
export function sessionCostUsd(stdout: string, codexModel?: string): number | null {
  return claudeSessionCostUsd(stdout) ?? opencodeCostUsd(stdout) ?? codexSessionUsage(stdout, codexModel).costUsd
}

export interface TokenUsage {
  /** Total input, including the cached subset. */
  input_tokens: number
  cached_input_tokens: number
  output_tokens: number
}

// Standard USD per million tokens, checked 2026-11-23:
// https://developers.openai.com/api/docs/models/gpt-6-astra
// An estimate only: subscription billing, cache writes and service-tier discounts/surcharges are not exposed.
const CODEX_PRICES: Readonly<Record<string, {input: number; cached: number; output: number}>> = {
  'gpt-6-astra': {input: 10, cached: 1, output: 50},
}

export function sumTokenUsage(a: TokenUsage | null, b: TokenUsage | null): TokenUsage | null {
  if (!a) return b
  if (!b) return a
  const total = {
    input_tokens: a.input_tokens + b.input_tokens,
    cached_input_tokens: a.cached_input_tokens + b.cached_input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
  }
  return Object.values(total).every(Number.isSafeInteger) ? total : null
}

export function codexSessionUsage(stdout: string, model?: string): {tokens: TokenUsage | null; costUsd: number | null} {
  let tokens: TokenUsage | null = null
  let costUsd: number | null = null
  const price = model && Object.hasOwn(CODEX_PRICES, model) ? CODEX_PRICES[model] : undefined
  for (const line of stdout.split('\n')) {
    let event: {type?: unknown; usage?: Partial<TokenUsage>} | null
    try { event = JSON.parse(line) as typeof event } catch { continue }
    if (event?.type !== 'turn.completed') continue
    const usage = event.usage
    if (!usage || ![usage.input_tokens, usage.cached_input_tokens, usage.output_tokens]
      .every((value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
      || usage.cached_input_tokens! > usage.input_tokens!) return {tokens: null, costUsd: null}
    const turn = usage as TokenUsage
    tokens = sumTokenUsage(tokens, turn)
    if (!tokens) return {tokens: null, costUsd: null}
    if (price) {
      // Long-context pricing applies per turn, never to the aggregate across turns.
      const long = turn.input_tokens > 272_000
      costUsd = (costUsd ?? 0) + ((turn.input_tokens - turn.cached_input_tokens) * price.input * (long ? 2 : 1)
        + turn.cached_input_tokens * price.cached * (long ? 2 : 1)
        + turn.output_tokens * price.output * (long ? 1.5 : 1)) / 1_000_000
    }
  }
  return {tokens, costUsd}
}

export function opencodeCostUsd(stdout: string): number | null {
  let total: number | null = null
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    let event: {type?: unknown; part?: {cost?: unknown}}
    try {
      event = JSON.parse(line) as typeof event
    } catch {
      continue
    }

    const cost = event?.part?.cost
    if (event?.type === 'step_finish' && typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) {
      total = (total ?? 0) + cost
    }
  }

  return total
}
