import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

// Doctor reads the state via `probeAllAsync` (CLI) and `probeRuntimes` (agent runtime). We mock them to drive
// the scenarios without touching the system's real CLIs.
const probes = vi.hoisted(() => ({
  probeAllAsync: vi.fn(),
  probeRuntimes: vi.fn(),
  probeLinuxHost: vi.fn(),
  probeAgentRuntimes: vi.fn(),
  resolveReviewerRuntime: vi.fn(),
  resolveClaudeReviewCredential: vi.fn(),
  loadSecrets: vi.fn(() => ({})),
  dnsLookup: vi.fn(),
}))

// CYAU-238: the configured server and its name lookup, never the machine's real ones.
vi.mock('../src/lib/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/config')>()
  return {...actual, loadSecrets: probes.loadSecrets}
})

vi.mock('../src/lib/isolated-lookup', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/isolated-lookup')>()
  return {...actual, lookupIsolated: probes.dnsLookup}
})

vi.mock('../src/lib/claude-review-credential', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/claude-review-credential')>()
  return {...actual, resolveClaudeReviewCredential: probes.resolveClaudeReviewCredential}
})

vi.mock('../src/lib/review-execution', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/review-execution')>()
  return {...actual, resolveReviewerRuntime: probes.resolveReviewerRuntime}
})

vi.mock('../src/lib/runtime-probe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/runtime-probe')>()
  return {...actual, probeAgentRuntimes: probes.probeAgentRuntimes}
})

vi.mock('../src/lib/deps', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/deps')>()
  return {...actual, probeAllAsync: probes.probeAllAsync}
})

vi.mock('../src/lib/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/runtime')>()
  return {...actual, probeRuntimes: probes.probeRuntimes}
})

vi.mock('../src/lib/linux-host', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/linux-host')>()
  return {...actual, probeLinuxHost: probes.probeLinuxHost}
})

import Doctor from '../src/commands/doctor'
import {runCaptured, runExpectingExit} from './helpers/command'

// All CLIs present: isolates the runtime tests (no `missing` that would make doctor fail for other reasons).
const CLI_OK = [
  {name: 'claude', present: true, version: '1.0.0', required: true},
  {name: 'gh', present: true, version: '2.0.0', required: true},
  {name: 'cyi', present: true, version: '3.0.0', required: true},
]

const claudeAvailable = {id: 'claude', required: true, available: true}
const codexAvailable = {id: 'codex', required: false, available: true}
const codexMissing = {id: 'codex', required: false, available: false, detail: 'exit 127', fix: "installa la CLI codex con 'automator setup --optional'"}

interface DoctorResult {
  ok: boolean
  crossReviewAvailable: boolean
  hostChecks: Array<{id: string; ok: boolean; detail?: string}>
}

const MACHINE_ACCESS = 'sk-ant-oat01-doctor-machine-access'
const claudeSignedIn = {
  status: 'valid', source: 'machine', env: {CLAUDE_CODE_OAUTH_TOKEN: MACHINE_ACCESS}, expiresAt: Date.UTC(2030, 0, 1),
}
const claudeNotSignedIn = {status: 'missing', source: null, env: {}}
const claudeExpired = {status: 'expired', source: 'machine', env: {}, expiresAt: Date.UTC(2026, 9, 1)}

// CYAU-223: every case below runs on a machine whose Claude review is signed in, unless it says otherwise.
beforeEach(() => {
  probes.resolveClaudeReviewCredential.mockReturnValue(claudeSignedIn)
})

