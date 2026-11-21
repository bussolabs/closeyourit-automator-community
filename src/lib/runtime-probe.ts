import * as os from 'node:os'
import {buildClaudeArgv, CLAUDE_BIN} from './claude'
import {buildCodexArgv, CODEX_BIN} from './codex'
import {activeManagedGuardrailPaths} from './managed-service'
import {guardrailsSettingsPath} from './paths'
import {runProcessProbe, type ProcessProbeOptions, type ProcessProbeResult} from './process-probe'
import {CLAUDE_LOCAL_AUTH_ENV} from './env-capabilities'
import {claudeAuthEnv} from './org-claude-credential'
import {describeRuntimeFailure} from './runtime-failure'
import {RUNTIME_IDS, type RuntimeId} from './route'
import {type ClaudeActionT, type CodexActionT} from './schema'

// REAL probe of both runtimes: a minimal request with the same arguments as the sessions (pinned model,
// guardrails, sandbox). `codex login status` and `--version` say the CLI is there, not that the model answers:
// on 23/09 they said "Logged in" with the login revoked, and the machine burned 44 sessions.

export type RuntimeReadiness = {ready: true} | {ready: false; detail: string}
export type ProbeRun = (cmd: string, args: string[], options: ProcessProbeOptions) => Promise<ProcessProbeResult>

const PROMPT = 'Rispondi solo: OK'
const TIMEOUT_MS = 120_000

/**
 * CYAU-305 — `runtimes` are the engines to probe: the claim passes the ones this machine uses. Without it both are
 * probed, which is what the diagnosis and the update do.
 */
export async function probeAgentRuntimes(deps: {run?: ProbeRun; settingsPath: string; runtimes?: readonly RuntimeId[]}): Promise<RuntimeReadiness> {
  const run = deps.run ?? runProcessProbe
  const runtimes = deps.runtimes ?? RUNTIME_IDS
  const options: ProcessProbeOptions = {cwd: os.tmpdir(), env: process.env, timeoutMs: TIMEOUT_MS, maxCaptureBytes: 65_536}

  const claudeArgs = buildClaudeArgv({type: 'claude', run: PROMPT, permission_mode: 'plan'} as ClaudeActionT, deps.settingsPath)
  // `--json` also brings the errors to stdout, the only channel the probe captures.
  const codexArgs = buildCodexArgv({type: 'codex', run: PROMPT, sandbox: 'read-only'} as CodexActionT)
  codexArgs.splice(codexArgs.indexOf('--'), 0, '--ephemeral', '--skip-git-repo-check')

  // CYAU-224: Claude is probed with the same auth its sessions get.
  const claudeOptions = {...options, env: {...withoutClaudeAuth(process.env), ...claudeAuthEnv(process.env)}}
  const [claude, codex] = await Promise.all([
    runtimes.includes('claude') ? run(CLAUDE_BIN, claudeArgs, claudeOptions) : null,
    runtimes.includes('codex') ? run(CODEX_BIN, codexArgs, options) : null,
  ])
  const failures = [
    !claude || claudeAnswered(claude) ? null : describeRuntimeFailure('claude', claude.stdout, exitLabel(claude)),
    !codex || (codex.code === 0 && codex.stdout.includes('"type":"turn.completed"')) ? null : describeRuntimeFailure('codex', codex.stdout, exitLabel(codex)),
  ].filter((failure): failure is string => failure !== null)
  return failures.length === 0 ? {ready: true} : {ready: false, detail: failures.join('; ')}
}

function withoutClaudeAuth(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = {...env}
  for (const key of CLAUDE_LOCAL_AUTH_ENV) delete copy[key]
  return copy
}

function claudeAnswered(result: ProcessProbeResult): boolean {
  if (result.code !== 0) return false
  try {
    return (JSON.parse(result.stdout) as {is_error?: unknown}).is_error === false
  } catch {
    return false
  }
}

function exitLabel(result: ProcessProbeResult): string {
  return result.code === null ? 'timeout' : `exit ${result.code}`
}

export type CachedReadiness = ((runtimes?: readonly RuntimeId[]) => Promise<RuntimeReadiness>) & {invalidate(): void}

/**
 * A successful probe is valid for an hour; a failed one is repeated after five minutes, so a new login is seen
 * soon. Concurrent requests (several queues in the same round) share the same probe. `invalidate`
 * discards the outcome: whoever saw a runtime fail calls it, because the probe from an hour ago no longer holds.
 *
 * CYAU-305 — an outcome holds only for the same engines it probed: a green probe of Codex alone says nothing
 * about Claude, so a different set probes again.
 */
export function cachedRuntimeReadiness(
  probe: (runtimes: readonly RuntimeId[]) => Promise<RuntimeReadiness>,
  opts: {now?: () => number; okTtlMs?: number; failTtlMs?: number} = {},
): CachedReadiness {
  const now = opts.now ?? Date.now
  const okTtlMs = opts.okTtlMs ?? 60 * 60_000
  const failTtlMs = opts.failTtlMs ?? 5 * 60_000
  let last: {key: string; at: number; result: RuntimeReadiness} | undefined
  const inflight = new Map<string, Promise<RuntimeReadiness>>()
  const check = (requested: readonly RuntimeId[] = RUNTIME_IDS) => {
    const runtimes = RUNTIME_IDS.filter((runtime) => requested.includes(runtime))
    const key = runtimes.join(',')
    if (last && last.key === key && now() - last.at < (last.result.ready ? okTtlMs : failTtlMs)) return Promise.resolve(last.result)
    const running = inflight.get(key)
    if (running) return running
    const pending = probe(runtimes)
      .catch((): RuntimeReadiness => ({ready: false, detail: 'prova dei runtime non eseguibile'}))
      .then((result) => {
        last = {key, at: now(), result}
        return result
      })
      .finally(() => {
        inflight.delete(key)
      })
    inflight.set(key, pending)
    return pending
  }
  return Object.assign(check, {invalidate: () => { last = undefined }})
}

/** The process-wide probe: a single one, shared between the claim and whoever sees a review fail. */
export const agentRuntimeReadiness = cachedRuntimeReadiness((runtimes) => probeAgentRuntimes({
  settingsPath: activeManagedGuardrailPaths().settingsPath ?? guardrailsSettingsPath(),
  runtimes,
}))
