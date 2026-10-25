import {afterEach, describe, expect, it, vi} from 'vitest'
import {DEPS, claudeAuthenticated, claudeAuthenticatedAsync, codexAuthenticated, codexAuthenticatedAsync, cyiAuthenticated, githubAuthenticated, probe, probeAll, probeAllAsync, setupDep, type ShellExec, type ShellResult} from '../src/lib/deps'
import {type ChildLike, type SpawnFn} from '../src/lib/executor'
import {resetOrgClaudeCredential} from '../src/lib/org-claude-credential'

/** Fake spawn that closes immediately with the given exit code (for the async auth probes via runProcessProbe). */
function spawnClosing(code: number): SpawnFn {
  return () => {
    let closeCb: ((c: number | null, s: NodeJS.Signals | null) => void) | undefined
    const child: ChildLike = {
      pid: 1,
      stdout: {on: () => undefined},
      stderr: null,
      on: (event, cb) => {
        if (event !== 'close') return
        closeCb = cb as typeof closeCb
        queueMicrotask(() => closeCb?.(code, null))
      },
      kill: () => true,
    }
    return child
  }
}

const ok = (stdout = ''): ShellResult => ({code: 0, stdout, stderr: ''})
const ko = (stderr = 'boom'): ShellResult => ({code: 1, stdout: '', stderr})

const mise = DEPS.find((d) => d.name === 'mise')!
const node = DEPS.find((d) => d.name === 'node')!
const gh = DEPS.find((d) => d.name === 'gh')!
const claude = DEPS.find((d) => d.name === 'claude')!
const codex = DEPS.find((d) => d.name === 'codex')!
const python = DEPS.find((d) => d.name === 'python')!
const jq = DEPS.find((d) => d.name === 'jq')!

afterEach(() => vi.useRealTimers())

/** Fake exec: `installed` = present bins; the install commands add the bin to the set. */
function makeExec(installed: Set<string>): ShellExec {
  return (script) => {
    const cv = /^command -v (\S+)/.exec(script)
    if (cv) return installed.has(cv[1]) ? ok(`/bin/${cv[1]}`) : ko()
    if (/--version/.test(script)) return ok('1.2.3')
    if (/mise\.run/.test(script)) return installed.add('mise') && ok()
    if (/mise use -g python@/.test(script)) return installed.add('python3') && ok()
    if (/mise use -g jq@/.test(script)) return installed.add('jq') && ok()
    if (/claude\.ai/.test(script)) return installed.add('claude') && ok()
    if (/@openai\/codex/.test(script)) return installed.add('codex') && ok()
    if (/brew install gh|cli\.github/.test(script)) return installed.add('gh') && ok()
    return ok()
  }
}

describe('probe', () => {
  it('present → captures the version', () => {
    const result = probe(mise, makeExec(new Set(['mise'])))
    expect(result.present).toBe(true)
    expect(result.version).toBe('1.2.3')
  })

  it('missing → present false, version null', () => {
    const result = probe(mise, makeExec(new Set()))
    expect(result.present).toBe(false)
    expect(result.version).toBeNull()
  })
})

describe('probeAll', () => {
  it('maps all deps', () => {
    expect(probeAll(DEPS, makeExec(new Set(['node']))).map((r) => r.name)).toContain('cyi')
  })

  // CYAU-136: the delivery scripts (deliver.sh/lib.sh) require the jq binary. It must be a REQUIRED
  // dep, so when missing it appears among the "missing required" that doctor and enroll report — instead of
  // letting the gap be discovered only at delivery (agent blocked, work done and never delivered).
  it('missing jq → probeAll reports it as missing required (so doctor/enroll report it)', () => {
    const jqProbe = probeAll(DEPS, makeExec(new Set())).find((r) => r.name === 'jq')!
    expect(jqProbe).toMatchObject({present: false, required: true})
  })

  it('isolates the probes: a stuck version times out while the others finish', async () => {
    vi.useFakeTimers()
    let nextPid = 300
    const signals: Array<{pid: number; signal: NodeJS.Signals}> = []
    const spawn: SpawnFn = (_cmd, args) => {
      const script = args.at(-1) ?? ''
      const pid = nextPid++
      let dataCb: ((chunk: Buffer | string) => void) | undefined
      let closeCb: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined
      const child: ChildLike = {
        pid,
        stdout: {on: (_event, cb) => (dataCb = cb)},
        stderr: null,
        on: (event, cb) => {
          if (event !== 'close') return
          closeCb = cb as typeof closeCb
          queueMicrotask(() => {
            if (script === 'claude --version') return
            dataCb?.(script === 'codex --version' ? '2.4.0\n' : '/bin/tool\n')
            closeCb?.(0, null)
          })
        },
        kill: () => true,
      }
      return child
    }

    const pending = probeAllAsync([claude, codex], {
      spawn,
      timeoutMs: 25,
      killGraceMs: 5,
      kill: (pid, signal) => signals.push({pid, signal}),
    })
    await vi.advanceTimersByTimeAsync(25)
    await vi.advanceTimersByTimeAsync(5)
    const [claudeResult, codexResult] = await pending

    expect(claudeResult).toMatchObject({present: true, version: null})
    expect(codexResult).toMatchObject({present: true, version: '2.4.0'})
    expect(signals.some(({pid, signal}) => pid < 0 && signal === 'SIGTERM')).toBe(true)
  })
})

