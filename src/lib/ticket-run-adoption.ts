import * as fs from 'node:fs'
import * as path from 'node:path'
import {runsDir} from './paths'
import {latestRunPhase} from './state-machine'
import {AgentRunResultSchema} from './agent-result'
import {TicketAutomationEvidenceSchema} from './ticket-evidence'
import {
  isSafeRunId,
  isRecord,
  mutateRunAtomically,
  readRun,
  runPath,
  type Checkpoint,
  type RunRecord,
} from './state'

export interface TicketRunAdoptionInput {
  runId: string
  ticket: string
  repository: string
  expectedBranch: string
  expectedWorktree: string
  runsBase?: string
  now?: () => Date
}

export interface TicketRunAdoptionResult {
  outcome: 'none' | 'adopted' | 'reused'
  sourceRunId: string | null
}

interface StoredRun {
  id: string
  run: RunRecord
  checkpoint: Checkpoint | null
}

interface InvalidStoredRun {
  id: string
  ticket: string | null
  repository: string | null
  adoptedFrom: string | null
}

function approvedInReview(run: RunRecord, checkpoint: Checkpoint | null): boolean {
  const evidence = checkpoint?.automation
  const snapshot = evidence?.gatedSnapshot
  const attestation = evidence?.reviewExecution?.attestation
  return latestRunPhase(run) === 'in_review' && run.result !== undefined && checkpoint !== null &&
    evidence?.gate.verdict.passed === true && snapshot !== null && snapshot !== undefined &&
    evidence.reviewExecution?.status === 'completed' && evidence.reviewVerdict?.verdict === 'approved' &&
    evidence.reviewVerdict.crossReviewed === true && evidence.cycleDecision?.next === 'in_review' &&
    attestation !== null && attestation !== undefined &&
    attestation.reviewedBaseCommit === snapshot.baseCommit &&
    attestation.reviewedSnapshotTree === snapshot.snapshotTree &&
    attestation.reviewedDiffSha256 === snapshot.diffSha256
}

function sameIdentity(run: RunRecord, ticket: string, repository: string): boolean {
  return run.ticket?.toLowerCase() === ticket.toLowerCase() &&
    run.repository?.toLowerCase() === repository.toLowerCase()
}

function rawCheckpointIsValid(value: unknown): boolean {
  // `Checkpoint.phase` has historically been a free string: latestRunPhase ignores non-canonical legacy phases.
  if (!isRecord(value) || typeof value.phase !== 'string') return false
  if (!(typeof value.branch === 'string' || value.branch === null)) return false
  if (!(typeof value.commit === 'string' || value.commit === null)) return false
  if (!(typeof value.worktree === 'string' || value.worktree === null)) return false
  if (!(typeof value.dirty === 'boolean' || value.dirty === null)) return false
  if (!Array.isArray(value.artifacts) || value.artifacts.some((artifact) => typeof artifact !== 'string')) return false
  if (!(value.outcome === null || ['success', 'failure', 'timeout', 'skipped'].includes(String(value.outcome)))) return false
  if (typeof value.at !== 'string') return false
  if (Object.hasOwn(value, 'result') && !AgentRunResultSchema.safeParse(value.result).success) return false
  if (Object.hasOwn(value, 'automation') && !TicketAutomationEvidenceSchema.safeParse(value.automation).success) return false
  return true
}

function rawRunIsValid(value: Record<string, unknown>): boolean {
  return typeof value.run_id === 'string' &&
    (typeof value.ticket === 'string' || value.ticket === null) &&
    (typeof value.repository === 'string' || value.repository === null) &&
    typeof value.updated_at === 'string' &&
    Array.isArray(value.checkpoints) && value.checkpoints.every(rawCheckpointIsValid) &&
    (!Object.hasOwn(value, 'result') || AgentRunResultSchema.safeParse(value.result).success)
}

function listStoredRuns(base: string): {runs: StoredRun[]; invalid: InvalidStoredRun[]} {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(base, {withFileTypes: true})
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {runs: [], invalid: []}
    throw error
  }
  const runs: StoredRun[] = []
  const invalid: InvalidStoredRun[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const id = entry.name.slice(0, -'.json'.length)
    if (!isSafeRunId(id)) continue
    const file = runPath(id, base)
    let raw: unknown
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      invalid.push({id, ticket: null, repository: null, adoptedFrom: null})
      continue
    }
    const ticket = isRecord(raw) && typeof raw.ticket === 'string' ? raw.ticket : null
    const repository = isRecord(raw) && typeof raw.repository === 'string' ? raw.repository : null
    const adoptedFrom = isRecord(raw) && typeof raw.adopted_from === 'string' && isSafeRunId(raw.adopted_from)
      ? raw.adopted_from
      : null
    const malformedLineage = isRecord(raw) && Object.hasOwn(raw, 'adopted_from') && adoptedFrom === null
    if (!isRecord(raw) || malformedLineage || !rawRunIsValid(raw)) {
      invalid.push({id, ticket, repository, adoptedFrom})
      continue
    }
    const loaded = readRun(file)
    if (loaded.corrupt || !loaded.run || loaded.run.checkpoints.length !== (raw.checkpoints as unknown[]).length) {
      invalid.push({id, ticket, repository, adoptedFrom})
      continue
    }
    runs.push({id, run: loaded.run, checkpoint: loaded.run.checkpoints.at(-1) ?? null})
  }
  return {runs, invalid}
}

