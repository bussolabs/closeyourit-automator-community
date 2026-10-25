import {Args, Flags} from '@oclif/core'
import {BaseCommand} from '../base'
import {defaultCheckpointGit, deriveCheckpoint} from '../lib/checkpoint'
import {checkpointPublicationAt, type Checkpoint as CheckpointData, mutateRunAtomically, recordCheckpoint, runPath, type RunStatus} from '../lib/state'
import {worktreePath} from '../lib/workspace'
import {AutomatorError, ErrorCodes} from '../errors/error-codes'

const OUTCOMES = ['success', 'failure', 'timeout', 'skipped'] as const

export default class Checkpoint extends BaseCommand {
  static description =
    'Registra il checkpoint di una fase di lavorazione: sonda il worktree (branch, commit, dirty state) e lo persiste in modo atomico e append (mai sovrascrive lo storico) in un file dedicato per lavorazione (runs/<run-id>.json), separato dallo state del daemon → la lavorazione può riprendere dopo un\'interruzione senza lost-update. Un file precedente corrotto viene preservato in quarantena, mai sovrascritto'

  static examples = [
    '<%= config.bin %> checkpoint run-42 implement --worktree /w/CYAU/CYAU-12 --ticket CYAU-12 --repository acme/widget',
    '<%= config.bin %> checkpoint run-42 commit --project CYAU --ticket CYAU-12 --commit deadbeef --outcome success',
  ]

  static args = {
    'run-id': Args.string({description: 'identificativo stabile della lavorazione (nome del file di checkpoint)', required: true}),
    phase: Args.string({description: 'nome della fase completata (es. setup, implement, test, commit, review)', required: true}),
  }

  static flags = {
    ticket: Flags.string({description: 'codice del ticket lavorato (es. CYAU-12)'}),
    repository: Flags.string({description: 'repository della lavorazione, owner/repo'}),
    runtime: Flags.string({description: 'runtime che lavora la lavorazione (es. claude, codex) → mostrato nella dashboard (CYAU-31)'}),
    project: Flags.string({description: 'project-key per derivare il worktree gestito (worktrees/<project>/<ticket>); richiede --ticket'}),
    worktree: Flags.string({description: 'path del worktree della lavorazione (alternativa a --project/--ticket)'}),
    commit: Flags.string({description: 'commit da registrare (default: HEAD del worktree)'}),
    artifact: Flags.string({description: 'artefatto prodotto dalla fase (ripetibile)', multiple: true}),
    outcome: Flags.string({description: 'esito della fase', options: [...OUTCOMES]}),
    'dry-run': Flags.boolean({description: 'Deriva e mostra il checkpoint senza persisterlo'}),
  }

  async run(): Promise<unknown> {
    const {args, flags} = await this.parse(Checkpoint)
    const runId = args['run-id']
    // Validate the run-id (file name) BEFORE any I/O: a hostile run-id exits cleanly without probing git or
    // touching the disk (no quarantine on error paths).
    const file = runPath(runId)
    const worktree = resolveWorktree(flags)
    const now = new Date()

    const checkpoint = deriveCheckpoint(
      {
        phase: args.phase,
        worktree,
        artifacts: flags.artifact,
        commit: flags.commit,
        outcome: flags.outcome as RunStatus | undefined,
        at: now.toISOString(),
      },
      defaultCheckpointGit(),
    )

    if (flags['dry-run']) {
      if (!this.jsonEnabled()) this.printCheckpoint(runId, checkpoint)
      return {dryRun: true, runId, file, quarantined: null, ...checkpoint}
    }

    // Read + append + publish are a single transaction under a cross-process lock: a checkpoint arriving
    // during the interleaving is observed before composing the new history, never overwritten by a snapshot.
    const {value: committedCheckpoint, quarantined} = mutateRunAtomically(file, now.toISOString().replace(/[:.]/g, '-'), (run) => {
      const committed = {...checkpoint, at: checkpointPublicationAt(run)}
      return {
        run: recordCheckpoint(run, runId, {ticket: flags.ticket, repository: flags.repository, runtime: flags.runtime}, committed),
        value: committed,
      }
    })

    if (!this.jsonEnabled()) {
      if (quarantined) this.log(`file di stato precedente corrotto → preservato in ${quarantined}`)
      this.printCheckpoint(runId, committedCheckpoint)
    }

    return {dryRun: false, runId, file, quarantined, ...committedCheckpoint}
  }

  private printCheckpoint(runId: string, cp: CheckpointData): void {
    const commit = cp.commit ? cp.commit.slice(0, 12) : '-'
    const dirty = cp.dirty === null ? '' : cp.dirty ? ' (dirty)' : ''
    this.log(`checkpoint ${runId} · ${cp.phase} → ${cp.branch ?? '-'} @ ${commit}${dirty}`)
    this.log(`  worktree: ${cp.worktree ?? '-'}`)
  }
}

/** The worktree is explicit (--worktree) or derived from the managed layout (--project + --ticket); without either, it is an error. */
function resolveWorktree(flags: {worktree?: string; project?: string; ticket?: string}): string {
  if (flags.worktree) return flags.worktree
  if (flags.project && flags.ticket) return worktreePath(flags.project, flags.ticket)
  throw new AutomatorError(
    ErrorCodes.State.noWorktree,
    'Impossibile determinare il worktree della lavorazione: passa --worktree, oppure --project e --ticket',
    2,
  )
}
