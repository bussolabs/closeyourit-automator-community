import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../base'
import {loadSecrets} from '../lib/config'
import {readLease} from '../lib/lease'
import {auditRecovery, defaultRecoveryGit, type RecoveryPlan} from '../lib/recovery'
import {type Checkpoint, latestCheckpoint, readRunAtomically, runPath} from '../lib/state'
import {worktreePath} from '../lib/workspace'
import {AutomatorError, ErrorCodes} from '../errors/error-codes'

export default class Recovery extends BaseCommand {
  static description =
    'Valuta se una lavorazione interrotta (host riavviato o offline) può riprendere in sicurezza o va segnalata per intervento. Compone checkpoint, stato del lease e branch remoto SENZA mai toccare il worktree (mai cancellare o duplicare lavoro): stesso host tornato online → riprende in loco; altro host → riprende solo il lavoro già sul remoto, mentre il lavoro solo locale è segnalato. Riprendibile → exit 0; intervento richiesto → exit 3; ticket ancora detenuto da un altro host → exit 3'

  static examples = [
    '<%= config.bin %> recovery run-42',
    '<%= config.bin %> recovery run-42 --worktree /w/CYAU/CYAU-15 --json',
    '<%= config.bin %> recovery run-42 --project CYAU --ticket CYAU-15',
  ]

  static args = {
    'run-id': Args.string({description: 'identificativo della lavorazione da valutare (nome del file di checkpoint)', required: true}),
  }

  static flags = {
    ticket: Flags.string({description: 'codice del ticket (default: quello del run record); serve per leggere il lease'}),
    project: Flags.string({description: 'project-key per derivare il worktree gestito (worktrees/<project>/<ticket>); richiede --ticket'}),
    worktree: Flags.string({description: 'path del worktree da sondare per il branch remoto (default: quello dell\'ultimo checkpoint)'}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(Recovery)
    const runId = args['run-id']
    // Validate the run-id (file name) BEFORE any I/O: a hostile run-id exits cleanly (exit 2), never traversal.
    const file = runPath(runId)
    const now = new Date()

    // Checkpoint read. A corrupt file is PRESERVED in quarantine (never overwritten → never lose
    // work), then treated as "no checkpoint" → not resumable (reported). Consistent with `checkpoint`.
    const {run, quarantined} = readRunAtomically(file, now.toISOString().replace(/[:.]/g, '-'))

    const ticket = flags.ticket ?? run?.ticket ?? null
    // The lease is indexed by ticket: without a ticket there is no lease to read (leaseOwner = none).
    const lease = ticket ? readLease(ticket) : null
    // Identity of WHO evaluates: without registration we do not recognise "same host" (stays conservative).
    const hostId = loadSecrets().host?.id ?? null

    // "Branch pushed": is the last checkpoint's commit reachable from a remote branch? Probeable only
    // if we know where the worktree is and there is a commit to check; otherwise undetermined (null).
    const latest = run ? latestCheckpoint(run) : null
    const worktree = resolveWorktree(flags, latest)
    const branchPushed = worktree && latest?.commit ? defaultRecoveryGit().remoteContains(worktree, latest.commit) : null

    const plan = auditRecovery({run, lease, hostId, branchPushed, now})

    if (quarantined && !this.jsonEnabled()) this.log(`file di checkpoint precedente corrotto → preservato in ${quarantined}`)

    if (plan.decision === 'resume') {
      if (!this.jsonEnabled()) this.printPlan(runId, plan)
      return {runId, ticket: plan.ticket, quarantined, ...planFields(plan)}
    }

    // Not automatically resumable: dedicated exit code (safe-by-default, like `lease` held) so a shell
    // gate does not resume by mistake. blocked (someone else's lease) and manual (intervention) have distinct C codes.
    const [code, message] = recoveryError(runId, plan)
    throw new AutomatorError(code, message, 3)
  }

  private printPlan(runId: string, plan: RecoveryPlan): void {
    this.log(`recovery ${runId} · ${plan.decision} (${plan.reason})`)
    if (plan.resumePhase) this.log(`  riprendi dalla fase: ${plan.resumePhase}`)
    const s = plan.signals
    this.log(`  segnali: sameHost=${s.sameHost} lease=${s.leaseOwner}/expired=${fmt(s.leaseExpired)} dirty=${fmt(s.dirty)} pushed=${fmt(s.branchPushed)}`)
  }
}

/** Plan fields to copy into the JSON result (without `ticket`, handled separately so as not to duplicate it). */
function planFields(plan: RecoveryPlan): Omit<RecoveryPlan, 'ticket'> {
  return {decision: plan.decision, reason: plan.reason, resumePhase: plan.resumePhase, signals: plan.signals}
}

/** Formats a tri-state signal (`null` = undetermined) for human output. */
function fmt(value: boolean | null): string {
  return value === null ? '?' : String(value)
}

/**
 * The worktree to probe for the remote branch: explicit (--worktree), derived from the managed layout
 * (--project + --ticket), or the one recorded in the last checkpoint. Best-effort: null when not resolvable
 * (→ branch pushed undetermined, recovery stays conservative), unlike `checkpoint` where it is required.
 */
function resolveWorktree(flags: {worktree?: string; project?: string; ticket?: string}, latest: Checkpoint | null): string | null {
  if (flags.worktree) return flags.worktree
  if (flags.project && flags.ticket) return worktreePath(flags.project, flags.ticket)
  return latest?.worktree ?? null
}

/** Error code + message for a non-resume decision (blocked/manual), readable and with a reason. */
function recoveryError(runId: string, plan: RecoveryPlan): [string, string] {
  if (plan.decision === 'blocked') {
    const holder = plan.ticket ? `del ticket ${plan.ticket}` : `della lavorazione ${runId}`
    return [ErrorCodes.Recovery.blocked, `Lease ${holder} ancora detenuto da un altro host (non scaduto): non recuperare`]
  }

  const why =
    plan.reason === 'local-only-work'
      ? 'lavoro solo locale (worktree dirty o commit non pushato) non recuperabile da un altro host'
      : 'nessun checkpoint valido da cui riprendere'
  return [ErrorCodes.Recovery.manual, `Lavorazione ${runId} non riprendibile in automatico (${why}): intervento richiesto`]
}
