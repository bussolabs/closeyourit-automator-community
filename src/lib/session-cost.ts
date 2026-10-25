import {claudeSessionCostUsd} from './claude'

/**
 * CYAU-155 — what an agent session cost, read from its own output: Claude reports `total_cost_usd`, OpenCode
 * (CYAU-228) prices each step in its `step_finish` events. Null when the output reports no cost, so nothing
 * is added rather than a made-up amount.
 */
export function sessionCostUsd(stdout: string): number | null {
  return claudeSessionCostUsd(stdout) ?? opencodeCostUsd(stdout)
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

    const cost = event.part?.cost
    if (event.type === 'step_finish' && typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) {
      total = (total ?? 0) + cost
    }
  }

  return total
}
