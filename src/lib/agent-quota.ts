import {spawn as nodeSpawn} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {randomUUID} from 'node:crypto'
import {CODEX_BIN} from './codex'
import {claudeAuthEnv} from './org-claude-credential'
import {quotaPausePath} from './paths'

// CYAU-275 — a quota limit is a PAUSE with a resume time, not a failure. The quota belongs to the machine's
// account, not to the ticket, so the pause lives here: one record per engine with the time it resumes. The
// claim gate reads it, together with the real remaining quota, before asking for work — asking costs a ticket.

export type QuotaRuntime = 'claude' | 'codex'

/** Below this share of quota left (in any window) the machine takes no new work. */
export const QUOTA_MIN_REMAINING_PERCENT = 10
/** Wait when the limit does not say when it resets. */
export const QUOTA_FALLBACK_PAUSE_MS = 30 * 60_000
/** Longest credible pause: the widest window is a week. A later time is a misread, never a week-plus stop. */
const MAX_PAUSE_MS = 8 * 24 * 60 * 60_000
/** How long a quota reading is reused before asking again. */
const READING_TTL_MS = 5 * 60_000
const RUNTIMES: readonly QuotaRuntime[] = ['claude', 'codex']

// Only an unmistakable "usage limit" counts. A bare 429 or "rate limit" is transient, and an API "exceeded your
// quota" is billing: neither resets by itself, and treating them as pauses would retry a ticket forever (R-1).
const QUOTA_SIGNAL = /hit your (?:usage )?limit|usage limit reached|usage_limit_reached|(?:\d+-hour|weekly|session) limit reached/i

export interface QuotaLimit {
  resetAt: Date
  /** False when the output named no usable time and the fixed prudent wait was used. */
  explicit: boolean
}

/**
 * Recognises a quota limit in the output of a Claude or Codex session and reads when it resets. `timeZone` is
 * the zone of clock times without one (Codex prints the machine's local time); tests pass it explicitly.
 */
export function detectQuotaLimit(output: string, now: Date, timeZone?: string): QuotaLimit | null {
  if (!QUOTA_SIGNAL.test(output)) return null
  let reset: number | null = null
  try {
    reset = readResetTime(output, now, timeZone)
  } catch {
    reset = null // an unknown zone name or a malformed date: the prudent wait applies
  }
  if (reset !== null && reset > now.getTime()) {
    return {resetAt: new Date(Math.min(reset, now.getTime() + MAX_PAUSE_MS)), explicit: true}
  }
  return {resetAt: new Date(now.getTime() + QUOTA_FALLBACK_PAUSE_MS), explicit: false}
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

function readResetTime(output: string, now: Date, timeZone?: string): number | null {
  // Claude, legacy result: "Claude AI usage limit reached|<epoch seconds>".
  const epoch = /usage limit reached\|(\d{9,11})/i.exec(output)
  if (epoch) return Number(epoch[1]) * 1000
  // Codex error body.
  const inSeconds = /"resets_in_seconds"\s*:\s*(\d+)/.exec(output)
  if (inSeconds) return now.getTime() + Number(inSeconds[1]) * 1000
  const atSeconds = /"resets_at"\s*:\s*(\d{9,11})\b/.exec(output)
  if (atSeconds) return Number(atSeconds[1]) * 1000
  // Codex: "try again in 2 days 3 hours 5 minutes".
  const duration = /try again in ((?:\d+\s*(?:days?|hours?|minutes?|seconds?)[\s,]*(?:and\s+)?)+)/i.exec(output)
  if (duration) {
    const unit: Record<string, number> = {d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000}
    let total = 0
    for (const part of duration[1].matchAll(/(\d+)\s*([dhms])/gi)) total += Number(part[1]) * unit[part[2].toLowerCase()]
    return total > 0 ? now.getTime() + total : null
  }
  // Codex: "try again at 3:45 PM" or "try again at Nov 5th, 2026 1:05 AM", in the machine's zone.
  const at = /try again at (?:([A-Za-z]{3})[a-z]* (\d{1,2})(?:st|nd|rd|th)?,? (\d{4}),? )?(\d{1,2}):(\d{2}) ?([AP]M)/i.exec(output)
  if (at) {
    const month = at[1] ? MONTHS.indexOf(at[1].toLowerCase()) : -1
    const date = at[1] && month >= 0 ? {year: Number(at[3]), month, day: Number(at[2])} : undefined
    return clockTime(now, to24h(Number(at[4]), at[6]), Number(at[5]), timeZone, date)
  }
  // Claude: "resets 3pm (Europe/Rome)" or "resets 3:30pm".
  const resets = /resets\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap]m)(?:\s*\(([A-Za-z_]+(?:\/[A-Za-z_+-]+)*)\))?/i.exec(output)
  if (resets) return clockTime(now, to24h(Number(resets[1]), resets[3]), Number(resets[2] ?? 0), resets[4] ?? timeZone)
  return null
}