function sameCanonicalPath(left: string | null, right: string): boolean {
  if (!left || !path.isAbsolute(left) || !path.isAbsolute(right)) return false
  try {
    return fs.realpathSync(left) === fs.realpathSync(right)
  } catch {
    return false
  }
}

/**
 * Adopts the single compatible `in_review` leaf into the new server run-id. The old record stays unchanged for
 * audit; `adopted_from` makes the chain crash-safe and allows ignoring the ancestors without a second write.
 */
export function adoptRecoverableTicketRun(input: TicketRunAdoptionInput): TicketRunAdoptionResult {
  if (!isSafeRunId(input.runId)) throw new Error('run-id di adozione non valido')
  const base = input.runsBase ?? runsDir()
  const stored = listStoredRuns(base)
  const all = stored.runs
  const byId = new Map(all.map((entry) => [entry.id, entry]))
  const matching = all.filter(({run}) => sameIdentity(run, input.ticket, input.repository))
  // Without any valid `in_review` run there is nothing to adopt: corrupt files without a readable edge
  // to this ticket must not block fresh, independent claims forever.
  if (!matching.some(({run}) => latestRunPhase(run) === 'in_review')) {
    return {outcome: 'none', sourceRunId: null}
  }

  const matchingIds = new Set(matching.map(({id}) => id))
  const relevantInvalid = stored.invalid.some((entry) =>
    (entry.ticket?.toLowerCase() === input.ticket.toLowerCase() &&
      entry.repository?.toLowerCase() === input.repository.toLowerCase()) ||
    (entry.adoptedFrom !== null && matchingIds.has(entry.adoptedFrom)))
  if (relevantInvalid) throw new Error('stato o lineage recovery corrotto non attestabile')

  for (const entry of all) {
    if (entry.run.run_id !== entry.id) throw new Error('identità file/run non attestabile durante il recovery')
    if (entry.run.adopted_from) {
      const parent = byId.get(entry.run.adopted_from)
      if (!parent) throw new Error('lineage recovery incompleta o non attestabile')
      if (!sameIdentity(entry.run, parent.run.ticket ?? '', parent.run.repository ?? '')) {
        throw new Error('lineage recovery attraversa identità ticket/repository differenti')
      }
    }
  }

  const children = new Map<string, number>()
  for (const {run} of all) {
    if (!run.adopted_from) continue
    children.set(run.adopted_from, (children.get(run.adopted_from) ?? 0) + 1)
  }
  if ([...children.values()].some((count) => count > 1)) {
    throw new Error('lineage recovery biforcata: adozione ambigua')
  }

  for (const entry of all) {
    const visited = new Set<string>()
    let cursor: StoredRun | undefined = entry
    while (cursor?.run.adopted_from) {
      if (visited.has(cursor.id)) throw new Error('lineage recovery ciclica: adozione ambigua')
      visited.add(cursor.id)
      cursor = byId.get(cursor.run.adopted_from)
    }
  }

  const candidates = matching.filter((entry) => latestRunPhase(entry.run) === 'in_review' && !children.has(entry.id))
  for (const candidate of candidates) {
    if (!approvedInReview(candidate.run, candidate.checkpoint)) {
      throw new Error('checkpoint in_review privo di attestazione gate/review valida')
    }
    if (candidate.checkpoint?.branch !== input.expectedBranch ||
      !sameCanonicalPath(candidate.checkpoint?.worktree ?? null, input.expectedWorktree)) {
      throw new Error('workspace/branch del recovery non attestabili')
    }
  }
  if (candidates.length > 1) throw new Error('più run in_review recuperabili: adozione ambigua')
  const source = candidates[0]
  if (!source) return {outcome: 'none', sourceRunId: null}
  if (source.id === input.runId) return {outcome: 'reused', sourceRunId: source.id}

  const checkpoint = source.checkpoint!
  const observedAt = (input.now ?? (() => new Date()))().toISOString()
  mutateRunAtomically(runPath(input.runId, base), observedAt.replace(/[:.]/g, '-'), (existing) => {
    if (existing) {
      throw new Error('il nuovo run-id possiede già uno stato incompatibile con l’adozione')
    }
    return {
      run: {
        run_id: input.runId,
        adopted_from: source.id,
        ticket: source.run.ticket,
        repository: source.run.repository,
        ...(source.run.runtime ? {runtime: source.run.runtime} : {}),
        updated_at: observedAt,
        result: source.run.result!,
        checkpoints: [{
          ...checkpoint,
          at: observedAt,
          result: source.run.result!,
          artifacts: [...new Set([...checkpoint.artifacts, `adopted-from:${source.id}`])],
        }],
      },
      value: undefined,
    }
  })
  return {outcome: 'adopted', sourceRunId: source.id}
}
