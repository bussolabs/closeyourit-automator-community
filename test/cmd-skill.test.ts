import {beforeEach, describe, expect, it, vi} from 'vitest'

// `skill sync` is the EXPLICIT path: whoever launches it is watching right now, so the comparison between the server
// pin and the published tags is always done (unlike the beat, where it would cost a call per minute).
// We mock secrets and sync to drive the scenarios without touching network or disk.
const mocks = vi.hoisted(() => ({
  loadSecrets: vi.fn(),
  syncFromSkillsManifest: vi.fn(),
}))

vi.mock('../src/lib/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/config')>()
  return {...actual, loadSecrets: mocks.loadSecrets}
})

vi.mock('../src/lib/skills-manifest', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/skills-manifest')>()
  return {...actual, syncFromSkillsManifest: mocks.syncFromSkillsManifest}
})

import Skill from '../src/commands/skill'
import {runCaptured, runExpectingExit} from './helpers/command'

const REGISTERED = {sync: {}, host: {id: 'h1', token: 'cyi_ah_s'}}

const report = (over: Record<string, unknown> = {}) => ({
  version: '0.1.1',
  repo: 'bussolabs/closeyourit-skills',
  ref: 'v0.1.1',
  action: 'current',
  ok: true,
  pluginDir: '/data/skills/current',
  detail: 'bundle 0.1.1 già attivo',
  pinCheck: {state: 'aligned'},
  ...over,
})

interface SkillResult {
  synced: boolean
  pinCheck: {state: string; lag?: {pinned: string; latest: string}}
}

describe('skill sync — pin canary (CYAU-135)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.loadSecrets.mockReturnValue(REGISTERED)
    mocks.syncFromSkillsManifest.mockResolvedValue(report())
  })

  // The three exits the command has even before syncing: without channel, without a registered
  // host, or with a server that has no pinned bundle. The first two stop, the third does not —
  // a host in prompt mode is not a failure.
  it('without API channel stops and says so', async () => {
    mocks.loadSecrets.mockReturnValue({host: {id: 'h1', token: 'cyi_ah_s'}})
    const {stderr} = await runExpectingExit(Skill, [], 2)
    expect(stderr).toContain('Canale API non configurato')
    expect(mocks.syncFromSkillsManifest).not.toHaveBeenCalled()
  })

  it('without registered host stops and says what to do', async () => {
    mocks.loadSecrets.mockReturnValue({sync: {}})
    const {stderr} = await runExpectingExit(Skill, [], 2)
    expect(stderr).toContain('automator register')
    expect(mocks.syncFromSkillsManifest).not.toHaveBeenCalled()
  })

  it('no pinned bundle: not a failure, the host stays in prompt mode', async () => {
    mocks.loadSecrets.mockReturnValue(REGISTERED)
    mocks.syncFromSkillsManifest.mockResolvedValue(null)
    const {result} = await runCaptured(Skill, ['--json'])
    expect(result).toMatchObject({synced: false, pluginDir: null, pinCheck: {state: 'skipped'}})
  })

  it('failed sync → error, not a silence', async () => {
    mocks.loadSecrets.mockReturnValue(REGISTERED)
    mocks.syncFromSkillsManifest.mockResolvedValue(report({ok: false, detail: 'cartella occupata'}))
    const {stderr} = await runExpectingExit(Skill, [], 1)
    expect(stderr).toContain('sync skill fallita: cartella occupata')
  })

  it('always asks for the comparison between pin and published tags', async () => {
    await runCaptured(Skill, ['sync'])
    expect(mocks.syncFromSkillsManifest.mock.calls[0][0]).toMatchObject({checkPinLag: true})
  })

  // The ticket's case: the publication went through, the pin did not. The host is aligned with the pin and without this notice
  // it would have no way to say so — it would silently stay on the old instructions.
  it('pin stuck on a superseded version → explicit notice with the two versions', async () => {
    mocks.syncFromSkillsManifest.mockResolvedValue(report({pinCheck: {state: 'behind', lag: {pinned: '0.1.1', latest: '0.1.2'}}}))

    const {result, stdout} = await runCaptured(Skill, ['sync'])

    expect(stdout).toContain('0.1.1')
    expect(stdout).toContain('0.1.2')
    expect(stdout).toContain('bussolabs/closeyourit-skills')
    expect((result as SkillResult).pinCheck).toEqual({state: 'behind', lag: {pinned: '0.1.1', latest: '0.1.2'}})
  })

  it('up-to-date pin → no notice', async () => {
    const {result, stdout} = await runCaptured(Skill, ['sync'])
    expect(stdout).not.toContain('⚠')
    expect((result as SkillResult).pinCheck).toEqual({state: 'aligned'})
  })

  // Without this message the operator would read the absence of notices as "pin is fine", while the comparison
  // did not even happen: it is the silence the ticket asks to remove, moved one step.
  it('failed check → says so, does not stay silent as if everything were fine', async () => {
    mocks.syncFromSkillsManifest.mockResolvedValue(report({pinCheck: {state: 'unknown'}}))

    const {result, stdout} = await runCaptured(Skill, ['sync'])

    expect(stdout).toContain('non verificato')
    expect((result as SkillResult).pinCheck).toEqual({state: 'unknown'})
  })
})
