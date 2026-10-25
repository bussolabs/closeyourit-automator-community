import {type HostActivity, readHostActivity} from './activity'
import {hasOperationalHostIdentity, isHostToken, type HeartbeatConfig, type Secrets} from './config'
import {probeAll, type ProbeResult} from './deps'
import path from 'node:path'
import {skillsDir, skillsModeEnabled, skillsPluginDir} from './paths'
import {activeBundleIdentity, defaultSkillsGit, type ActiveBundleIdentity} from './skills-manifest'
import {redactSecrets} from './secret-redaction'
import {readUpdateFailure, type UpdateFailureStop} from './update-outcome'
import {detectPlatform} from './service'

// Heartbeat to CloseYourIt: POST check_in to a cron monitor. Zero-config server-side (the monitor
// is born at the first ping); if the daemon dies, the pings stop and CloseYourIt raises the `cron_missed` alert.
// Best-effort: a network failure must NEVER kill the daemon.
//
// Besides the monitor state, the ping attaches the host's CAPABILITIES and LOAD (automator version,
// platform, available runtimes, served repositories, running runs/slots) so CloseYourIt knows what the
// machine can do and how busy it is. Never secrets in the payload: only public data or data already known to the server.
//
// It also attaches the ACTIVITY SNAPSHOT (CYAU-31): for every active run the ticket, the phase, the
// runtime, the start and the lease state, plus an aggregate operational state → so the dashboard identifies
// which host works each ticket and makes blocked runs evident. The STATIC capabilities are composed once
// (stable for the process lifetime); the activity is DYNAMIC → recomputed at every beat.

const DEFAULT_API = 'https://app.closeyour.it'

// Contract with the `cron_missed` watchdog: if the pings thin out beyond interval+grace, the host is offline.
// Do NOT touch without aligning the Rails-side monitor — it is what makes "a host not updated → offline".
const EXPECTED_INTERVAL_MINUTES = 2
const GRACE_MINUTES = 1

export type FetchFn = typeof globalThis.fetch

// Health of a single runtime/tool (which ones the host can use): name, presence and version. It derives from the
// DEPS probe but does NOT expose the internal `bin` — it is only capability, never a secret.
export interface RuntimeHealth {
  name: string
  present: boolean
  version: string | null
  required: boolean
}

// Host capabilities and state attached to the heartbeat. No sensitive field: no token, no local
// paths (`cwd`), no references to secret providers — only what the machine can do and how loaded it is.
export interface HostCapabilities {
  // Registered Agent Host id → the server attributes the ping and the snapshot to THIS machine (CYAU-31).
  // The check_in is authenticated with the host token, which stays in the header and never enters the payload.
  host_id?: string
  automator_version?: string // automator version (omitted if unknown)
  platform: string // always linux in production
  arch: string // process.arch (arm64/x64)
  runtimes: RuntimeHealth[] // runtime health: which tools are installed and at which version
  repositories: string[] // project keys served by THIS machine (only the host map keys, not the paths)
  running: number // runs in progress at ping time
  slots: number // concurrent run capacity
}

// Runtime health via the DEPS probe: maps the ProbeResult to the public contract (discards the `bin`).
export function collectRuntimes(probe: () => ProbeResult[] = probeAll): RuntimeHealth[] {
  return probe().map((r) => ({name: r.name, present: r.present, version: r.version, required: r.required}))
}

/**
 * CYAU-170 — the machine declares WHICH manual it is running.
 *
 * Until now the beat sent nine tools (mise, node, python, pnpm, cyi, claude, codex, gh, jq) and the
 * instructions bundle was not among them: from the panel nobody could know whether a machine was
 * working with the right instructions or with those of three weeks ago.
 *
 * The fingerprint travels inside `version` — "<version> (<12-char sha>)" — and not in a new field: the server
 * discards the keys it does not know (`params.permit`, `normalize_runtimes`), so a new field
 * would arrive and be silently thrown away. The contract stays as it is.
 *
 * The sha, not only the name: a moved pin keeps the same version and changes commit, and whoever compares
 * the names sees two identical things that are not identical.
 */
