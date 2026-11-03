import {describe, expect, it} from 'vitest'
import {describeRuntimeFailure} from '../src/lib/runtime-failure'

describe('describeRuntimeFailure', () => {
  // The 23/09 failure: Codex ChatGPT login revoked, `codex login status` still said "Logged in".
  it('recognises a revoked Codex login', () => {
    const log = 'ERROR: Your access token could not be refreshed because your refresh token was revoked. auth error code: token_revoked'
    expect(describeRuntimeFailure('codex', log, 'C001-EXEC-003')).toBe('codex: autenticazione scaduta o revocata')
  })

  it('recognises unauthenticated Claude', () => {
    expect(describeRuntimeFailure('claude', '{"result":"Not logged in · Please run /login"}', null))
      .toBe('claude: autenticazione scaduta o revocata')
  })

  it('recognises the exhausted quota', () => {
    expect(describeRuntimeFailure('claude', '"api_error_status":429', 'C001-EXEC-003')).toBe('claude: quota del modello esaurita')
  })

  // CYAU-275 — the reset time is no longer lost: it says when the engine works again.
  it('keeps the reset time of a usage limit', () => {
    const out = '{"is_error":true,"result":"Claude AI usage limit reached|1793790000"}'
    expect(describeRuntimeFailure('claude', out, null, new Date('2026-11-03T10:00:00Z')))
      .toBe(`claude: quota del modello esaurita, reset ${new Date(1_793_790_000_000).toISOString()}`)
  })

  it('recognizes a model the installed CLI does not support', () => {
    const log = "The 'gpt-6-astra' model requires a newer version of Codex. Please upgrade to the latest app or CLI"
    expect(describeRuntimeFailure('codex', log, null)).toBe('codex: modello non disponibile per questa CLI')
  })

  it('recognizes a Claude CLI too old for the model', () => {
    const out = '"result":"API Error: 400 Claude Code 2.1.222 does not support this model; version 2.1.280 or newer is required."'
    expect(describeRuntimeFailure('claude', out, 'exit 1')).toBe('claude: modello non disponibile per questa CLI')
  })

  it('without known signals reports the error code, never the raw text', () => {
    expect(describeRuntimeFailure('codex', 'qualcosa con sk-ant-SEGRETO dentro', 'C001-EXEC-003')).toBe('codex: C001-EXEC-003')
    expect(describeRuntimeFailure('codex', '', null)).toBe('codex: output non valido')
  })
})
