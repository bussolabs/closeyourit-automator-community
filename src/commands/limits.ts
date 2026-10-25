import {Flags} from '@oclif/core'
import {BaseCommand} from '../base'
import {loadSecrets} from '../lib/config'
import {listLeases} from '../lib/lease'
import {
  countRunningLeases,
  defaultPolicyFetcher,
  evaluateLimits,
  failClosedDecision,
  type LimitsDecision,
  type LimitsMode,
  type LimitsPolicy,
  type LimitsSnapshot,
  parseLimitsPolicy,
  type PolicyFetcher,
  type PolicySource,
  readUsageResult,
  recordUsage,
  UsageLockBusyError,
  UsageLockCleanupPendingError,
  UsageRecoveryPendingError,
  UsageRecordedLockError,
  resolveLimitsPolicy,
  type UsageRecord,
  usageDateKey,
} from '../lib/limits'
import {policyCachePath} from '../lib/paths'
import {AutomatorError, ErrorCodes} from '../errors/error-codes'

/** owner/repo: both segments alphanumeric (`.`/`_`/`-` allowed). Ends up in the fetch query and in the cache key. */
const REPOSITORY_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/

/** Snapshot resolved from the flags (undefined = "read from disk"). */
interface SnapshotOverrides {
  running?: number
  runsToday?: number
  costToday?: number
  runtimeSeconds?: number
}

/** Outcome of `loadPolicy`: the resolved policy + whether the channel is configured + where it comes from (default). */
interface LoadedPolicy {
  policy: LimitsPolicy | null
  configured: boolean
  source?: PolicySource
}

class UsageReservationDeniedError extends Error {
  constructor(readonly decision: LimitsDecision) {
    super(decision.reason)
  }
}

class UsageDateChangedError extends Error {
  constructor(readonly date: string) {
    super(`il giorno UTC è cambiato durante l'acquisizione del lock usage: ${date}`)
  }
}

interface DecimalParts {
  coefficient: bigint
  exponent: number
}

/** Compares the received decimal value with the one actually stored by `number`, without intermediate floats. */
function decimalParts(value: string): DecimalParts {
  const [mantissa, exponentText] = value.toLowerCase().split('e')
  const [integer, fraction = ''] = mantissa.split('.')
  const digits = `${integer || '0'}${fraction}`.replace(/^0+/, '')
  if (digits === '') return {coefficient: 0n, exponent: 0}
  return {
    coefficient: BigInt(digits),
    exponent: Number(exponentText ?? '0') - fraction.length,
  }
}

function numberParts(value: number): {numerator: bigint; denominator: bigint} {
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, value, false)
  const bits = view.getBigUint64(0, false)
  const rawExponent = Number((bits >> 52n) & 0x7ffn)
  const fraction = bits & ((1n << 52n) - 1n)
  const coefficient = rawExponent === 0 ? fraction : (1n << 52n) | fraction
  const exponent = rawExponent === 0 ? -1074 : rawExponent - 1023 - 52
  return exponent >= 0
    ? {numerator: coefficient << BigInt(exponent), denominator: 1n}
    : {numerator: coefficient, denominator: 1n << BigInt(-exponent)}
}

function numberUnderstatesDecimal(source: string, represented: number): boolean {
  const exact = decimalParts(source)
  if (exact.coefficient === 0n) return false
  if (represented === 0) return true
  const exactRational = exact.exponent >= 0
    ? {numerator: exact.coefficient * 10n ** BigInt(exact.exponent), denominator: 1n}
    : {numerator: exact.coefficient, denominator: 10n ** BigInt(-exact.exponent)}
  const actual = numberParts(represented)
  return actual.numerator * exactRational.denominator < exactRational.numerator * actual.denominator
}

function nextUp(value: number): number {
  if (value === 0) return Number.MIN_VALUE
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, value, false)
  view.setBigUint64(0, view.getBigUint64(0, false) + 1n, false)
  return view.getFloat64(0, false)
}