export function skillsBundleRuntime(
  identity: ActiveBundleIdentity | null = executedBundleIdentity(),
  required: boolean = skillsModeEnabled(),
): RuntimeHealth {
  return {
    name: 'closeyourit-skills',
    present: identity !== null,
    version: identity ? `${identity.version} (${identity.sha.slice(0, 12)})` : null,
    required,
  }
}

/**
 * The fingerprint of the bundle this machine REALLY runs. With `AUTOMATOR_SKILLS_DIR` the path is
 * forced and there is no `current` symlink to read: declaring the fingerprint of `skills/current`
 * would mean telling the panel a different manual from the one running.
 */
function executedBundleIdentity(): ActiveBundleIdentity | null {
  const eseguito = skillsPluginDir()
  const predefinito = path.join(skillsDir(), 'current')
  if (eseguito === predefinito) return activeBundleIdentity()

  const git = defaultSkillsGit()
  if (!git.exists(eseguito) || !git.isGitCheckout(eseguito)) return null
  try {
    const sha = git.headSha(eseguito)
    return sha ? {version: path.basename(eseguito), sha, directory: eseguito} : null
  } catch {
    return null
  }
}

export interface CapabilitiesInput {
  version?: string
  hostId?: string // host.id (Agent Host identity); in the payload as `host_id` for server-side attribution
  hosts?: Secrets['hosts'] // local host map; ONLY its keys are extracted here (the served repositories)
  runtimes?: RuntimeHealth[] // injectable in tests; default: real DEPS probe
  platform?: string // test seam; in production detectPlatform() accepts only Linux
  arch?: string // default process.arch
  running?: number // default 0 — the ping starts at the end of the tick (single-lock execution): no run in progress
  slots?: number // default 1 — current concurrent capacity (one tick at a time, single lock)
}

// Composes the host capabilities/state. `repositories` are ONLY the host map keys (project keys):
// the paths (`cwd`) and the secret references stay out → capabilities without secrets (DoD).
export function buildCapabilities(input: CapabilitiesInput = {}): HostCapabilities {
  return {
    ...(input.hostId ? {host_id: input.hostId} : {}),
    ...(input.version ? {automator_version: input.version} : {}),
    platform: input.platform ?? detectPlatform(),
    arch: input.arch ?? process.arch,
    runtimes: input.runtimes ?? collectRuntimes(),
    repositories: Object.keys(input.hosts ?? {}),
    running: input.running ?? 0,
    slots: input.slots ?? 1,
  }
}

// Last preflight block attached to the heartbeat (CYAU-116). When a machine cannot take
// a ticket it releases the lease and the activity snapshot goes back to idle: without this, from the panel a
// host stopped by a block is indistinguishable from one without work. `reason` is UNVALIDATED material (it also contains
// a JSON.stringify of arbitrary values): it must be redacted before sending. `state` is a restricted enum.
export interface PreflightStop {
  action: string
  state: string
  reason: string
}

// The body carries at most the LAST 5 blocks: a tick with several project queues can stop several times, we
// keep the most recent ones (the queue is read in order, the last ones are the most relevant).
const MAX_LAST_STOPS = 5

/**
 * Sanitizes the preflight blocks for the heartbeat payload (CYAU-116): limits to the last 5 and redacts the
 * `reason` (the only unvalidated field, DoD "the reserved values in the reason are removed before sending").
 * `action` is already a sanitized key and `state` a restricted enum → they contain no secrets and stay intact.
 */
export function buildLastStops(stops: readonly PreflightStop[]): PreflightStop[] {
  return stops.slice(-MAX_LAST_STOPS).map((stop) => ({
    action: stop.action,
    state: stop.state,
    reason: redactSecrets(stop.reason),
  }))
}

type BeatPayload = HostCapabilities & Partial<HostActivity> & {last_stops?: PreflightStop[]}

