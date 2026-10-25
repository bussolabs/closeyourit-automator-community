import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../base'
import {defaultCheckpointGit, deriveCheckpoint} from '../lib/checkpoint'
import {isRunPhase, latestRunPhase, planTransition, RUN_PHASES, type TransitionPlan} from '../lib/state-machine'
import {checkpointPublicationAt, type Checkpoint, mutateRunAtomically, readRun, recordCheckpoint, runPath, type RunStatus} from '../lib/state'
import {worktreePath} from '../lib/workspace'
import {AutomatorError, ErrorCodes} from '../errors/error-codes'

const OUTCOMES = ['success', 'failure', 'timeout', 'skipped'] as const

export default class Transition extends BaseCommand {
  static description =
    'Applica una transizione della macchina a stati della lavorazione (CYAU-16). Valida che il nuovo stato sia raggiungibile dalla fase corrente (l\'ultima persistita in runs/<run-id>.json): consente SOLO le transizioni lecite e, quando la fase cambia, persiste il nuovo stato come checkpoint (atomico, append, con quarantena dei file corrotti). Distingue lo stato run (le nove fasi) dallo stato del ticket su CloseYourIt (in_progress/in_review) e segnala se serve l\'effetto esterno: ri-applicare lo stato corrente è un no-op, così retry e riavvio non duplicano effetti esterni. Transizione non consentita → exit 3'

  static examples = [
    '<%= config.bin %> transition run-42 validating --ticket CYAU-16',
    '<%= config.bin %> transition run-42 implementing --worktree /w/CYAU/CYAU-16',
    '<%= config.bin %> transition run-42 in_review --json',
  ]

  static args = {
    'run-id': Args.string({description: 'identificativo stabile della lavorazione (nome del file di checkpoint)', required: true}),
    phase: Args.string({description: `nuovo stato della lavorazione (${RUN_PHASES.join(', ')})`, required: true}),
  }