describe('githubAuthenticated', () => {
  it('`gh auth status` exit 0 → true', () => {
    const exec: ShellExec = () => ok('github.com: Logged in as tizio')
    expect(githubAuthenticated(exec)).toBe(true)
  })

  it('`gh auth status` exit ≠0 (not logged in or gh missing) → false', () => {
    expect(githubAuthenticated(() => ko('You are not logged into any GitHub hosts'))).toBe(false)
  })

  it('probes `gh auth status`, never `--show-token` (no secret exposed)', () => {
    let script = ''
    githubAuthenticated((s) => {
      script = s
      return ok()
    })
    expect(script).toBe('gh auth status')
    expect(script).not.toContain('--show-token')
  })
})

describe('cyiAuthenticated', () => {
  it('`cyi whoami` exit 0 → true', () => {
    expect(cyiAuthenticated(() => ok('account: tizio · org: bussolabs'))).toBe(true)
  })

  it('`cyi whoami` exit ≠0 (not logged in or cyi missing) → false', () => {
    expect(cyiAuthenticated(() => ko('not authenticated'))).toBe(false)
  })

  it('probes exactly `cyi whoami` (device flow), no other command', () => {
    let script = ''
    cyiAuthenticated((s) => {
      script = s
      return ok()
    })
    expect(script).toBe('cyi whoami')
  })
})

describe('codexAuthenticated', () => {
  it('`codex login status` exit 0 → true', () => {
    expect(codexAuthenticated(() => ok('Logged in using ChatGPT'))).toBe(true)
  })

  it('`codex login status` exit ≠0 (not logged in or codex missing) → false', () => {
    expect(codexAuthenticated(() => ko('Not logged in'))).toBe(false)
  })

  it('probes exactly `codex login status` (device flow), no other command', () => {
    let script = ''
    codexAuthenticated((s) => {
      script = s
      return ok()
    })
    expect(script).toBe('codex login status')
  })
})

describe('codexAuthenticatedAsync', () => {
  it('`codex login status` process with exit 0 → true', async () => {
    expect(await codexAuthenticatedAsync({spawn: spawnClosing(0)})).toBe(true)
  })

  it('exit ≠0 (not logged in or codex missing) → false', async () => {
    expect(await codexAuthenticatedAsync({spawn: spawnClosing(1)})).toBe(false)
  })
})

describe('claudeAuthenticated', () => {
  it('`claude auth status` exit 0 → true', () => {
    expect(claudeAuthenticated(() => ok('logged in'))).toBe(true)
  })

  it('`claude auth status` exit ≠0 (not authenticated or claude missing) → false', () => {
    expect(claudeAuthenticated(() => ko('Not authenticated'))).toBe(false)
  })

  it('probes `claude auth status` in the service environment (without the ephemeral Claude auth env of the shell)', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-ephemeral'
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat-ephemeral'
    process.env.CLOSEYOURIT_TEST_SENTINEL = 'keep-me'
    try {
      let script = ''
      let seenEnv: NodeJS.ProcessEnv | undefined
      claudeAuthenticated((s, env) => {
        script = s
        seenEnv = env
        return ok()
      })
      expect(script).toBe('claude auth status')
      // The ephemeral shell exports do NOT reach the probe (nor the daemon): no false-ready.
      expect(seenEnv?.ANTHROPIC_API_KEY).toBeUndefined()
      expect(seenEnv?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
      // The rest of the environment stays: the durable auth of `claude login` (via HOME) is detectable.
      expect(seenEnv?.CLOSEYOURIT_TEST_SENTINEL).toBe('keep-me')
    } finally {
      delete process.env.ANTHROPIC_API_KEY
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN
      delete process.env.CLOSEYOURIT_TEST_SENTINEL
    }
  })
  it('counts the organization credential as durable Claude auth (CYAU-224)', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-ephemeral'
    resetOrgClaudeCredential({load: () => 'sk-ant-oat01-organization', save: () => true, clear: () => true})
    try {
      let seenEnv: NodeJS.ProcessEnv | undefined
      claudeAuthenticated((_s, env) => {
        seenEnv = env
        return ok()
      })
      expect(seenEnv?.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-organization')
      expect(seenEnv?.ANTHROPIC_API_KEY).toBeUndefined()
    } finally {
      delete process.env.ANTHROPIC_API_KEY
      resetOrgClaudeCredential()
    }
  })
})