export async function sendHeartbeat(
  cfg: HeartbeatConfig,
  hostToken: string | undefined,
  ok: boolean,
  // Static capabilities + (optional) dynamic activity snapshot + (optional) last preflight blocks:
  // all merge into the body after the monitor fields. The types are optional because a caller can send
  // the capabilities alone (backward compat).
  capabilities?: BeatPayload,
  fetchFn: FetchFn = globalThis.fetch,
): Promise<boolean> {
  return (await postHeartbeat(cfg, hostToken, ok, capabilities, fetchFn)) === null
}

// Only a well-formed server error code reaches the log: the body is untrusted input.
const ERROR_CODE = /^[A-Z][A-Z0-9-]{2,39}$/

/** `null` when the server accepted the beat, otherwise a short reason without secrets (CYAU-247). */
async function postHeartbeat(
  cfg: HeartbeatConfig,
  hostToken: string | undefined,
  ok: boolean,
  capabilities: BeatPayload | undefined,
  fetchFn: FetchFn,
): Promise<string | null> {
  if (!isHostToken(hostToken)) return 'no valid host token'
  const url = `${cfg.apiUrl ?? DEFAULT_API}/api/v1/projects/${cfg.projectId}/crons/${cfg.slug}/check_in`
  let res: Response
  try {
    res = await fetchFn(url, {
      method: 'POST',
      headers: {Authorization: `Bearer ${hostToken}`, 'Content-Type': 'application/json'},
      // The monitor fields come FIRST and do not collide with the capabilities: compatibility with the
      // `cron_missed` watchdog (interval/grace) stays guaranteed even with the enriched payload.
      body: JSON.stringify({
        status: ok ? 'ok' : 'fail',
        environment: cfg.environment ?? 'production',
        expected_interval_minutes: EXPECTED_INTERVAL_MINUTES,
        grace_minutes: GRACE_MINUTES,
        ...(capabilities ?? {}),
      }),
    })
  } catch {
    return 'network error'
  }
  if (res.ok) return null
  const body = (await Promise.resolve().then(() => res.json()).catch(() => null)) as {error?: {code?: unknown}} | null
  const code = body?.error?.code
  return typeof code === 'string' && ERROR_CODE.test(code) ? `HTTP ${res.status} ${code}` : `HTTP ${res.status}`
}

export interface HeartbeatOptions {
  version?: string // automator version (from this.config.version)
  runtimes?: RuntimeHealth[] // injectable in tests; in production: real probe once at construction
  platform?: string // test seam; in production omitted and validated by detectPlatform()
  arch?: string // test seam; in production process.arch
  fetchFn?: FetchFn
  // Activity snapshot provider, called at EVERY beat (the state changes). Default: read from the
  // state dir (`readHostActivity`, best-effort). Injectable in tests → no real disk.
  activity?: () => HostActivity
  /** CYAU-170: bundle entry, injectable in tests. Default: fingerprint read from disk at every beat. */
  skillsBundle?: () => RuntimeHealth
  /**
   * CYAU-202: outcome of the last automatic update, or `null` if it went well. Read at EVERY beat,
   * like the activity: a failure that happened mid-day must appear at once, not at the restart.
   */
  updateFailure?: () => UpdateFailureStop | null
  /** CYAU-247: where a rejected beat is reported, only when the outcome changes. */
  log?: (message: string) => void
}

/**
 * CYAU-220 — why `makeHeartbeat` would return `undefined`, or `null` when the beat can start. Without a beat the
 * panel shows the host as stopped and the server refuses its claims: that must be said in the log, not swallowed.
 * `detail` is the more precise reason the caller may know (e.g. the failed project lookup). Never a secret.
 */
export function heartbeatMissingReason(secrets: Secrets, detail?: string): string | null {
  if (secrets.heartbeat && hasOperationalHostIdentity(secrets)) return null
  const reason = detail ?? (!hasOperationalHostIdentity(secrets)
    ? 'this host is not registered yet'
    : 'secrets.json has no heartbeat section')
  return `heartbeat: not configured — ${reason}. The panel shows this host as stopped and it takes no work; retrying at the next service start`
}