describe('doctor — revisione incrociata (CYAU-66)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    probes.probeAllAsync.mockResolvedValue(CLI_OK)
    probes.probeAgentRuntimes.mockResolvedValue({ready: true})
    probes.probeLinuxHost.mockResolvedValue([
      {id: 'linux', ok: true},
      {id: 'systemd-cgroup-v2', ok: true},
      {id: 'bubblewrap', ok: true},
      {id: 'secret-service', ok: true},
    ])
  })

  it('with both runtimes available the cross review is possible and emits no warnings', async () => {
    probes.probeRuntimes.mockResolvedValue([claudeAvailable, codexAvailable])

    const {result, stdout} = await runCaptured(Doctor, [])

    expect((result as DoctorResult).crossReviewAvailable).toBe(true)
    expect(stdout).not.toContain('Revisione incrociata non disponibile')
  })

  it('without codex warns that cross review is impossible and points to same-engine review, without failing', async () => {
    probes.probeRuntimes.mockResolvedValue([claudeAvailable, codexMissing])

    const {result, stdout} = await runCaptured(Doctor, [])

    // It does not block: codex stays optional (exit 0), but the operator must know that cross review rejects the
    // deliveries and that same-engine review is the way out (CYRA-921).
    expect((result as DoctorResult).crossReviewAvailable).toBe(false)
    expect(stdout).toContain('Revisione incrociata non disponibile')
    expect(stdout).toContain('Lo stesso motore')
  })

  it('the gate code stays unchanged: an unavailable REQUIRED runtime makes doctor fail', async () => {
    probes.probeRuntimes.mockResolvedValue([
      {id: 'claude', required: true, available: false, detail: 'exit 127', fix: "installa/aggiorna la CLI claude con 'automator setup'"},
      codexAvailable,
    ])

    const {message} = await runExpectingExit(Doctor, [], 1)
    expect(message).toContain('claude')
  })

  it('fails closed and shows the remediation when the Linux host contract is not satisfied', async () => {
    probes.probeRuntimes.mockResolvedValue([claudeAvailable, codexAvailable])
    probes.probeLinuxHost.mockResolvedValue([
      {id: 'linux', ok: true},
      {id: 'systemd-cgroup-v2', ok: false, detail: 'cgroup v2 non disponibile'},
      {id: 'bubblewrap', ok: false, detail: 'installa bubblewrap'},
      {id: 'secret-service', ok: true},
    ])

    const {message, stderr} = await runExpectingExit(Doctor, [], 1)

    expect(message).toContain('cgroup v2 non disponibile')
    expect(message).toContain('installa bubblewrap')
    expect(stderr).toContain('systemd-cgroup-v2')
    expect(stderr).toContain('bubblewrap')
  })
})

describe('doctor — real runtime check (CYAU-206)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    probes.probeAllAsync.mockResolvedValue(CLI_OK)
    probes.probeRuntimes.mockResolvedValue([claudeAvailable, codexAvailable])
    probes.probeLinuxHost.mockResolvedValue([{id: 'linux', ok: true}])
  })

  // On 23/09 `codex login status` said "Logged in" with the login revoked.
  it('a failed real probe is visible, with the reason, even if the CLIs answer', async () => {
    probes.probeAgentRuntimes.mockResolvedValue({ready: false, detail: 'codex: autenticazione scaduta o revocata'})
    const {stdout} = await runCaptured(Doctor, [])
    expect(stdout).toContain('Prova reale fallita: codex: autenticazione scaduta o revocata')

    const json = await runCaptured(Doctor, ['--json'])
    expect(JSON.parse(json.stdout)).toMatchObject({liveProbe: {ready: false, detail: 'codex: autenticazione scaduta o revocata'}})
  })

  // The service gets its Claude token from ~/.config/environment.d; an SSH shell does not, and the probe
  // then failed with a false «expired or revoked» while the daemon was working fine.
  it('says when this shell lacks the Claude credentials the service receives', async () => {
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '')
    vi.stubEnv('ANTHROPIC_API_KEY', '')
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', '')
    probes.probeAgentRuntimes.mockResolvedValue({ready: false, detail: 'claude: autenticazione scaduta o revocata'})
    const {stdout} = await runCaptured(Doctor, [])
    expect(stdout).toContain('This shell has no Claude credentials')
    vi.unstubAllEnvs()
  })

  it('does not blame the shell when it carries Claude credentials', async () => {
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'present')
    probes.probeAgentRuntimes.mockResolvedValue({ready: false, detail: 'claude: autenticazione scaduta o revocata'})
    const {stdout} = await runCaptured(Doctor, [])
    expect(stdout).not.toContain('This shell has no Claude credentials')
    vi.unstubAllEnvs()
  })

  it('without one of the two CLIs the real probe does not start', async () => {
    probes.probeRuntimes.mockResolvedValue([claudeAvailable, {id: 'codex', required: false, available: false}])
    await runCaptured(Doctor, [])
    expect(probes.probeAgentRuntimes).not.toHaveBeenCalled()
  })
})