describe('claudeAuthenticatedAsync', () => {
  it('`claude auth status` process with exit 0 → true', async () => {
    expect(await claudeAuthenticatedAsync({spawn: spawnClosing(0)})).toBe(true)
  })

  it('exit ≠0 (not authenticated or claude missing) → false', async () => {
    expect(await claudeAuthenticatedAsync({spawn: spawnClosing(1)})).toBe(false)
  })
})

describe('setupDep', () => {
  it('already present → already-present', () => {
    expect(setupDep(mise, makeExec(new Set(['mise']))).outcome).toBe('already-present')
  })

  it('dep managed by bootstrap and missing → skipped', () => {
    const result = setupDep(node, makeExec(new Set()))
    expect(result.outcome).toBe('skipped')
    expect(result.detail).toContain('bootstrap')
  })

  it('gh is required and managed by the bootstrap via the pinned mise GitHub backend', () => {
    expect(gh.required).toBe(true)
    expect(gh.managedBy).toBe('bootstrap')
    expect(gh.install.cmd).toMatch(/mise use -g .*github:cli\/cli@2\.102\.0/)
    expect(setupDep(gh, makeExec(new Set())).outcome).toBe('skipped')
  })

  it('required missing + dry-run → skipped with the command', () => {
    const result = setupDep(mise, makeExec(new Set()), {dryRun: true})
    expect(result.outcome).toBe('skipped')
    expect(result.detail).toContain('mise.run')
  })

  it('required missing → installs and verifies', () => {
    expect(setupDep(claude, makeExec(new Set())).outcome).toBe('installed')
  })

  it('failed install → failed', () => {
    const exec: ShellExec = (script) => (/^command -v/.test(script) ? ko() : ko('errore install'))
    expect(setupDep(mise, exec).outcome).toBe('failed')
  })

  it('codex is an optional dep managed by setup, installed via npm @openai/codex', () => {
    expect(codex.required).toBe(false)
    expect(codex.managedBy).toBe('setup')
    expect(codex.install.cmd).toContain('@openai/codex')
    expect(setupDep(codex, makeExec(new Set())).outcome).toBe('skipped') // optional without --optional
    expect(setupDep(codex, makeExec(new Set()), {optional: true}).outcome).toBe('installed')
  })

  it('python is required, probed and provisionable via mise for the atomic helpers', () => {
    expect(python).toMatchObject({bin: 'python3', required: true, managedBy: 'setup'})
    expect(python.install.cmd).toContain('mise use -g python@')
    expect(setupDep(python, makeExec(new Set())).outcome).toBe('installed')
  })

  // CYAU-136: jq is required by the delivery scripts (deliver.sh/lib.sh) and provisionable via mise like
  // python. `setup` installs it on a new machine, without manual steps (it had been installed by hand
  // on server-minion-1 on 2026-08-06 to unblock the queue).
  it('jq is required and provisionable via mise for the delivery scripts', () => {
    expect(jq).toMatchObject({bin: 'jq', required: true, managedBy: 'setup'})
    expect(jq.install.cmd).toContain('mise use -g jq@')
    expect(setupDep(jq, makeExec(new Set())).outcome).toBe('installed')
  })

  it('installed but not detected in PATH → failed', () => {
    // install "succeeds" (code 0) but the bin is still missing at re-probe
    const exec: ShellExec = (script) => (/^command -v/.test(script) ? ko() : ok())
    expect(setupDep(mise, exec).outcome).toBe('failed')
  })

  it('installed and present but with failed version probe → failed', () => {
    let installed = false
    const exec: ShellExec = (script) => {
      if (/^command -v python3/.test(script)) return installed ? ok('/bin/python3') : ko()
      if (/mise use -g python@/.test(script)) {
        installed = true
        return ok()
      }
      if (/python3 --version/.test(script)) return ko('python non avviabile')
      return ok()
    }

    expect(setupDep(python, exec).outcome).toBe('failed')
  })

  // CYAU-5: the fix doctor suggests ("automator setup") must be workable also for a CLI
  // present in PATH but NOT usable (failed `--version`, e.g. broken binary): it is not already-present.
  it('CLI present but failed `--version` → (re)installed, not already-present', () => {
    let reinstalled = false
    const exec: ShellExec = (script) => {
      if (/^command -v/.test(script)) return ok('/bin/claude') // present in PATH
      if (/--version/.test(script)) return reinstalled ? ok('1.2.3') : ko() // broken until reinstalled
      if (/claude\.ai/.test(script)) {
        reinstalled = true
        return ok()
      }
      return ok()
    }
    expect(setupDep(claude, exec).outcome).toBe('installed')
  })

  it('CLI present but failed `--version` + dry-run → shows the command (not already-present)', () => {
    const exec: ShellExec = (script) => {
      if (/^command -v/.test(script)) return ok('/bin/claude')
      if (/--version/.test(script)) return ko()
      return ok()
    }
    const result = setupDep(claude, exec, {dryRun: true})
    expect(result.outcome).toBe('skipped')
    expect(result.detail).toContain('claude.ai')
  })
})