function to24h(hour: number, meridiem: string): number {
  const base = hour % 12
  return meridiem.toLowerCase() === 'pm' ? base + 12 : base
}

/** Offset (ms) of `timeZone` from UTC at `date`; `undefined` = the machine's zone. */
function zoneOffsetMs(date: Date, timeZone?: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date)
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value)
  const asUtc = Date.UTC(value('year'), value('month') - 1, value('day'), value('hour'), value('minute'), value('second'))
  return asUtc - Math.floor(date.getTime() / 1000) * 1000
}

/** The instant a wall-clock time falls on in `timeZone`: on `date` when given, otherwise its next occurrence. */
function clockTime(now: Date, hour: number, minute: number, timeZone?: string, date?: {year: number; month: number; day: number}): number {
  const offset = zoneOffsetMs(now, timeZone)
  const local = new Date(now.getTime() + offset)
  const day = date ?? {year: local.getUTCFullYear(), month: local.getUTCMonth(), day: local.getUTCDate()}
  let instant = Date.UTC(day.year, day.month, day.day, hour, minute) - offset
  if (!date && instant <= now.getTime()) instant += 86_400_000
  return instant
}

// --- Machine pause, on disk -------------------------------------------------------------------------------

export interface QuotaPause {
  /** `null` when the record is unreadable: which engine is unknown, the pause is not. */
  runtime: QuotaRuntime | null
  until: Date
}

type PauseRecord = Partial<Record<QuotaRuntime, string>>

function readPauseRecord(file: string): {record: PauseRecord; corrupt: boolean} {
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    return {record: {}, corrupt: (error as NodeJS.ErrnoException).code !== 'ENOENT'}
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {record: {}, corrupt: true}
    const record: PauseRecord = {}
    for (const runtime of RUNTIMES) {
      const value = (parsed as Record<string, unknown>)[runtime]
      if (value === undefined) continue
      if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return {record: {}, corrupt: true}
      record[runtime] = value
    }
    return {record, corrupt: false}
  } catch {
    return {record: {}, corrupt: true}
  }
}

/**
 * The active pause that ends last, or `null`. An unreadable record is a SHORT pause from when it was written —
 * never a green light, and never a stop that outlives the prudent wait either.
 */
export function readQuotaPause(now: Date, file: string = quotaPausePath()): QuotaPause | null {
  const {record, corrupt} = readPauseRecord(file)
  if (corrupt) {
    let written = now.getTime()
    try {
      written = fs.statSync(file).mtimeMs
    } catch {
      // unreadable metadata too: the wait starts now
    }
    const until = written + QUOTA_FALLBACK_PAUSE_MS
    return until > now.getTime() ? {runtime: null, until: new Date(until)} : null
  }
  let latest: QuotaPause | null = null
  for (const runtime of RUNTIMES) {
    const value = record[runtime]
    if (!value) continue
    const until = new Date(value)
    if (until.getTime() > now.getTime() && (!latest || until > latest.until)) latest = {runtime, until}
  }
  return latest
}

