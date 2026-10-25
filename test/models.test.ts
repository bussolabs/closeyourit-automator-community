import {describe, expect, it} from 'vitest'
import {DEFAULT_CLAUDE_MODEL, modelFrom, workEngineFrom} from '../src/lib/models'

// CYRA-921 — the pinned models are defaults a machine can change.
describe('model defaults', () => {
  it('keeps the default when the machine sets nothing', () => {
    expect(modelFrom(undefined, DEFAULT_CLAUDE_MODEL)).toBe(DEFAULT_CLAUDE_MODEL)
    expect(modelFrom('   ', DEFAULT_CLAUDE_MODEL)).toBe(DEFAULT_CLAUDE_MODEL)
  })

  it('uses the model the machine picked', () => {
    expect(modelFrom(' claude-sonnet-5-5 ', DEFAULT_CLAUDE_MODEL)).toBe('claude-sonnet-5-5')
  })
})

// CYRA-921 — the engine the machine installs for the work: Claude unless it says Codex.
describe('local work engine', () => {
  it('is Claude by default and for any value it does not know', () => {
    expect(workEngineFrom(undefined)).toBe('claude')
    expect(workEngineFrom('gemini')).toBe('claude')
  })

  it('is Codex when the machine says so', () => {
    expect(workEngineFrom(' codex ')).toBe('codex')
  })
})
