import {spawn, spawnSync, type ChildProcess} from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

import {describe, expect, it} from 'vitest'

const repoRoot = path.resolve(import.meta.dirname, '..')
const railsRootValue = process.env.CLOSEYOURIT_RAILS_ROOT?.trim()
const required = process.env.AUTOMATOR_MULTI_HOST_E2E_REQUIRED === '1'
// The queue pipeline is skill-mode-only (clean break CYAU-94). The per-agent fan-out was REMOVED (CYAU-90
// item 1: one queue target per project + claim-until-empty) and the rails fixture is host-first (setup/verify), so
// the E2E now REALLY claims against a real rails. It stays NOT enableable until the cycle runs in skill-mode:
// it needs `AUTOMATOR_SKILLS_ENABLED` + a `closeyourit-skills` bundle + a skill-aware fake `claude` (without them, the
// host-first preflight fails closed with skill-mode not enabled). That setup is the dedicated step of CYAU-90.
const CYAU_87_QUEUE_ADAPTER_READY = false

// No silent cap (CYAU-84): an EXPLICIT opt-in `AUTOMATOR_MULTI_HOST_E2E_REQUIRED=1` must not pass as a silent
// skip while the adapter is blocked — otherwise the CI turns green without having run a required test.
// We fail honestly: whoever sets REQUIRED knows the E2E is not runnable yet (remove the flag) or completes the
// E2E skill-mode setup (CYAU-90) and sets the flag back to `true`.
// The implicit opt-in via CLOSEYOURIT_RAILS_ROOT stays a benign skip (it is not a CI gate request).
if (required && !CYAU_87_QUEUE_ADAPTER_READY) {
  describe('multi-host e2e — richiesto ma bloccato (skill-mode setup, CYAU-90)', () => {
    it('AUTOMATOR_MULTI_HOST_E2E_REQUIRED=1 is not runnable yet: the skill-mode setup is missing (CYAU-90)', () => {
      throw new Error(
        'multi-host E2E richiesto (AUTOMATOR_MULTI_HOST_E2E_REQUIRED=1) ma il ciclo coda è skill-mode-only e il ' +
          'setup skill-mode dell\'E2E (bundle + fake claude skill-aware) non è pronto. Rimuovi il flag o completa CYAU-90.',
      )
    })
  })
}

const suite = CYAU_87_QUEUE_ADAPTER_READY && (railsRootValue || required) ? describe : describe.skip

interface Metadata {
  organization_id: string
  project_id: string
  project_key: string
  ticket_id: string
  ticket_code: string
  agent_id: string
  org_token: string
  user_token: string
  hosts: Record<'a' | 'b', {id: string; token: string}>
}

interface ServerReport {
  ticket_status: string
  ticket_comments: string[]
  attempt_statuses: string[]
  active_leases: number
  host_ids_seen: string[]
}

interface ManagedProcess {
  child: ChildProcess
  output(): string
}

function checked(
  command: string,
  args: string[],
  options: {cwd: string; env?: NodeJS.ProcessEnv; timeout?: number},
): string {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    timeout: options.timeout ?? 120_000,
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result.status !== 0 || result.error) {
    const raw = `${result.error?.message ?? ''}\n${result.stderr ?? ''}\n${result.stdout ?? ''}`.trim()
    const detail = raw.length > 6000 ? `${raw.slice(0, 2000)}\n…\n${raw.slice(-4000)}` : raw
    throw new Error(`${path.basename(command)} ${args[0] ?? ''} fallito: ${detail}`)
  }
  return result.stdout
}