/** Pauses an engine until `until`, keeping a later pause already recorded. Atomic write (temp + rename). */
export function recordQuotaPause(runtime: QuotaRuntime, until: Date, now: Date, file: string = quotaPausePath()): void {
  const {record} = readPauseRecord(file)
  const next: PauseRecord = {}
  for (const name of RUNTIMES) {
    const value = record[name]
    if (value && Date.parse(value) > now.getTime()) next[name] = value
  }
  const current = next[runtime]
  if (!current || Date.parse(current) < until.getTime()) next[runtime] = until.toISOString()
  fs.mkdirSync(path.dirname(file), {recursive: true})
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(next)}\n`, {mode: 0o600})
    fs.renameSync(temporary, file)
  } catch (error) {
    try { fs.rmSync(temporary, {force: true}) } catch { /* an orphan temp file is not the record */ }
    throw error
  }
}

/**
 * After a failed session: when its output is a clear quota limit, pause that engine until the reset and return
 * the resume time; otherwise `null`. Best-effort: a pause that cannot be written still returns the time, so the
 * attempt is not charged for the quota.
 */
export function noteQuotaFailure(runtime: QuotaRuntime, output: string, now: Date, file: string = quotaPausePath()): Date | null {
  const limit = detectQuotaLimit(output, now)
  if (!limit) return null
  try {
    recordQuotaPause(runtime, limit.resetAt, now, file)
  } catch {
    // The remaining-quota check before the next claim still sees the exhausted account.
  }
  return limit.resetAt
}

// --- Remaining quota, read before asking for work ---------------------------------------------------------

export interface QuotaWindow {
  remaining_percent: number
  resets_at: string | null
}

export interface QuotaReading {
  runtime: QuotaRuntime
  windows: QuotaWindow[]
}

export type QuotaReader = () => Promise<QuotaReading | null>

function isoOrNull(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value * 1000).toISOString()
  if (typeof value !== 'string') return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}

function remainingOf(used: unknown): number | null {
  if (typeof used !== 'number' || !Number.isFinite(used)) return null
  return Math.min(100, Math.max(0, Math.round((100 - used) * 10) / 10))
}

const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const READ_TIMEOUT_MS = 10_000

/**
 * The OAuth token the Claude sessions use. An API key has no subscription windows, so it yields `null`. Without
 * an organization or env credential, the machine's own login file. The token never leaves this read.
 */
function claudeOauthToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const auth = claudeAuthEnv(env)
  if (auth.CLAUDE_CODE_OAUTH_TOKEN) return auth.CLAUDE_CODE_OAUTH_TOKEN
  if (auth.ANTHROPIC_API_KEY || auth.ANTHROPIC_AUTH_TOKEN) return null
  try {
    const dir = env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), '.claude')
    const stored = JSON.parse(fs.readFileSync(path.join(dir, '.credentials.json'), 'utf8')) as {claudeAiOauth?: {accessToken?: unknown}}
    const token = stored.claudeAiOauth?.accessToken
    return typeof token === 'string' && token !== '' ? token : null
  } catch {
    return null
  }
}

/**
 * Claude's remaining quota from the usage service of its OAuth login (5-hour and 7-day windows). The service is not
 * documented and may change shape: anything unexpected is `null`, i.e. unknown — never zero (R-2).
 */
export async function readClaudeQuota(deps: {fetchFn?: typeof globalThis.fetch; token?: () => string | null} = {}): Promise<QuotaReading | null> {
  const token = (deps.token ?? claudeOauthToken)()
  if (!token) return null
  try {
    const response = await (deps.fetchFn ?? globalThis.fetch)(CLAUDE_USAGE_URL, {
      headers: {Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20'},
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    })
    if (!response.ok) return null
    const body = (await response.json()) as Record<string, {utilization?: unknown; resets_at?: unknown} | null | undefined>
    const windows: QuotaWindow[] = []
    for (const key of ['five_hour', 'seven_day']) {
      const window = body?.[key]
      if (!window) continue
      const remaining = remainingOf(window.utilization)
      if (remaining === null) return null
      windows.push({remaining_percent: remaining, resets_at: isoOrNull(window.resets_at)})
    }
    return windows.length > 0 ? {runtime: 'claude', windows} : null
  } catch {
    return null
  }
}

interface AppServerChild {
  stdin: NodeJS.WritableStream | null
  stdout: NodeJS.ReadableStream | null
  on(event: 'error' | 'close', listener: (...args: unknown[]) => void): unknown
  kill(signal?: NodeJS.Signals): unknown
}
type AppServerSpawn = (command: string, args: string[], options: {stdio: ['pipe', 'pipe', 'ignore']; env: NodeJS.ProcessEnv}) => AppServerChild

/**
 * Codex's remaining quota from its local app-server (`account/rateLimits/read`, JSON lines on stdio). Every
 * window it reports counts. Timeout, exit or unexpected shape → `null`.
 */
export async function readCodexQuota(deps: {spawnFn?: AppServerSpawn; timeoutMs?: number} = {}): Promise<QuotaReading | null> {
  const spawnFn = deps.spawnFn ?? (nodeSpawn as unknown as AppServerSpawn)
  let child: AppServerChild
  try {
    child = spawnFn(CODEX_BIN, ['app-server'], {stdio: ['pipe', 'pipe', 'ignore'], env: process.env})
  } catch {
    return null
  }
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: QuotaReading | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child.kill() } catch { /* already gone */ }
      resolve(value)
    }
    const timer = setTimeout(() => finish(null), deps.timeoutMs ?? READ_TIMEOUT_MS)
    const send = (message: unknown) => {
      try { child.stdin?.write(`${JSON.stringify(message)}\n`) } catch { finish(null) }
    }
    child.on('error', () => finish(null))
    child.on('close', () => finish(null))
    let buffer = ''
    child.stdout?.on('data', (chunk: Buffer | string) => {
      buffer += String(chunk)
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        let message: {id?: unknown; result?: {rateLimits?: Record<string, {usedPercent?: unknown; resetsAt?: unknown} | null>}}
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }
        if (message.id === 1) {
          send({method: 'initialized'})
          send({id: 2, method: 'account/rateLimits/read'})
        } else if (message.id === 2) {
          const limits = message.result?.rateLimits
          const windows: QuotaWindow[] = []
          for (const key of ['primary', 'secondary']) {
            const window = limits?.[key]
            if (!window) continue
            const remaining = remainingOf(window.usedPercent)
            if (remaining !== null) windows.push({remaining_percent: remaining, resets_at: isoOrNull(window.resetsAt)})
          }
          finish(windows.length > 0 ? {runtime: 'codex', windows} : null)
        }
      }
    })
    send({id: 1, method: 'initialize', params: {clientInfo: {name: 'closeyourit-automator', version: '1'}}})
  })
}

// --- Claim gate and heartbeat report ----------------------------------------------------------------------

export type QuotaReadiness = {ready: true} | {ready: false; detail: string}

/** What the heartbeat says about one engine. Unknown values are `null`, never zero. */
export interface AgentQuotaReport {
  runtime: QuotaRuntime
  remaining_percent: number | null
  resets_at: string | null
  paused_until: string | null
}

export type QuotaGate = (() => Promise<QuotaReadiness>) & {report(now: Date, file?: string): AgentQuotaReport[]}

/**
 * Gate run before asking for work: an active pause stops it; then the remaining quota of both engines is read
 * and a window below the threshold starts a pause until it resets. A reading that fails lets the machine work —
 * a broken check must not stop the work, and the pause read from the error still applies (R-2).
 */
export function makeQuotaGate(deps: {
  now?: () => Date
  file?: string
  readers?: Record<QuotaRuntime, QuotaReader>
} = {}): QuotaGate {
  const now = deps.now ?? (() => new Date())
  const readers = deps.readers ?? {claude: () => readClaudeQuota(), codex: () => readCodexQuota()}
  const fileOf = () => deps.file ?? quotaPausePath()
  const latest = new Map<QuotaRuntime, {at: number; reading: QuotaReading | null}>()

  const read = async (runtime: QuotaRuntime, at: number): Promise<QuotaReading | null> => {
    const cached = latest.get(runtime)
    if (cached && at - cached.at < READING_TTL_MS) return cached.reading
    const reading = await readers[runtime]().catch(() => null)
    latest.set(runtime, {at, reading})
    return reading
  }

  const gate = async (): Promise<QuotaReadiness> => {
    const instant = now()
    let pause: QuotaPause | null
    try {
      pause = readQuotaPause(instant, fileOf())
    } catch {
      pause = null
    }
    if (pause) return {ready: false, detail: `${pause.runtime ?? 'agent'} quota exhausted: paused until ${pause.until.toISOString()}`}
    const readings = await Promise.all(RUNTIMES.map((runtime) => read(runtime, instant.getTime())))
    for (const reading of readings) {
      const low = reading?.windows
        .filter((window) => window.remaining_percent < QUOTA_MIN_REMAINING_PERCENT)
        .sort((left, right) => Date.parse(right.resets_at ?? '') - Date.parse(left.resets_at ?? ''))[0]
      if (!reading || !low) continue
      const reset = low.resets_at ? Date.parse(low.resets_at) : Number.NaN
      const until = new Date(Number.isFinite(reset) && reset > instant.getTime()
        ? Math.min(reset, instant.getTime() + MAX_PAUSE_MS)
        : instant.getTime() + QUOTA_FALLBACK_PAUSE_MS)
      try {
        recordQuotaPause(reading.runtime, until, instant, fileOf())
      } catch {
        // Not recorded: the next claim reads the quota again and stops anyway.
      }
      // After the reset the account must be read again, not trusted from before.
      latest.delete(reading.runtime)
      return {
        ready: false,
        detail: `${reading.runtime} quota below ${QUOTA_MIN_REMAINING_PERCENT}% (${low.remaining_percent}% left): paused until ${until.toISOString()}`,
      }
    }
    return {ready: true}
  }

  const report = (instant: Date, file: string = fileOf()): AgentQuotaReport[] => {
    let record: PauseRecord = {}
    try {
      record = readPauseRecord(file).record
    } catch {
      record = {}
    }
    return RUNTIMES.map((runtime) => {
      const windows = latest.get(runtime)?.reading?.windows ?? []
      const tightest = [...windows].sort((left, right) => left.remaining_percent - right.remaining_percent)[0]
      const paused = record[runtime]
      return {
        runtime,
        remaining_percent: tightest?.remaining_percent ?? null,
        resets_at: tightest?.resets_at ?? null,
        paused_until: paused && Date.parse(paused) > instant.getTime() ? paused : null,
      }
    })
  }

  return Object.assign(gate, {report})
}

/** The process-wide gate: the claim fills its readings, the heartbeat reports them. */
export const agentQuotaGate = makeQuotaGate()

export function agentQuotaReport(now: Date = new Date(), gate: QuotaGate = agentQuotaGate, file?: string): AgentQuotaReport[] {
  return gate.report(now, file)
}
