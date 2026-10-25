import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import Discovery from '../src/commands/discovery'
import {runCaptured, runExpectingExit} from './helpers/command'

// The `discovery` command is pure (no secret, no state dir): the orchestrator either defines the read-only
// role for a runtime (--role) or passes it the agent's raw signals to evaluate with the budget. It covers
// Scenario 1 (read-only role that neither writes nor opens PRs) and the DoD (signals with source/impact/confidence).

const SIGNAL = {
  source: 'errors',
  title: 'Errore 500 ricorrente al checkout',
  evidence: '42 occorrenze in 24h nel gruppo CHECKOUT_TIMEOUT',
  impact: 'high',
  confidence: 0.8,
}

describe('discovery command — read-only role definition (Scenario 1 / DoD)', () => {
  it('--role --runtime claude → read-only role, without writes or PRs (permission mode plan)', async () => {
    const {result} = await runCaptured(Discovery, ['--role', '--runtime', 'claude', '--json'])
    const r = result as {
      role: string
      runtime: string
      permissionMode: string
      readOnly: boolean
      canModifyFiles: boolean
      canOpenPr: boolean
    }
    expect(r.role).toBe('discovery')
    expect(r.runtime).toBe('claude')
    expect(r.permissionMode).toBe('plan')
    expect(r.readOnly).toBe(true)
    expect(r.canModifyFiles).toBe(false)
    expect(r.canOpenPr).toBe(false)
  })

  it('--role --runtime codex → sandbox read-only', async () => {
    const {result} = await runCaptured(Discovery, ['--role', '--runtime', 'codex', '--json'])
    expect((result as {permissionMode: string}).permissionMode).toBe('read-only')
  })

  it('human output of the role: mentions read-only and the allowed sources', async () => {
    const {stdout} = await runCaptured(Discovery, ['--role', '--runtime', 'claude'])
    const low = stdout.toLowerCase()
    expect(low).toContain('read-only')
    expect(low).toContain('errors')
  })

  it('custom sources and budget are respected', async () => {
    const {result} = await runCaptured(Discovery, [
      '--role', '--runtime', 'claude',
      '--source', 'errors', '--source', 'ci',
      '--max-signals', '3', '--min-confidence', '0.7',
      '--json',
    ])
    const r = result as {allowedSources: string[]; budget: {maxSignals: number; minConfidence: number}}
    expect(r.allowedSources).toEqual(['errors', 'ci'])
    expect(r.budget).toEqual({maxSignals: 3, minConfidence: 0.7})
  })

  it('--role without --runtime → exit 2 (the runtime is needed for the permission mode)', async () => {
    const {stderr} = await runExpectingExit(Discovery, ['--role'], 2)
    expect(stderr).toContain('C400-DISCOVERY-001')
  })

  it('--role with unknown runtime → exit 2', async () => {
    const {stderr} = await runExpectingExit(Discovery, ['--role', '--runtime', 'gpt'], 2)
    expect(stderr).toContain('C400-DISCOVERY-001')
  })

  it('--role with unknown source → exit 2', async () => {
    const {stderr} = await runExpectingExit(Discovery, ['--role', '--runtime', 'claude', '--source', 'logs'], 2)
    expect(stderr).toContain('C400-DISCOVERY-001')
  })
})