function start(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): ManagedProcess {
  const child = spawn(command, args, {cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe']})
  let output = ''
  const collect = (chunk: Buffer | string): void => {
    output = `${output}${chunk.toString()}`.slice(-256_000)
  }
  child.stdout?.on('data', collect)
  child.stderr?.on('data', collect)
  return {child, output: () => output}
}

function killGroup(subject: ManagedProcess | undefined, signal: NodeJS.Signals): void {
  const pid = subject?.child.pid
  if (!pid) return
  try {
    process.kill(-pid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

async function waitFor(label: string, predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`timeout: ${label}`)
}

async function waitExit(subject: ManagedProcess | undefined, timeoutMs = 10_000): Promise<void> {
  if (!subject || subject.child.exitCode !== null || subject.child.signalCode !== null) return
  await Promise.race([
    new Promise<void>((resolve) => subject.child.once('exit', () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ])
}

async function freePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('porta test non disponibile')
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return address.port
}

function executable(target: string, source: string): void {
  fs.copyFileSync(source, target)
  fs.chmodSync(target, 0o755)
}

function writeExecutable(target: string, content: string): void {
  fs.writeFileSync(target, content, {mode: 0o755})
}

function resolveCliRoot(): string {
  const explicit = process.env.CLOSEYOURIT_CLI_ROOT?.trim()
  const candidates = [
    explicit,
    path.resolve(repoRoot, '..', 'closeyourit-cli'),
    path.resolve(repoRoot, '..', '..', 'closeyourit-cli'),
  ].filter((entry): entry is string => Boolean(entry))
  const match = candidates.find((entry) => fs.existsSync(path.join(entry, 'package.json')))
  if (!match) throw new Error('checkout closeyourit-cli non trovato; imposta CLOSEYOURIT_CLI_ROOT')
  return match
}

function railsEnv(root: string, metadata: string, runKey: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    RAILS_ENV: 'test',
    AUTOMATOR_E2E_METADATA: metadata,
    AUTOMATOR_E2E_RUN_KEY: runKey,
  }
  // The Rails test must use only database.yml:test, never URLs inherited from the shell.
  for (const key of ['DATABASE_URL', 'QUEUE_DATABASE_URL', 'CACHE_DATABASE_URL', 'CABLE_DATABASE_URL', 'CLOSEYOURIT_ENVIRONMENT']) {
    delete env[key]
  }
  env.BUNDLE_GEMFILE = path.join(root, 'Gemfile')
  return env
}

suite('ciclo ticket multi-host — Rails, CLI e processi reali', () => {
  it('a single host implements and the winner resumes review/delivery after a crash', async () => {
    if (!railsRootValue) throw new Error('CLOSEYOURIT_RAILS_ROOT è obbligatorio per test:e2e:multi-host')
    const railsRoot = path.resolve(railsRootValue)
    const cliRoot = resolveCliRoot()
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-multi-host-e2e-'))
    const metadataFile = path.join(root, 'metadata.json')
    const reportFile = path.join(root, 'server-report.json')
    const eventLog = path.join(root, 'events.log')
    const controlDir = path.join(root, 'control')
    const remote = path.join(root, 'remote.git')
    const cliConfig = path.join(root, 'cyi-config')
    const fakeBin = path.join(root, 'bin')
    const codexBin = path.join(root, 'codex', 'bin')
    const runKey = `${process.pid}-${Date.now()}`
    const trustedReviewerBin = path.join(os.homedir(), '.local', 'bin', `automator-e2e-review-${runKey}`)
    const processes: ManagedProcess[] = []
    let server: ManagedProcess | undefined

    fs.mkdirSync(controlDir, {recursive: true})
    fs.mkdirSync(cliConfig, {recursive: true})
    fs.mkdirSync(fakeBin, {recursive: true})
    fs.mkdirSync(codexBin, {recursive: true})
    fs.mkdirSync(trustedReviewerBin, {recursive: true, mode: 0o700})

    try {
      expect(fs.existsSync(path.join(railsRoot, 'app', 'controllers', 'api', 'v1', 'agents', 'ticket_queue_claims_controller.rb')))
        .toBe(true)

      checked('mise', ['trust', 'mise.toml'], {cwd: repoRoot})
      checked('mise', ['exec', '--', 'pnpm', 'build'], {cwd: repoRoot})
      checked('mise', ['trust', 'mise.toml'], {cwd: cliRoot})
      checked('mise', ['exec', '--', 'pnpm', 'build'], {cwd: cliRoot})

      const baseCommit = checked('git', ['rev-parse', 'HEAD'], {cwd: repoRoot}).trim()
      checked('git', ['init', '--bare', remote], {cwd: root})
      checked('git', ['--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main'], {cwd: root})
      checked('git', ['push', remote, `${baseCommit}:refs/heads/main`], {cwd: repoRoot})

      const rubyEnv = railsEnv(railsRoot, metadataFile, runKey)
      checked('mise', ['exec', '--', 'bin/rails', 'db:test:prepare'], {cwd: railsRoot, env: rubyEnv, timeout: 180_000})
      checked('mise', ['exec', '--', 'bin/rails', 'runner', '-e', 'test', path.join(repoRoot, 'test', 'e2e', 'rails', 'setup.rb')], {
        cwd: railsRoot,
        env: rubyEnv,
        timeout: 180_000,
      })
      const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8')) as Metadata

      const port = await freePort()
      const apiUrl = `http://127.0.0.1:${port}`
      server = start('mise', ['exec', '--', 'bin/rails', 'server', '-e', 'test', '-p', String(port), '-b', '127.0.0.1'], railsRoot, rubyEnv)
      processes.push(server)
      await waitFor('boot server Rails test', async () => {
        try {
          return (await fetch(`${apiUrl}/up`)).ok
        } catch {
          return false
        }
      }, 60_000)

      fs.writeFileSync(path.join(cliConfig, 'config.json'), `${JSON.stringify({apiUrl, token: metadata.user_token})}\n`, {mode: 0o600})

      executable(path.join(codexBin, 'codex'), path.join(repoRoot, 'test', 'e2e', 'codex.mjs'))
      writeExecutable(path.join(codexBin, 'node'), `#!/bin/sh\nexec '${process.execPath}' "$@"\n`)
      executable(path.join(fakeBin, 'gh'), path.join(repoRoot, 'test', 'e2e', 'gh.mjs'))
      executable(path.join(fakeBin, 'cyi'), path.join(repoRoot, 'test', 'e2e', 'cyi.mjs'))
      executable(path.join(fakeBin, 'claude'), path.join(repoRoot, 'test', 'e2e', 'claude-implementer.mjs'))
      const codexReviewer = fs.readFileSync(path.join(repoRoot, 'test', 'e2e', 'codex-reviewer.mjs'), 'utf8')
      writeExecutable(path.join(trustedReviewerBin, 'codex'), `#!${process.execPath}\n${codexReviewer}`)
      fs.mkdirSync(path.join(trustedReviewerBin, 'bin'), {recursive: true, mode: 0o700})
      fs.symlinkSync(process.execPath, path.join(trustedReviewerBin, 'bin', 'node'))

      const sharedEnv: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: `${codexBin}:${fakeBin}:${trustedReviewerBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
        CLOSEYOURIT_CONFIG_DIR: cliConfig,
        E2E_CYI_BIN: path.join(cliRoot, 'bin', 'run.js'),
        E2E_EVENT_LOG: eventLog,
        E2E_CONTROL_DIR: controlDir,
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'protocol.file.allow',
        GIT_CONFIG_VALUE_0: 'always',
      }
      delete sharedEnv.CLOSEYOURIT_RAILS_ROOT
      delete sharedEnv.AUTOMATOR_MULTI_HOST_E2E_REQUIRED

      const hostContexts = (['a', 'b'] as const).map((label) => {
        const hostRoot = path.join(root, `host-${label}`)
        const configDir = path.join(hostRoot, 'config')
        const stateDir = path.join(hostRoot, 'state')
        const dataDir = path.join(hostRoot, 'data')
        const home = path.join(hostRoot, 'home')
        fs.mkdirSync(configDir, {recursive: true})
        fs.mkdirSync(home, {recursive: true})
        const secretsFile = path.join(configDir, 'secrets.json')
        const secrets = {
          sync: {apiUrl, orgToken: metadata.org_token},
          hosts: {[metadata.project_key]: {cwd: repoRoot}},
          host: metadata.hosts[label],
          hostFingerprint: `e2e-${runKey}-${label}`,
        }
        fs.writeFileSync(secretsFile, `${JSON.stringify(secrets)}\n`, {mode: 0o600})
        const env: NodeJS.ProcessEnv = {
          ...sharedEnv,
          HOME: home,
          AUTOMATOR_CONFIG_DIR: configDir,
          AUTOMATOR_STATE_DIR: stateDir,
          AUTOMATOR_DATA_DIR: dataDir,
          CODEX_HOME: path.join(home, '.codex'),
          E2E_HOST_LABEL: label,
        }
        return {label, configDir, stateDir, dataDir, secretsFile, secrets, env}
      })

      for (const host of hostContexts) {
        const managedRepo = path.join(host.dataDir, 'repositories', 'closeyourit', 'automator')
        fs.mkdirSync(path.dirname(managedRepo), {recursive: true})
        checked('git', ['clone', remote, managedRepo], {cwd: root, env: host.env})
        checked('git', ['remote', 'set-url', 'origin', 'https://github.com/closeyourit/automator.git'], {cwd: managedRepo, env: host.env})
        checked('git', ['remote', 'set-url', '--add', '--push', 'origin', remote], {cwd: managedRepo, env: host.env})
        checked(process.execPath, [path.join(repoRoot, 'bin', 'run.js'), 'workspace', metadata.project_key, metadata.ticket_code, '--json'], {
          cwd: repoRoot,
          env: host.env,
          timeout: 120_000,
        })
        const worktree = path.join(host.dataDir, 'worktrees', metadata.project_key, metadata.ticket_code)
        expect(checked('git', ['remote', 'get-url', 'origin'], {cwd: managedRepo, env: host.env}).trim())
          .toBe('https://github.com/closeyourit/automator.git')
        host.secrets.hosts[metadata.project_key].cwd = managedRepo
        fs.writeFileSync(host.secretsFile, `${JSON.stringify(host.secrets)}\n`, {mode: 0o600})
        fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(worktree, 'node_modules'))
        checked('mise', ['trust', 'mise.toml'], {cwd: worktree})
      }
      // The policy stays the canonical one and is attested by the daemon. Only the execution of the three expensive commands
      // is a bounded fixture; the real full suite runs separately in the repository job/test.
      executable(path.join(fakeBin, 'mise'), path.join(repoRoot, 'test', 'e2e', 'mise.mjs'))

      const daemons = Object.fromEntries(hostContexts.map((host) => {
        const daemon = start(process.execPath, [path.join(repoRoot, 'bin', 'run.js'), 'daemon', '--interval', '1'], repoRoot, host.env)
        processes.push(daemon)
        return [host.label, daemon]
      })) as Record<'a' | 'b', ManagedProcess>

      try {
        await waitFor('delivery raggiunta dal daemon vincitore', () => {
          if (fs.existsSync(path.join(controlDir, 'delivery-crashed'))) return true
          if (!fs.existsSync(eventLog)) return false
          const implementations = fs.readFileSync(eventLog, 'utf8').split('\n').filter((event) => event.endsWith(':implement'))
          if (implementations.length > 1) throw new Error('più di una implementazione prima della delivery')
          return false
        }, 180_000)
      } catch (error) {
        const eventSummary = fs.existsSync(eventLog) ? fs.readFileSync(eventLog, 'utf8').slice(-4000) : '(nessun evento)'
        const runSummary = hostContexts.flatMap((host) => {
          const runsDir = path.join(host.stateDir, 'runs')
          if (!fs.existsSync(runsDir)) return []
          return fs.readdirSync(runsDir).filter((file) => file.endsWith('.json')).map((file) => {
            const run = JSON.parse(fs.readFileSync(path.join(runsDir, file), 'utf8')) as Record<string, any>
            const checkpoint = run.checkpoints?.at(-1)
            return {
              host: host.label,
              phases: run.checkpoints?.map((entry: Record<string, any>) => entry.phase),
              outcome: checkpoint?.outcome,
              gate: checkpoint?.automation?.gate?.verdict,
              checks: checkpoint?.automation?.gate?.checks,
              reviewStatus: checkpoint?.automation?.reviewExecution?.status,
              reviewVerdict: checkpoint?.automation?.reviewVerdict?.verdict,
              cycleNext: checkpoint?.automation?.cycleDecision?.next,
            }
          })
        })
        throw new Error(`${(error as Error).message}\nrun:\n${JSON.stringify(runSummary, null, 2)}\neventi:\n${eventSummary}\ndaemon a:\n${daemons.a.output().slice(-8000)}\ndaemon b:\n${daemons.b.output().slice(-8000)}`)
      }
      const winner = fs.readFileSync(path.join(controlDir, 'delivery-crashed'), 'utf8').trim() as 'a' | 'b'
      expect(['a', 'b']).toContain(winner)
      const loser = winner === 'a' ? 'b' : 'a'

      killGroup(daemons[winner], 'SIGKILL')
      killGroup(daemons[loser], 'SIGTERM')
      await Promise.all([waitExit(daemons[winner]), waitExit(daemons[loser])])

      checked('mise', ['exec', '--', 'bin/rails', 'runner', '-e', 'test', path.join(repoRoot, 'test', 'e2e', 'rails', 'expire.rb')], {
        cwd: railsRoot,
        env: rubyEnv,
        timeout: 120_000,
      })

      const winnerContext = hostContexts.find((host) => host.label === winner)!
      const restarted = start(
        process.execPath,
        [path.join(repoRoot, 'bin', 'run.js'), 'daemon', '--interval', '1'],
        repoRoot,
        winnerContext.env,
      )
      processes.push(restarted)
      await waitFor('delivery completata dopo il restart', () => {
        if (!fs.existsSync(eventLog)) return false
        const events = fs.readFileSync(eventLog, 'utf8')
        // CYAU-174 — the last remote effect of the delivery is the comment with the PR URL: the status
        // is no longer moved by the program on the machine, so there is no `tickets status` event any more.
        return fs.existsSync(path.join(controlDir, 'pr-created')) && events.includes(':cyi tickets comment ')
      }, 180_000)
      await new Promise((resolve) => setTimeout(resolve, 1000))
      killGroup(restarted, 'SIGTERM')
      await waitExit(restarted)

      const verifyEnv = {...rubyEnv, AUTOMATOR_E2E_REPORT: reportFile}
      checked('mise', ['exec', '--', 'bin/rails', 'runner', '-e', 'test', path.join(repoRoot, 'test', 'e2e', 'rails', 'verify.rb')], {
        cwd: railsRoot,
        env: verifyEnv,
        timeout: 120_000,
      })
      const report = JSON.parse(fs.readFileSync(reportFile, 'utf8')) as ServerReport
      const events = fs.readFileSync(eventLog, 'utf8').trim().split('\n')
      const winnerRunsDir = path.join(winnerContext.stateDir, 'runs')
      const runRecords = fs.readdirSync(winnerRunsDir)
        .filter((file) => file.endsWith('.json'))
        .map((file) => JSON.parse(fs.readFileSync(path.join(winnerRunsDir, file), 'utf8')) as Record<string, any>)
      const adopted = runRecords.find((record) => typeof record.adopted_from === 'string')
      const finalCheckpoint = adopted?.checkpoints?.at(-1)

      expect(events.filter((event) => event.endsWith(':implement'))).toEqual([`${winner}:implement`])
      expect(events.filter((event) => event.endsWith(':delivery-crash'))).toEqual([`${winner}:delivery-crash`])
      expect(events.filter((event) => event.endsWith(':pr-create'))).toEqual([`${winner}:pr-create`])
      expect(events.some((event) => event.includes(':cyi kb search '))).toBe(true)
      expect(events.some((event) => event.includes(':cyi tickets comment '))).toBe(true)
      // CYAU-174 — the program's hand on the status lever is removed end-to-end: no machine moves it.
      expect(events.some((event) => event.includes(':cyi tickets status '))).toBe(false)

      expect(runRecords.some((record) => record.checkpoints?.at(-1)?.phase === 'in_review')).toBe(true)
      expect(adopted?.adopted_from).toBeTypeOf('string')
      expect(finalCheckpoint?.phase).toBe('completed')
      expect(finalCheckpoint?.automation?.gate?.verdict?.passed).toBe(true)
      expect(finalCheckpoint?.automation?.reviewExecution?.status).toBe('completed')
      expect(finalCheckpoint?.automation?.delivery?.delivery).toMatchObject({
        pushed: true,
        prCreated: true,
        linked: true,
      })

      // The status still reaches In Review, but the server writes it when recording the delivery: it is the proof that
      // removing the program's hand does not leave the ticket behind.
      expect(report.ticket_status).toBe('in_review')
      expect(report.ticket_comments.some((body) => body.includes('https://github.com/closeyourit/automator/pull/56'))).toBe(true)
      // Host-first (CYAU-90): the claimed and executed phase is an Attempt approved by the server, not a per-agent run.
      expect(report.attempt_statuses).toContain('approved')
      expect(report.active_leases).toBe(0)
      expect(report.host_ids_seen).toHaveLength(2)

      expect(checked('git', ['--git-dir', remote, 'rev-parse', `refs/heads/ticket/${metadata.ticket_code}`], {cwd: root}).trim())
        .toMatch(/^[0-9a-f]{40}$/)
      expect(checked('git', ['--git-dir', remote, 'show', `refs/heads/ticket/${metadata.ticket_code}:E2E_RESULT.md`], {cwd: root}))
        .toContain('Implementazione idempotente')
      expect(daemons[loser].output()).toMatch(/coda ticket vuota|già in lavorazione|max-parallel/i)
    } finally {
      for (const subject of processes) killGroup(subject, 'SIGKILL')
      await Promise.all(processes.map((subject) => waitExit(subject, 2000)))
      fs.rmSync(root, {recursive: true, force: true})
      fs.rmSync(trustedReviewerBin, {recursive: true, force: true})
    }
  }, 12 * 60_000)
})