// CYRA-878: a group-writable runtime install passed every check and then made every diff review fail.
describe('doctor — reviewer trust policy', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    probes.probeAllAsync.mockResolvedValue(CLI_OK)
    probes.probeRuntimes.mockResolvedValue([claudeAvailable, codexAvailable])
    probes.probeLinuxHost.mockResolvedValue([{id: 'linux', ok: true}])
    probes.probeAgentRuntimes.mockResolvedValue({ready: true})
  })

  it('warns when the review policy refuses a runtime executable', async () => {
    probes.resolveReviewerRuntime.mockImplementation(async (id: string) => {
      if (id === 'codex') throw new Error('Eseguibile reviewer non trovato in PATH: codex')
      return {command: '/usr/bin/claude', prefix: [], readPaths: []}
    })
    const {stdout} = await runCaptured(Doctor, [])
    expect(stdout).toContain('codex cannot review: Eseguibile reviewer non trovato in PATH: codex')
    expect(stdout).toContain('chmod -R go-w')
  })

  // CYAU-222 — Claude's diff review runs inside the Codex sandbox: without a usable Codex every diff
  // review is unavailable, also on a machine set to be reviewed by the same engine.
  it('says that every diff review fails when Codex cannot run the sandbox, even when Codex is not installed', async () => {
    probes.probeRuntimes.mockResolvedValue([claudeAvailable, {...codexAvailable, available: false}])
    probes.resolveReviewerRuntime.mockImplementation(async (id: string) => {
      if (id === 'codex') throw new Error('Eseguibile reviewer non trovato in PATH: codex')
      return {command: '/usr/bin/claude', prefix: [], readPaths: []}
    })
    const {stdout} = await runCaptured(Doctor, [])
    expect(stdout).toContain('codex cannot review')
    expect(stdout).toContain('every diff review will be unavailable')
  })

  it('stays quiet when both runtimes are trusted', async () => {
    probes.resolveReviewerRuntime.mockResolvedValue({command: '/usr/bin/x', prefix: [], readPaths: []})
    const {stdout} = await runCaptured(Doctor, [])
    expect(stdout).not.toContain('cannot review')
  })
})

// CYAU-223 — the confined Claude review cannot see the machine home: doctor checks the credential it will really get.
describe('doctor — Claude review sign-in', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    probes.probeAllAsync.mockResolvedValue(CLI_OK)
    probes.probeRuntimes.mockResolvedValue([claudeAvailable, codexAvailable])
    probes.probeLinuxHost.mockResolvedValue([{id: 'linux', ok: true}])
    probes.probeAgentRuntimes.mockResolvedValue({ready: true})
    probes.resolveReviewerRuntime.mockResolvedValue({command: '/usr/bin/x', prefix: [], readPaths: []})
  })

  it('passes on a machine with Claude and Codex signed in as the guide says, without ever printing the token', async () => {
    const {result, stdout} = await runCaptured(Doctor, [])
    expect(stdout).toContain('Claude can review: it uses the Claude sign-in of this machine, valid until 2030-01-01T00:00:00.000Z')
    expect(result).toMatchObject({ok: true, claudeReview: {status: 'valid', source: 'machine'}})
    expect(stdout).not.toContain(MACHINE_ACCESS)

    const json = await runCaptured(Doctor, ['--json'])
    expect(JSON.parse(json.stdout)).toMatchObject({claudeReview: {status: 'valid', source: 'machine'}})
    expect(json.stdout).not.toContain(MACHINE_ACCESS)
  })

  it('fails on a machine with Claude and Codex when Claude is not signed in, and says how to sign it in', async () => {
    probes.resolveClaudeReviewCredential.mockReturnValue(claudeNotSignedIn)
    const {message, stdout} = await runExpectingExit(Doctor, [], 1)
    expect(message).toContain('Claude cannot review')
    expect(message).toContain("'claude login'")
    expect(message).toContain('organization Claude credential')
    expect(stdout).toContain('✗ Claude cannot review')
  })

  it('fails with an expired sign-in and says it expired', async () => {
    probes.resolveClaudeReviewCredential.mockReturnValue(claudeExpired)
    const {message} = await runExpectingExit(Doctor, [], 1)
    expect(message).toContain('expired on 2026-10-01T00:00:00.000Z')
  })

  it('fails on a Claude-only machine that is not signed in, and keeps the missing Codex warning', async () => {
    probes.probeRuntimes.mockResolvedValue([claudeAvailable, codexMissing])
    probes.resolveClaudeReviewCredential.mockReturnValue(claudeNotSignedIn)
    const {message, stdout} = await runExpectingExit(Doctor, [], 1)
    expect(message).toContain('Claude cannot review')
    expect(stdout).toContain('Revisione incrociata non disponibile')
  })

  it('passes the sign-in check on a Claude-only machine signed in, leaving only the missing Codex warning', async () => {
    probes.probeRuntimes.mockResolvedValue([claudeAvailable, codexMissing])
    const {result, stdout} = await runCaptured(Doctor, [])
    expect(result).toMatchObject({ok: true, crossReviewAvailable: false, claudeReview: {status: 'valid'}})
    expect(stdout).toContain('Revisione incrociata non disponibile')
    expect(stdout).toContain('Claude can review')
    expect(stdout).not.toContain('✗ Claude cannot review')
  })

  it('accepts the organization credential and does not look at Claude when it is not installed', async () => {
    probes.resolveClaudeReviewCredential.mockReturnValue({status: 'valid', source: 'organization', env: {ANTHROPIC_API_KEY: 'sk-ant-api03-org'}})
    const {stdout} = await runCaptured(Doctor, [])
    expect(stdout).toContain('it uses the organization Claude credential')

    probes.resolveClaudeReviewCredential.mockClear()
    probes.probeAllAsync.mockResolvedValue(CLI_OK.map((dep) => dep.name === 'claude' ? {...dep, present: false, required: false} : dep))
    await runCaptured(Doctor, [])
    expect(probes.resolveClaudeReviewCredential).not.toHaveBeenCalled()
  })
})