describe('discovery command — signal evaluation (DoD: source/impact/confidence)', () => {
  it('a valid signal is accepted and carries source, impact and evidence', async () => {
    const {result} = await runCaptured(Discovery, ['--signal', JSON.stringify(SIGNAL), '--json'])
    const r = result as {accepted: {source: string; impact: string; evidence: string; confidence: number}[]}
    expect(r.accepted).toHaveLength(1)
    expect(r.accepted[0].source).toBe('errors')
    expect(r.accepted[0].impact).toBe('high')
    expect(r.accepted[0].confidence).toBe(0.8)
  })

  it('the --max-signals budget keeps the most impactful ones and discards the rest', async () => {
    const critical = {...SIGNAL, title: 'DB down', impact: 'critical'}
    const low = {...SIGNAL, title: 'refuso log', impact: 'low', confidence: 0.9}
    const {result} = await runCaptured(Discovery, [
      '--signal', JSON.stringify(critical),
      '--signal', JSON.stringify(low),
      '--max-signals', '1', '--min-confidence', '0',
      '--json',
    ])
    const r = result as {accepted: {title: string}[]; dropped: {signal: {title: string}; reason: string}[]}
    expect(r.accepted.map((s) => s.title)).toEqual(['DB down'])
    expect(r.dropped.map((d) => d.signal.title)).toEqual(['refuso log'])
  })

  it('discards the signals below the confidence threshold', async () => {
    const weak = {...SIGNAL, title: 'debole', confidence: 0.2}
    const {result} = await runCaptured(Discovery, [
      '--signal', JSON.stringify(SIGNAL),
      '--signal', JSON.stringify(weak),
      '--min-confidence', '0.5',
      '--json',
    ])
    const r = result as {accepted: {title: string}[]; dropped: {signal: {title: string}}[]}
    expect(r.accepted.map((s) => s.title)).not.toContain('debole')
    expect(r.dropped.map((d) => d.signal.title)).toContain('debole')
  })

  it('no signal → empty report, exit 0 (the discovery may find nothing)', async () => {
    const {result} = await runCaptured(Discovery, ['--json'])
    const r = result as {accepted: unknown[]; dropped: unknown[]}
    expect(r.accepted).toEqual([])
    expect(r.dropped).toEqual([])
  })

  it('human output of the signals: prints title, impact and reasons', async () => {
    const {stdout} = await runCaptured(Discovery, ['--signal', JSON.stringify(SIGNAL)])
    const low = stdout.toLowerCase()
    expect(low).toContain('checkout')
    expect(low).toContain('high')
  })

  it('the ticket code labels the output', async () => {
    const {result} = await runCaptured(Discovery, ['--code', 'CYAU-29', '--signal', JSON.stringify(SIGNAL), '--json'])
    expect((result as {code: string}).code).toBe('CYAU-29')
  })
})

describe('discovery command — input defence (untrusted input)', () => {
  it('--signal with illegal JSON → exit 2', async () => {
    const {stderr} = await runExpectingExit(Discovery, ['--signal', '{non-json'], 2)
    expect(stderr).toContain('C400-DISCOVERY-001')
  })

  it('--signal without impact (incomplete signal) → exit 2', async () => {
    const bad = {source: 'errors', title: 'x', evidence: 'y', confidence: 0.7}
    const {stderr} = await runExpectingExit(Discovery, ['--signal', JSON.stringify(bad)], 2)
    expect(stderr).toContain('C400-DISCOVERY-001')
  })

  it('--min-confidence fuori da [0,1] → exit 2', async () => {
    const {stderr} = await runExpectingExit(Discovery, ['--signal', JSON.stringify(SIGNAL), '--min-confidence', '2'], 2)
    expect(stderr).toContain('C400-DISCOVERY-001')
  })

  it('non-numeric --min-confidence → exit 2', async () => {
    const {stderr} = await runExpectingExit(Discovery, ['--signal', JSON.stringify(SIGNAL), '--min-confidence', 'x'], 2)
    expect(stderr).toContain('C400-DISCOVERY-001')
  })
})

describe('discovery command — segnali da file (--signals-file)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'automator-discovery-'))
  })
  afterEach(() => {
    rmSync(dir, {recursive: true, force: true})
  })

  it('reads an array of signals from a file and evaluates them', async () => {
    const file = join(dir, 'signals.json')
    writeFileSync(file, JSON.stringify([SIGNAL, {...SIGNAL, title: 'CI rossa', source: 'ci', impact: 'medium'}]))
    const {result} = await runCaptured(Discovery, ['--signals-file', file, '--json'])
    expect((result as {accepted: unknown[]}).accepted).toHaveLength(2)
  })

  it('file inesistente → exit 2', async () => {
    const {stderr} = await runExpectingExit(Discovery, ['--signals-file', join(dir, 'nope.json')], 2)
    expect(stderr).toContain('C400-DISCOVERY-001')
  })

  it('file that does not contain an array → exit 2', async () => {
    const file = join(dir, 'bad.json')
    writeFileSync(file, JSON.stringify(SIGNAL))
    const {stderr} = await runExpectingExit(Discovery, ['--signals-file', file], 2)
    expect(stderr).toContain('C400-DISCOVERY-001')
  })
})