/**
 * Builds the heartbeat callback to pass to runOnce/runDaemon, or `undefined` if not configured.
 * The capabilities (version, platform, runtimes, repositories) are collected ONCE here: stable for the
 * process lifetime (the daemon restarts on changes). The runtime probe does NOT start if the heartbeat is not
 * configured (early return) → no cost when there is nobody to send the ping to.
 *
 * The activity snapshot instead is DYNAMIC: `activity()` is invoked at every beat so the dashboard
 * sees the current phase/lease state of every run (not a snapshot at boot). Best-effort: the
 * state read never throws (degrades to idle) → the beat goes out anyway.
 */
export function makeHeartbeat(secrets: Secrets, opts: HeartbeatOptions = {}): ((ok: boolean, stops?: PreflightStop[]) => Promise<void>) | undefined {
  const cfg = secrets.heartbeat
  if (!cfg || !hasOperationalHostIdentity(secrets)) return undefined
  const capabilities = buildCapabilities({
    version: opts.version,
    hostId: secrets.host.id,
    hosts: secrets.hosts,
    runtimes: opts.runtimes,
    platform: opts.platform,
    arch: opts.arch,
  })
  const activity = opts.activity ?? (() => readHostActivity(secrets))
  // The bundle entry is computed IN HERE, at every beat, and not above together with the capabilities: those
  // are composed only once at startup, and a mid-day promotion would not be visible until the
  // service restart. The nine tools stay static — they change when the machine changes, not
  // during the day.
  const bundle = opts.skillsBundle ?? (() => skillsBundleRuntime())
  const updateFailure = opts.updateFailure ?? (() => readUpdateFailure())
  // One line per change of outcome, not per beat: the daemon beats every minute.
  let lastRejection: string | null = null
  const report = (rejection: string | null) => {
    if (rejection === lastRejection) return
    if (rejection) opts.log?.(`heartbeat rejected by CloseYourIt: ${rejection} (the panel shows this host as stopped)`)
    else opts.log?.('heartbeat accepted again by CloseYourIt')
    lastRejection = rejection
  }
  return async (ok, stops) => {
    // `stops` undefined = the caller does not wire it (or no round completed yet) → field omitted (backward compat).
    // An array (even empty) is instead an observed fact: `[]` explicitly says "no recent block", so
    // the panel can clear a no longer current reason instead of showing a stale one.
    //
    // CYAU-202: the failed update is APPENDED to the round's stops. At the end because `buildLastStops`
    // keeps the last five, and a warning someone must act on must not get lost behind five queue
    // blocks. It alone is enough to make the field appear: a host working no ticket would pass no stop.
    const failure = updateFailure()
    const collected = failure === null ? stops : [...(stops ?? []), failure]
    const lastStops = collected === undefined ? {} : {last_stops: buildLastStops(collected)}
    const runtimes = [...capabilities.runtimes, bundle()]
    report(await postHeartbeat(cfg, secrets.host.token, ok, {...capabilities, runtimes, ...activity(), ...lastStops}, opts.fetchFn ?? globalThis.fetch))
  }
}

/**
 * Composes several host "beats" (monitor heartbeat, lease renewal…) into a single callback for runOnce: at
 * every tick it runs them all, in order and in ISOLATION — a failing beat neither prevents the others nor
 * kills the cycle (best-effort, consistent with the heartbeat that already swallows network errors). Returns
 * `undefined` if no beat is configured → runOnce skips the call entirely (backward compat).
 */
export function combineBeats(
  ...beats: Array<((ok: boolean, stops?: PreflightStop[]) => Promise<void>) | undefined>
): ((ok: boolean, stops?: PreflightStop[]) => Promise<void>) | undefined {
  const active = beats.filter((beat): beat is (ok: boolean, stops?: PreflightStop[]) => Promise<void> => beat !== undefined)
  if (active.length === 0) return undefined
  return async (ok, stops) => {
    for (const beat of active) {
      try {
        await beat(ok, stops)
      } catch {
        // Best-effort: a failed beat stops neither the others nor the daemon cycle.
      }
    }
  }
}