  static flags = {
    ticket: Flags.string({description: 'codice del ticket lavorato (es. CYAU-16)'}),
    repository: Flags.string({description: 'repository della lavorazione, owner/repo'}),
    runtime: Flags.string({description: 'runtime che lavora la lavorazione (es. claude, codex) → mostrato nella dashboard (CYAU-31)'}),
    project: Flags.string({description: 'project-key per derivare il worktree gestito (worktrees/<project>/<ticket>); richiede --ticket'}),
    worktree: Flags.string({description: 'path del worktree della lavorazione, sondato per branch/commit (opzionale)'}),
    commit: Flags.string({description: 'commit da registrare (default: HEAD del worktree, se presente)'}),
    artifact: Flags.string({description: 'artefatto prodotto dalla fase (ripetibile)', multiple: true}),
    outcome: Flags.string({description: 'esito della fase', options: [...OUTCOMES]}),
    'dry-run': Flags.boolean({description: 'Valuta e mostra la transizione senza persisterla'}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(Transition)
    const runId = args['run-id']
    // Validate the run-id (file name) BEFORE any I/O: a hostile run-id exits cleanly (exit 2), never traversal.
    const file = runPath(runId)

    const to = args.phase
    if (!isRunPhase(to)) {
      throw new AutomatorError(ErrorCodes.State.invalidPhase, `Stato non riconosciuto: "${to}" (attesi: ${RUN_PHASES.join(', ')})`, 2)
    }

    const now = new Date()

    if (flags['dry-run']) {
      const {run} = readRun(file)
      const plan = this.requireAllowedPlan(runId, latestRunPhase(run), to)
      if (!this.jsonEnabled()) this.printPlan(runId, plan)
      return {dryRun: true, runId, file, quarantined: null, ...planFields(plan)}
    }

    const corruptStamp = now.toISOString().replace(/[:.]/g, '-')

    // First short validation under lock: self-transitions and illegal transitions never probe Git. The lock
    // is then released BEFORE the external probes, which can be slow or hang for repo reasons.
    const preflight = mutateRunAtomically(file, corruptStamp, (run) => ({
      value: this.requireAllowedPlan(runId, latestRunPhase(run), to),
    }))
    if (!preflight.value.phaseChanged) {
      if (!this.jsonEnabled()) this.printPlan(runId, preflight.value)
      return {dryRun: false, runId, file, quarantined: preflight.quarantined, ...planFields(preflight.value)}
    }

    const checkpoint = this.buildCheckpoint(to, flags, now.toISOString())

    // Revalidate after the probes and publish in the same read-modify-write. If a concurrent writer advanced the run
    // in the meantime, the plan is recomputed on the new state: no stale snapshot can overwrite it.
    const published = mutateRunAtomically(file, corruptStamp, (run) => {
      const currentPlan = this.requireAllowedPlan(runId, latestRunPhase(run), to)
      return currentPlan.phaseChanged
        ? {
          run: recordCheckpoint(
            run,
            runId,
            {ticket: flags.ticket, repository: flags.repository, runtime: flags.runtime},
            {...checkpoint, at: checkpointPublicationAt(run)},
          ),
          value: currentPlan,
        }
        : {value: currentPlan}
    })
    const plan = published.value
    const quarantined = published.quarantined ?? preflight.quarantined

    if (!this.jsonEnabled()) {
      if (quarantined) this.log(`file di stato precedente corrotto → preservato in ${quarantined}`)
      this.printPlan(runId, plan)
    }

    return {dryRun: false, runId, file, quarantined, ...planFields(plan)}
  }

  /** Validates the current plan inside the critical section (or read-only for --dry-run). */
  private requireAllowedPlan(runId: string, from: ReturnType<typeof latestRunPhase>, to: string): TransitionPlan {
    const plan = planTransition(from, to as Parameters<typeof planTransition>[1])
    if (!plan.allowed) {
      throw new AutomatorError(
        ErrorCodes.State.illegalTransition,
        `Transizione non consentita: ${from ?? '∅'} → ${to} (lavorazione ${runId})`,
        3,
      )
    }
    return plan
  }

  /**
   * Composes the checkpoint of the new state. With a resolvable worktree it probes it via git (branch/commit/dirty),
   * like `checkpoint`; without one (transition to waiting/blocked or no checkout) it records only the phase with the
   * git fields set to null — the state machine advances even when there is no work on disk to snapshot.
   */
  private buildCheckpoint(phase: string, flags: TransitionFlags, at: string): Checkpoint {
    const worktree = resolveWorktree(flags)
    if (worktree) {
      return deriveCheckpoint(
        {phase, worktree, artifacts: flags.artifact, commit: flags.commit, outcome: flags.outcome as RunStatus | undefined, at},
        defaultCheckpointGit(),
      )
    }

    const commit = flags.commit?.trim()
    return {
      phase,
      branch: null,
      commit: commit && commit !== '' ? commit : null,
      worktree: null,
      dirty: null,
      artifacts: flags.artifact ?? [],
      outcome: (flags.outcome as RunStatus | undefined) ?? null,
      at,
    }
  }

  private printPlan(runId: string, plan: TransitionPlan): void {
    const change = plan.phaseChanged ? '' : ' (invariato)'
    this.log(`transition ${runId} · ${plan.from ?? '∅'} → ${plan.to}${change}`)
    const cyi = plan.cyiStatusChanged ? ' (da aggiornare)' : ' (invariato)'
    this.log(`  stato CYI: ${plan.cyiStatus}${cyi}`)
  }
}

interface TransitionFlags {
  worktree?: string
  project?: string
  ticket?: string
  commit?: string
  artifact?: string[]
  outcome?: string
}

/** Plan fields to copy into the JSON result (the orchestrator uses `cyiStatusChanged` for the external effect). */
function planFields(plan: TransitionPlan): TransitionPlan {
  return {
    from: plan.from,
    to: plan.to,
    allowed: plan.allowed,
    phaseChanged: plan.phaseChanged,
    cyiStatus: plan.cyiStatus,
    cyiStatusChanged: plan.cyiStatusChanged,
  }
}

/**
 * The worktree to snapshot: explicit (--worktree) or derived from the managed layout (--project + --ticket).
 * OPTIONAL (unlike `checkpoint`): a state transition can happen even without a checkout to
 * probe → null, and the checkpoint records only the state fields.
 */
function resolveWorktree(flags: {worktree?: string; project?: string; ticket?: string}): string | null {
  if (flags.worktree) return flags.worktree
  if (flags.project && flags.ticket) return worktreePath(flags.project, flags.ticket)
  return null
}