// CYAU-238 — with Codex at work, a server on a private network reached by name gets a non-blocking warning.
describe('doctor — private CloseYourIt server with Codex (CYAU-238)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    probes.probeAllAsync.mockResolvedValue(CLI_OK)
    probes.probeRuntimes.mockResolvedValue([claudeAvailable, codexAvailable])
    probes.probeLinuxHost.mockResolvedValue([{id: 'linux', ok: true}])
    probes.probeAgentRuntimes.mockResolvedValue({ready: true})
    probes.resolveReviewerRuntime.mockResolvedValue({command: '/usr/bin/x', prefix: [], readPaths: []})
    vi.stubEnv('AUTOMATOR_SANDBOX_DOMAINS', '')
    vi.stubEnv('AUTOMATOR_WORK_ENGINE', 'codex')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('warns with the exact correction and still passes', async () => {
    probes.loadSecrets.mockReturnValue({sync: {apiUrl: 'https://cyi.lan'}})
    probes.dnsLookup.mockResolvedValue([{address: '192.168.1.20', family: 4}])

    const {result, stdout} = await runCaptured(Doctor, [])

    expect(probes.dnsLookup).toHaveBeenCalledWith('cyi.lan', 3000)
    expect(stdout).toContain('Codex cannot reach the CloseYourIt server by name')
    expect(stdout).toContain('to https://192.168.1.20')
    expect(stdout).toContain('AUTOMATOR_SANDBOX_DOMAINS=192.168.1.20')
    expect(result).toMatchObject({ok: true, privateServer: {kind: 'ipv4', address: '192.168.1.20'}})
  })

  it('says Codex cannot reach a name with only IPv6 addresses', async () => {
    probes.loadSecrets.mockReturnValue({sync: {apiUrl: 'https://cyi.lan'}})
    probes.dnsLookup.mockResolvedValue([{address: 'fd12::5', family: 6}])

    const {stdout} = await runCaptured(Doctor, [])

    expect(stdout).toContain('AUTOMATOR_WORK_ENGINE=claude')
    expect(stdout).not.toContain('AUTOMATOR_SANDBOX_DOMAINS=fd12')
  })

  it('says it could not check a name that does not resolve, and still passes', async () => {
    probes.loadSecrets.mockReturnValue({sync: {apiUrl: 'https://cyi.lan'}})
    probes.dnsLookup.mockRejectedValue(new Error('getaddrinfo ENOTFOUND cyi.lan'))

    const {result, stdout} = await runCaptured(Doctor, [])

    expect(stdout).toContain('Could not check whether Codex can reach the CloseYourIt server')
    expect(result).toMatchObject({ok: true})
  })

  it('says nothing when the configuration cannot be read', async () => {
    probes.loadSecrets.mockImplementation(() => {
      throw new Error('unreadable')
    })

    const {result, stdout} = await runCaptured(Doctor, [])

    expect(stdout).not.toContain('Codex cannot reach')
    expect(result).toMatchObject({ok: true})
    expect(result).not.toHaveProperty('privateServer')
    probes.loadSecrets.mockImplementation(() => ({}))
  })

  it('says nothing with Claude at work, the default server or a server written as its address', async () => {
    probes.dnsLookup.mockResolvedValue([{address: '192.168.1.20', family: 4}])

    vi.stubEnv('AUTOMATOR_WORK_ENGINE', 'claude')
    probes.loadSecrets.mockReturnValue({sync: {apiUrl: 'https://cyi.lan'}})
    const claude = await runCaptured(Doctor, [])
    vi.stubEnv('AUTOMATOR_WORK_ENGINE', 'codex')
    probes.loadSecrets.mockReturnValue({sync: {}})
    const defaultServer = await runCaptured(Doctor, [])
    probes.loadSecrets.mockReturnValue({sync: {apiUrl: 'https://192.168.1.20'}})
    const numeric = await runCaptured(Doctor, [])
    probes.loadSecrets.mockReturnValue({sync: {apiUrl: 'http://localhost:3000'}})
    const localhost = await runCaptured(Doctor, [])

    for (const run of [claude, defaultServer, numeric, localhost]) {
      expect(run.stdout).not.toContain('Codex cannot reach')
      expect(run.stdout).not.toContain('Could not check')
      expect(run.result).not.toHaveProperty('privateServer')
    }
    expect(probes.dnsLookup).not.toHaveBeenCalled()
  })
})
