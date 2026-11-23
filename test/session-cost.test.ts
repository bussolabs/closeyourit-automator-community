import {describe, expect, it} from 'vitest'
import {codexSessionUsage, opencodeCostUsd, sessionCostUsd, sumTokenUsage} from '../src/lib/session-cost'
import {DEFAULT_CODEX_MODEL} from '../src/lib/models'

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

describe('Codex standard cost estimates', () => {
  const turn = (input: number, cached: number, output: number) => JSON.stringify({
    type: 'turn.completed', usage: {input_tokens: input, cached_input_tokens: cached, output_tokens: output},
  })

  it('sums turns without charging cached input twice', () => {
    const stdout = [turn(1000, 400, 100), turn(2000, 500, 200)].join('\n')
    expect(codexSessionUsage(stdout, DEFAULT_CODEX_MODEL)).toEqual({
      tokens: {input_tokens: 3000, cached_input_tokens: 900, output_tokens: 300}, costUsd: 0.0369,
    })
    expect(sessionCostUsd(stdout, DEFAULT_CODEX_MODEL)).toBeCloseTo(0.0369)
  })

  it('applies long-context rates per turn rather than to aggregate usage', () => {
    expect(sessionCostUsd(turn(272001, 1000, 200), DEFAULT_CODEX_MODEL)).toBeCloseTo(5.43702)
    expect(sessionCostUsd([turn(200000, 0, 0), turn(200000, 0, 0)].join('\n'), DEFAULT_CODEX_MODEL)).toBe(4)
  })

  it('retains tokens for unknown models without inventing a cost', () => {
    for (const model of ['unknown', 'toString', undefined]) {
      expect(codexSessionUsage(turn(100, 0, 20), model)).toEqual({
        tokens: {input_tokens: 100, cached_input_tokens: 0, output_tokens: 20}, costUsd: null,
      })
    }
  })

  it('does not price missing or invalid consumption', () => {
    for (const stdout of ['plain text', 'null', '{}', '{"type":"turn.completed"}',
      turn(-1, 0, 0), turn(2, 3, 0), turn(1.5, 0, 0), turn(1e20, 0, 0),
      `${turn(10, 0, 1)}\n{"type":"turn.completed","usage":{}}`]) {
      expect(codexSessionUsage(stdout, DEFAULT_CODEX_MODEL)).toEqual({tokens: null, costUsd: null})
    }
    expect(sumTokenUsage({input_tokens: Number.MAX_SAFE_INTEGER, cached_input_tokens: 0, output_tokens: 0},
      {input_tokens: 1, cached_input_tokens: 0, output_tokens: 0})).toBeNull()
  })
})
