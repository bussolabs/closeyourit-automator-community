import {describe, expect, it, vi} from 'vitest'
import {cachedRuntimeReadiness, probeAgentRuntimes, type ProbeRun} from '../src/lib/runtime-probe'
import {resetOrgClaudeCredential} from '../src/lib/org-claude-credential'

const CLAUDE_OK = JSON.stringify({is_error: false, result: 'OK'})
const CODEX_OK = '{"type":"turn.started"}\n{"type":"turn.completed","usage":{}}\n'

function runWith(outputs: {claude: {code: number | null; stdout: string}; codex: {code: number | null; stdout: string}}) {
  const calls: Array<{cmd: string; args: string[]}> = []
  const run: ProbeRun = async (cmd, args) => {
    calls.push({cmd, args})
    const out = cmd === 'claude' ? outputs.claude : outputs.codex
    return {code: out.code, stdout: out.stdout, timedOut: out.code === null, truncated: false, capturedBytes: out.stdout.length}
  }
  return {run, calls}
}

describe('probeAgentRuntimes', () => {
  it('both answer → ready, with the pinned models and Codex in JSON', async () => {
    const {run, calls} = runWith({claude: {code: 0, stdout: CLAUDE_OK}, codex: {code: 0, stdout: CODEX_OK}})
    expect(await probeAgentRuntimes({run, settingsPath: '/g/settings.json'})).toEqual({ready: true})

    const claude = calls.find((call) => call.cmd === 'claude')!.args
    const codex = calls.find((call) => call.cmd === 'codex')!.args
    expect(claude.at(claude.indexOf('--model') + 1)).toBe('claude-opus-5-5')
    expect(claude.at(claude.indexOf('--settings') + 1)).toBe('/g/settings.json')
    expect(codex.at(codex.indexOf('--model') + 1)).toBe('gpt-6-astra')
    expect(codex.indexOf('--json')).toBeGreaterThan(-1)
    expect(codex.indexOf('--json')).toBeLessThan(codex.indexOf('--'))
  })

  // The 23/09 failure: `codex login status` said "Logged in" and the real session answered 401.
  it('Codex with revoked login → not ready, with the reason', async () => {
    const {run} = runWith({
      claude: {code: 0, stdout: CLAUDE_OK},
      codex: {code: 1, stdout: '{"type":"error","message":"auth error code: token_revoked"}\n'},
    })
    expect(await probeAgentRuntimes({run, settingsPath: '/g'})).toEqual({ready: false, detail: 'codex: autenticazione scaduta o revocata'})
  })

  it('Claude with is_error at exit 0 → not ready', async () => {
    const {run} = runWith({
      claude: {code: 0, stdout: JSON.stringify({is_error: true, result: 'Not logged in · Please run /login'})},
      codex: {code: 0, stdout: CODEX_OK},
    })
    expect(await probeAgentRuntimes({run, settingsPath: '/g'})).toEqual({ready: false, detail: 'claude: autenticazione scaduta o revocata'})
  })

  it('two failures together → both reasons; a timeout is reported as timeout', async () => {
    const {run} = runWith({claude: {code: null, stdout: ''}, codex: {code: 2, stdout: ''}})
    expect(await probeAgentRuntimes({run, settingsPath: '/g'})).toEqual({ready: false, detail: 'claude: timeout; codex: exit 2'})
  })
})

describe('probeAgentRuntimes with the organization credential (CYAU-224)', () => {
  it('probes Claude with it and keeps it away from Codex', async () => {
    resetOrgClaudeCredential({load: () => 'sk-ant-oat01-organization', save: () => true, clear: () => true})
    const envs: Record<string, NodeJS.ProcessEnv | undefined> = {}
    const run: ProbeRun = async (cmd, _args, options) => {
      envs[cmd] = options.env
      return {code: 0, stdout: cmd === 'claude' ? CLAUDE_OK : CODEX_OK, timedOut: false, truncated: false, capturedBytes: 1}
    }
    try {
      expect(await probeAgentRuntimes({run, settingsPath: '/g'})).toEqual({ready: true})
      expect(envs.claude?.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-organization')
      expect(envs.codex?.CLAUDE_CODE_OAUTH_TOKEN).not.toBe('sk-ant-oat01-organization')
    } finally {
      resetOrgClaudeCredential()
    }
  })
})

describe('cachedRuntimeReadiness', () => {
  it('a successful probe lasts one hour, a failed one is repeated after 5 minutes', async () => {
    let clock = 0
    const probe = vi.fn()
      .mockResolvedValueOnce({ready: true})
      .mockResolvedValueOnce({ready: false, detail: 'codex: x'})
      .mockResolvedValueOnce({ready: true})
    const check = cachedRuntimeReadiness(probe, {now: () => clock})

    expect(await check()).toEqual({ready: true})
    clock = 59 * 60_000
    await check()
    expect(probe).toHaveBeenCalledTimes(1)

    clock = 60 * 60_000
    expect(await check()).toEqual({ready: false, detail: 'codex: x'})
    clock += 4 * 60_000
    await check()
    expect(probe).toHaveBeenCalledTimes(2)

    clock += 60_000
    expect(await check()).toEqual({ready: true})
    expect(probe).toHaveBeenCalledTimes(3)
  })

  it('concurrent requests share a single probe', async () => {
    const probe = vi.fn(async () => ({ready: true as const}))
    const check = cachedRuntimeReadiness(probe, {now: () => 0})
    await Promise.all([check(), check(), check()])
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('invalidate forces a new probe even within the validity hour', async () => {
    const probe = vi.fn(async () => ({ready: true as const}))
    const check = cachedRuntimeReadiness(probe, {now: () => 0})
    await check()
    check.invalidate()
    await check()
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('a probe that throws counts as not ready', async () => {
    const check = cachedRuntimeReadiness(async () => { throw new Error('spawn ENOENT') }, {now: () => 0})
    expect(await check()).toEqual({ready: false, detail: 'prova dei runtime non eseguibile'})
  })
})
