import {describe, expect, it} from 'vitest'
import {opencodeCostUsd, sessionCostUsd} from '../src/lib/session-cost'

const opencodeOutput = [
  JSON.stringify({type: 'step_start', part: {type: 'step-start'}}),
  JSON.stringify({type: 'text', part: {type: 'text', text: '{}'}}),
  JSON.stringify({type: 'step_finish', part: {type: 'step-finish', cost: 0.0125}}),
  JSON.stringify({type: 'step_finish', part: {type: 'step-finish', cost: 0.0025}}),
].join('\n')

describe('sessionCostUsd', () => {
  it('reads the cost a Claude session reports', () => {
    expect(sessionCostUsd(JSON.stringify({is_error: false, total_cost_usd: 0.42}))).toBe(0.42)
  })

  it('adds up the steps an OpenCode session priced', () => {
    expect(sessionCostUsd(opencodeOutput)).toBeCloseTo(0.015)
  })

  it('adds nothing when the output reports no cost', () => {
    expect(sessionCostUsd('not json')).toBeNull()
    expect(opencodeCostUsd(JSON.stringify({type: 'step_finish', part: {cost: 'free'}}))).toBeNull()
    expect(opencodeCostUsd(JSON.stringify({type: 'step_finish', part: {cost: -1}}))).toBeNull()
  })
})