export default class Limits extends BaseCommand {
  static description =
    "Applica budget, limiti di concorrenza e kill switch (CYAU-32): valuta se Automator può AVVIARE (--mode dispatch) o PROSEGUIRE (--mode continue) una run rispettando slot (max_parallel), budget giornaliero (run/costo), finestre orarie e stato del kill switch. La policy vive server-side con una cache locale FAIL-CLOSED: se non è recuperabile il gate blocca (mai fail-open). Gate shell safe-by-default: run ammessa → exit 0; limite di dispatch superato/kill switch/fail-closed → exit 3 (C409-LIMITS-002, non avviare); run in corso da portare a un checkpoint sicuro → exit 3 (C409-LIMITS-003, mai un kill brutale); input non valido → exit 2. Con --record registra il consumo giornaliero (run/costo) che alimenta il budget"

  static examples = [
    '<%= config.bin %> limits --mode dispatch',
    '<%= config.bin %> limits --mode continue --runtime-seconds 5400',
    '<%= config.bin %> limits --record --runs 1 --cost 0.42',
    '<%= config.bin %> limits --policy \'{"max_parallel":2,"stop_dispatch":false}\' --running 1 --json',
  ]

  static flags = {
    mode: Flags.string({description: 'dispatch (avvio nuova run) | continue (run in corso)', default: 'dispatch'}),
    // Explicit policy (JSON): bypasses server/cache — handy for the orchestrator that already has the policy, or for tests.
    policy: Flags.string({description: 'policy dei limiti come JSON (bypassa server/cache)'}),
    repository: Flags.string({description: "repository owner/repo della run (etichetta/scope dell'audit)"}),
    // Snapshot override (default: read from disk — leases for the slots, usage store for the day's budget).
    running: Flags.string({description: 'slot occupati ora (default: lease vivi di questo host)'}),
    'runs-today': Flags.string({description: 'run avviate oggi (default: usage store del giorno)'}),
    'cost-today': Flags.string({description: 'costo accumulato oggi (default: usage store del giorno)'}),
    'runtime-seconds': Flags.string({description: 'durata della run in valutazione (solo --mode continue)'}),
    // Usage recording (the orchestrator invokes it at the start/end of a run).
    record: Flags.boolean({description: 'registra il consumo giornaliero (run/costo) invece di valutare il gate', default: false}),
    runs: Flags.string({description: 'run da registrare con --record (default 1)'}),
    cost: Flags.string({description: 'costo da registrare con --record (default 0)'}),
    code: Flags.string({description: 'codice del ticket/run (solo per etichettare l\'output, es. CYAU-32)'}),
  }

  /** Clock injectable in tests (deterministic schedule/usage). */
  protected clock(): Date {
    return new Date()
  }

  /** Builds the real policy probe (host-scoped GET). Overridable in tests. */
  protected makePolicyFetcher(repository?: string): PolicyFetcher {
    return defaultPolicyFetcher(loadSecrets(), globalThis.fetch, repository)
  }

  /**
   * Resolves the policy from the real channel (server → cache → fail-closed). `configured` is false when the channel is
   * not set up at all (no sync): in that case no limit is applied (backward compat). The cache is keyed by
   * `repository` so an outage does not reuse one repo's policy on the wrong repo. Overridable in tests.
   */
  protected async loadPolicy(now: Date, repository?: string): Promise<LoadedPolicy> {
    const secrets = loadSecrets()
    if (!secrets.sync) return {policy: null, configured: false}
    const resolved = await resolveLimitsPolicy(this.makePolicyFetcher(repository), now, policyCachePath(repository))
    return {policy: resolved.policy, configured: true, source: resolved.source}
  }

  /**
   * Composes the snapshot: flag overrides take precedence, otherwise it is read from disk (leases for the
   * slots, usage store for the budget). A CORRUPT usage → `budget_readable:false` (fail-closed on the budget, never
   * reopen it assuming zero) — but only if the budget really depends on the usage (no count overrides).
   */
  protected loadSnapshot(overrides: SnapshotOverrides, now: Date): LimitsSnapshot {
    const secrets = loadSecrets()
    // Overrides replace the totals, not the backing store attestation: lock/tmp/quarantine/corruption
    // always remain a fail-closed reason and cannot be bypassed by passing both flags.
    const usage = readUsageResult(usageDateKey(now))
    return {
      running: overrides.running ?? countRunningLeases(listLeases(), secrets.host?.id ?? null, now),
      runs_today: overrides.runsToday ?? usage.usage.runs,
      cost_today: overrides.costToday ?? usage.usage.cost,
      run_runtime_seconds: overrides.runtimeSeconds,
      budget_readable: !usage.corrupt,
      usage_lock_cleanup_pending: usage.lock_cleanup_pending,
      usage_retryable: usage.retryable,
      now,
    }
  }

  async run(): Promise<unknown> {
    const {flags} = await this.parse(Limits)
    const now = this.clock()

    if (flags.record) return this.runRecord(flags, now)
    return this.runGate(flags, now)
  }

  /** Records the day's usage (budget). No gate: exit 0. */
  private async runRecord(flags: LimitsFlags, now: Date): Promise<unknown> {
    const runs = this.parseNonNegativeSafeInteger(flags.runs, 'runs') ?? 1
    const cost = this.parseNonNegativeSafeMagnitude(flags.cost, 'cost') ?? 0
    let usage: UsageRecord | null = null
    let date = usageDateKey(now)
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          usage = await this.recordDailyUsage(date, {runs, cost}, () => {
            const lockedDate = usageDateKey(this.clock())
            if (lockedDate !== date) throw new UsageDateChangedError(lockedDate)
          })
          break
        } catch (error) {
          if (error instanceof UsageDateChangedError) {
            if (attempt === 0) {
              date = error.date
              continue
            }
            throw new AutomatorError(ErrorCodes.Limits.usageUnavailable, 'giorno UTC instabile durante il record usage', 3)
          }
          throw error
        }
      }
    } catch (error) {
      if (this.jsonEnabled() && error instanceof AutomatorError) {
        const committed = error instanceof UsageRecordedLockError
        const cleanupPending = committed || error instanceof UsageRecoveryPendingError
        this.logJson({
          recorded: committed,
          lock_cleanup_pending: cleanupPending,
          code: flags.code ?? null,
          ...(committed ? {usage: error.usage} : {}),
          ...(cleanupPending ? {retryable: false} : error instanceof UsageLockBusyError ? {retryable: true} : {}),
          error: {code: error.code, message: error.message},
        })
      }
      throw error
    }
    if (usage === null) throw new AutomatorError(ErrorCodes.Limits.usageUnavailable, 'giorno UTC instabile durante il record usage', 3)
    if (!this.jsonEnabled()) this.printUsage(usage)
    return {recorded: true, code: flags.code ?? null, usage}
  }

  protected async recordDailyUsage(
    date: string,
    delta: {runs: number; cost: number},
    beforeCommit?: (current: UsageRecord) => void,
  ): Promise<UsageRecord> {
    return recordUsage(date, delta, undefined, {beforeCommit})
  }

  protected async reserveDailyUsage(
    date: string,
    delta: {runs: number; cost: number},
    beforeCommit: (current: UsageRecord) => void,
  ): Promise<UsageRecord> {
    return recordUsage(date, delta, undefined, {beforeCommit})
  }

  /** Evaluates the limits gate and maps the decision onto a shell-safe exit code. */
  private async runGate(flags: LimitsFlags, now: Date): Promise<unknown> {
    const mode = this.parseMode(flags.mode)
    const repository = this.parseRepository(flags.repository)
    const overrides: SnapshotOverrides = {
      running: this.parseNonNegative(flags.running, 'running'),
      runsToday: this.parseNonNegative(flags['runs-today'], 'runs-today'),
      costToday: this.parseNonNegative(flags['cost-today'], 'cost-today'),
      runtimeSeconds: this.parseNonNegative(flags['runtime-seconds'], 'runtime-seconds'),
    }

    const {policy, configured, source} = await this.resolvePolicy(flags, now, repository)
    const evaluationNow = this.clock()
    const snapshot = this.loadSnapshot(overrides, evaluationNow)

    // known policy → gate; configured but missing → fail-closed; not configured → admit (no limit).
    let decision = policy
      ? evaluateLimits(policy, snapshot, mode)
      : configured
        ? failClosedDecision(mode, null) // policy is null here: the real scope is not known without a policy
        : evaluateLimits({}, snapshot, mode)

    let reservation: UsageRecord | null = null
    if (mode === 'dispatch' && decision.outcome === 'admit') {
      const reservationCost = this.parseNonNegativeSafeMagnitude(flags.cost, 'cost') ?? 0
      let reservationDate = usageDateKey(evaluationNow)
      try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            reservation = await this.reserveDailyUsage(reservationDate, {runs: 1, cost: reservationCost}, (current) => {
              const lockedNow = this.clock()
              const lockedDate = usageDateKey(lockedNow)
              if (lockedDate !== reservationDate) throw new UsageDateChangedError(lockedDate)
              const lockedSnapshot = {
                ...snapshot,
                runs_today: current.runs,
                cost_today: current.cost,
                budget_readable: true,
                pending_runs: 1,
                pending_cost: reservationCost,
                now: lockedNow,
              }
              const lockedDecision = policy
                ? evaluateLimits(policy, lockedSnapshot, mode)
                : configured
                  ? failClosedDecision(mode, null)
                  : evaluateLimits({}, lockedSnapshot, mode)
              if (lockedDecision.outcome !== 'admit') throw new UsageReservationDeniedError(lockedDecision)
            })
            break
          } catch (error) {
            if (error instanceof UsageDateChangedError) {
              if (attempt === 0) {
                reservationDate = error.date
                continue
              }
              throw new AutomatorError(ErrorCodes.Limits.usageUnavailable, 'giorno UTC instabile durante la prenotazione usage', 3)
            }
            throw error
          }
        }
        if (reservation === null) {
          throw new AutomatorError(ErrorCodes.Limits.usageUnavailable, 'giorno UTC instabile durante la prenotazione usage', 3)
        }
      } catch (error) {
        if (error instanceof UsageReservationDeniedError) decision = error.decision
        else {
          if (this.jsonEnabled() && error instanceof AutomatorError) {
            const committed = error instanceof UsageRecordedLockError
            const cleanupPending = committed || error instanceof UsageRecoveryPendingError
            this.logJson({
              code: flags.code ?? null,
              mode,
              repository: repository ?? null,
              reserved: committed,
              lock_cleanup_pending: cleanupPending,
              ...(committed ? {usage: error.usage} : {}),
              ...(cleanupPending ? {retryable: false} : error instanceof UsageLockBusyError ? {retryable: true} : {}),
              error: {code: error.code, message: error.message},
            })
          }
          throw error
        }
      }
    }

    if (!this.jsonEnabled()) this.printDecision(decision)
    const payload = {
      code: flags.code ?? null,
      mode,
      repository: repository ?? null,
      decision,
      source,
      reservation,
      ...(snapshot.budget_readable === false
        ? {
            reserved: false,
            lock_cleanup_pending: snapshot.usage_lock_cleanup_pending ?? false,
            ...(snapshot.usage_retryable === undefined ? {} : {retryable: snapshot.usage_retryable}),
          }
        : {}),
    }

    if (decision.outcome === 'admit') return payload

    // deny (dispatch) → limit exceeded / kill switch / fail-closed: do not start. checkpoint (continue) → bring the
    // run to a safe checkpoint, never a kill. Both exit 3 (shell gate does not continue), distinct codes for the audit.
    const code = decision.outcome === 'deny' ? ErrorCodes.Limits.limitExceeded : ErrorCodes.Limits.checkpointRequired
    const error = new AutomatorError(code, decision.reason, 3)
    if (this.jsonEnabled()) this.logJson({...payload, error: {code: error.code, message: error.message}})
    throw error
  }

  /** The policy from --policy (explicit, validated) or from the real channel (loadPolicy), keyed by repository. */
  private async resolvePolicy(flags: LimitsFlags, now: Date, repository?: string): Promise<{policy: LimitsPolicy | null; configured: boolean; source: string}> {
    if (flags.policy !== undefined) {
      let raw: unknown
      try {
        raw = JSON.parse(flags.policy)
      } catch {
        throw this.invalidInput('--policy non è JSON valido')
      }
      const policy = parseLimitsPolicy(raw)
      if (!policy) throw this.invalidInput('--policy non è una policy dei limiti valida')
      return {policy, configured: true, source: 'explicit'}
    }

    const loaded = await this.loadPolicy(now, repository)
    const source = loaded.configured ? (loaded.source ?? (loaded.policy ? 'resolved' : 'fail-closed')) : 'none-configured'
    return {policy: loaded.policy, configured: loaded.configured, source}
  }

  private parseMode(value: string): LimitsMode {
    if (value !== 'dispatch' && value !== 'continue') {
      throw this.invalidInput(`--mode sconosciuto: "${value}" (atteso dispatch|continue)`)
    }
    return value
  }

  /** Validates `--repository` as owner/repo (it ends up in the fetch query and in the cache key). Missing → undefined. */
  private parseRepository(value: string | undefined): string | undefined {
    if (value === undefined) return undefined
    if (!REPOSITORY_RE.test(value)) {
      throw this.invalidInput(`--repository deve essere owner/repo: "${value}"`)
    }
    return value
  }

  /** A numeric flag value: missing → undefined; non-numeric or negative → invalidInput (exit 2). */
  private parseNonNegative(value: string | undefined, name: string): number | undefined {
    if (value === undefined) return undefined
    const n = Number(value)
    if (!Number.isFinite(n) || n < 0) {
      throw this.invalidInput(`--${name} deve essere un numero non negativo: "${value}"`)
    }
    return n
  }

  private parseNonNegativeSafeInteger(value: string | undefined, name: string): number | undefined {
    const parsed = this.parseNonNegative(value, name)
    if (parsed !== undefined && !Number.isSafeInteger(parsed)) {
      throw this.invalidInput(`--${name} deve essere un intero rappresentabile in sicurezza: "${value}"`)
    }
    return parsed
  }

  private parseNonNegativeSafeMagnitude(value: string | undefined, name: string): number | undefined {
    if (value === undefined) return undefined
    if (value.length > 128) {
      throw this.invalidInput(`--${name} è troppo lungo per un valore decimale sicuro`)
    }
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) {
      throw this.invalidInput(`--${name} deve essere un numero decimale non negativo: "${value}"`)
    }
    const exponentText = /e([+-]?\d+)$/i.exec(value)?.[1]
    if (exponentText !== undefined && (exponentText.length > 5 || Math.abs(Number(exponentText)) > 400)) {
      throw this.invalidInput(`--${name} usa un esponente fuori dal range sicuro: "${value}"`)
    }
    let parsed = this.parseNonNegative(value, name)!
    if (parsed > Number.MAX_SAFE_INTEGER) {
      throw this.invalidInput(`--${name} supera il massimo rappresentabile in sicurezza: "${value}"`)
    }
    if (numberUnderstatesDecimal(value, parsed)) {
      parsed = nextUp(parsed)
      if (parsed > Number.MAX_SAFE_INTEGER) {
        throw this.invalidInput(`--${name} non è rappresentabile senza superare il massimo sicuro: "${value}"`)
      }
    }
    return parsed
  }

  private invalidInput(message: string): AutomatorError {
    return new AutomatorError(ErrorCodes.Limits.invalidInput, message, 2)
  }

  private printDecision(decision: LimitsDecision): void {
    this.log(`limits · ${decision.mode} · ${decision.outcome.toUpperCase()}${decision.limit ? ` (${decision.limit})` : ''}`)
    this.log(`  ${decision.reason}`)
    if (decision.scope) this.log(`  scope: ${decision.scope}`)
  }

  private printUsage(usage: UsageRecord): void {
    this.log(`usage ${usage.date} · run ${usage.runs} · costo ${usage.cost}`)
  }
}

/** Shape of the parsed flags used by the private helpers. */
interface LimitsFlags {
  mode: string
  policy?: string
  repository?: string
  running?: string
  'runs-today'?: string
  'cost-today'?: string
  'runtime-seconds'?: string
  record: boolean
  runs?: string
  cost?: string
  code?: string
}
