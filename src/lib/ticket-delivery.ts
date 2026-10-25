import {automatorGitIdentityEnv} from './git-identity'
import {spawnSync} from 'node:child_process'
import {realpathSync} from 'node:fs'
import * as path from 'node:path'
import {type AgentRunResult} from './agent-result'
import {
  assertDeliverableBranch,
  assertSafeDeliveryRef,
  DeliveryProgressPause,
  prContentFromResult,
  runDelivery,
  type DeliveryProbe,
  type DeliveryProgress,
  type DeliveryResult,
} from './deliver'
import {runPublish, type KbKind, type KbPublisher, type PublishRepo, type PublishResult} from './publish'
import {
  TicketDeliveryEvidenceSchema,
  type TicketAutomationEvidence,
  type TicketDeliveryEvidence,
} from './ticket-evidence'
import {AutomatorError, ErrorCodes} from '../errors/error-codes'
import {redactSecrets} from './secret-redaction'

export interface KnowledgeArtifact {
  sourceFile: string
  title: string
  kind: KbKind
}

export interface ApprovedCommitInput {
  cwd: string
  branch: string
  baseCommit: string
  snapshotTree: string
  message: string
}

export interface TicketDeliveryGit {
  /** Creates (or reuses) the commit that materializes exactly the approved tree. */
  commitApproved(input: ApprovedCommitInput): string
  /** Re-attests a commit recovered from the checkpoint before any remote effect. */
  attestCommit(input: ApprovedCommitInput & {commit: string}): void
}

export interface TicketDeliveryInput {
  project: string
  ticket: string
  runId: string
  cwd: string
  branch: string
  /** Trusted `origin/<default-branch>` ref used by gate and review. */
  trustedBase: string
  authorized: boolean
  automation: TicketAutomationEvidence
  result: AgentRunResult
  knowledgeArtifacts: KnowledgeArtifact[]
  signal?: AbortSignal
}

export interface TicketDeliveryDeps {
  git: TicketDeliveryGit
  delivery: DeliveryProbe
  publishRepo: PublishRepo
  kb: KbPublisher
  /** Durability before the next step. If it fails, execution stops fail-closed. */
  persist(evidence: TicketDeliveryEvidence): void
}

export interface TicketDeliveryResult {
  status: 'completed' | 'suspended'
  evidence: TicketDeliveryEvidence
  delivery: DeliveryResult | null
  publications: PublishResult[]
  artifacts: string[]
}

function initialEvidence(input: TicketDeliveryInput): TicketDeliveryEvidence {
  return {
    commit: null,
    branch: input.branch,
    base: trustedPrBase(input.trustedBase),
    delivery: {pushed: false, prUrl: null, prCreated: false, linked: false, cyiStatusSet: false},
    publications: [],
  }
}

function assertApproved(input: TicketDeliveryInput): void {
  const evidence = input.automation
  const attestation = evidence.reviewExecution?.attestation
  const snapshot = evidence.gatedSnapshot
  if (!evidence.gate.verdict.passed || !snapshot || evidence.reviewExecution?.status !== 'completed' ||
    evidence.reviewVerdict?.verdict !== 'approved' || evidence.reviewVerdict.crossReviewed !== true ||
    evidence.cycleDecision?.next !== 'in_review' || !attestation ||
    attestation.reviewedBaseCommit !== snapshot.baseCommit ||
    attestation.reviewedSnapshotTree !== snapshot.snapshotTree ||
    attestation.reviewedDiffSha256 !== snapshot.diffSha256) {
    throw new AutomatorError(ErrorCodes.Deliver.gateNotPassed, 'Delivery vietata: gate/review attestati non approvati', 3)
  }
}

/** Converts only `origin/<segment>` into the GitHub base; arbitrary refs/options stay fail-closed. */
export function trustedPrBase(base: string): string {
  if (!base.startsWith('origin/')) {
    throw new AutomatorError(ErrorCodes.Deliver.invalidInput, `Base trusted non valida: "${base}"`, 2)
  }
  const branch = base.slice('origin/'.length)
  if (branch === 'HEAD') throw new AutomatorError(ErrorCodes.Deliver.invalidInput, 'Base default non risolta (origin/HEAD)', 2)
  try {
    assertSafeDeliveryRef(branch, 'base')
    return branch
  } catch {
    throw new AutomatorError(ErrorCodes.Deliver.invalidInput, `Base trusted non valida: "${base}"`, 2)
  }
}

/** Prudent default: only canonical Markdown under docs/ or .closeyourit/knowledge, deduplicated and sorted. */
export function knowledgeArtifactsFromResult(result: AgentRunResult): KnowledgeArtifact[] {
  const files = [...new Set(result.changedFiles
    .filter((file) => redactSecrets(file) === file)
    .map((file) => path.posix.normalize(file.split(path.sep).join('/'))))].sort()
  return files
    .filter((file) => /^(?:docs|\.closeyourit\/knowledge)\/.+\.md$/i.test(file))
    .map((sourceFile) => {
      const basename = path.posix.basename(sourceFile, path.posix.extname(sourceFile))
      const title = basename.replaceAll(/[-_]+/g, ' ').trim()
      return {sourceFile, title, kind: /(^|\/)adr\//i.test(sourceFile) ? 'decision' : 'guide'}
    })
}

function copyEvidence(value: TicketDeliveryEvidence): TicketDeliveryEvidence {
  return TicketDeliveryEvidenceSchema.parse(value)
}

/**
 * Crash-safe delivery: every effect is followed by a checkpoint. The retry re-attests the commit, reuses the already
 * existing PR/comment and publication_key, so it converges without duplicating. No merge/delete is exposed by the contracts.
 */
function assertActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AutomatorError(ErrorCodes.Deliver.commandFailed, 'Delivery annullata', 1)
}

async function yieldForLease(signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
  assertActive(signal)
}

export async function runTicketDelivery(
  input: TicketDeliveryInput,
  deps: TicketDeliveryDeps,
  recovered?: TicketDeliveryEvidence | null,
): Promise<TicketDeliveryResult> {
  assertDeliverableBranch(input.branch)
  if (input.branch.toLowerCase() !== `ticket/${input.ticket}`.toLowerCase()) {
    throw new AutomatorError(ErrorCodes.Deliver.invalidBranch, 'Il branch ticket non corrisponde al ticket consegnato', 2)
  }
  assertApproved(input)
  const snapshot = input.automation.gatedSnapshot!
  let evidence = recovered ? copyEvidence(recovered) : initialEvidence(input)
  if (evidence.branch !== input.branch || evidence.base !== trustedPrBase(input.trustedBase)) {
    throw new AutomatorError(ErrorCodes.Deliver.invalidInput, 'Checkpoint delivery non coerente con branch/base trusted', 2)
  }

  const commitInput: ApprovedCommitInput = {
    cwd: input.cwd,
    branch: input.branch,
    baseCommit: snapshot.baseCommit,
    snapshotTree: snapshot.snapshotTree,
    message: `${input.ticket}: ${redactSecrets(input.result.summary?.split('\n')[0].trim() || 'consegna automatica')}`,
  }
  assertActive(input.signal)
  if (evidence.commit) deps.git.attestCommit({...commitInput, commit: evidence.commit})
  else {
    evidence = {...evidence, commit: deps.git.commitApproved(commitInput)}
    deps.persist(copyEvidence(evidence))
  }
  await yieldForLease(input.signal)

  // The local commit is recoverable and does not communicate outside. Every remote effect requires an explicit capability.
  if (!input.authorized) return {
    status: 'suspended', evidence, delivery: null, publications: [],
    artifacts: [`commit:${evidence.commit}`, `branch:${evidence.branch}`],
  }

  let delivery: DeliveryResult
  while (true) {
    assertActive(input.signal)
    try {
      delivery = runDelivery({
        content: prContentFromResult(input.ticket, input.result),
        branch: input.branch,
        cwd: input.cwd,
        gatePassed: true,
        base: evidence.base,
        progress: evidence.delivery,
        pauseAfterProgress: true,
        onProgress(progress: DeliveryProgress) {
          evidence = {...evidence, delivery: progress}
          deps.persist(copyEvidence(evidence))
        },
      }, deps.delivery)
      break
    } catch (error) {
      if (!(error instanceof DeliveryProgressPause)) throw error
      await yieldForLease(input.signal)
    }
  }

  const publications: PublishResult[] = []
  const seen = new Set<string>()
  for (const artifact of input.knowledgeArtifacts) {
    assertActive(input.signal)
    const canonical = path.posix.normalize(artifact.sourceFile.split(path.sep).join('/'))
    if (seen.has(canonical)) continue
    seen.add(canonical)
    const previous = evidence.publications.find((entry) => entry.sourceFile === canonical)
    if (previous) continue
    const published = runPublish({
      project: input.project,
      title: artifact.title,
      kind: artifact.kind,
      sourceFile: canonical,
      cwd: input.cwd,
      ticket: input.ticket,
      runId: input.runId,
      commit: evidence.commit,
    }, deps.publishRepo, deps.kb)
    publications.push(published)
    evidence = {
      ...evidence,
      publications: [...evidence.publications, {
        sourceFile: published.sourceFile,
        pageId: published.pageId,
        publicationKey: published.publicationKey,
        action: published.action,
      }],
    }
    deps.persist(copyEvidence(evidence))
    await yieldForLease(input.signal)
  }

  const artifacts = [
    `commit:${evidence.commit}`,
    `branch:${evidence.branch}`,
    `pr:${delivery.prUrl}`,
    ...evidence.publications.map((entry) => `knowledge:${entry.pageId}`),
  ]
  return {status: 'completed', evidence, delivery, publications, artifacts}
}

export type TicketDeliveryCommandRunner = (args: string[], cwd: string) => {status: number | null; stdout: string; stderr: string}

export function defaultGitRun(args: string[], cwd: string): {status: number | null; stdout: string; stderr: string} {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 15_000,
    killSignal: 'SIGTERM',
    env: {
      PATH: process.env.PATH,
      LANG: process.env.LANG,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      ...automatorGitIdentityEnv(),
    },
  })
  return {status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? ''}
}

/**
 * CYAU-178 — the commit id of the code the host REALLY holds, read from the managed working copy.
 *
 * It does not go through `deriveCheckpoint`: that one has no timeout and lets the commit DECLARED
 * by the agent win over the probed HEAD — i.e. exactly the kind of data we are here stopping
 * taking at face value. Here we only measure, with the same runner used for the delivery: 15-second
 * timeout, no hooks and no global machine configuration.
 *
 * `undefined` when it could not be measured. No value is invented and no fallback to another
 * commit: a wrong id is worse than a missing one, because it would pass the checks.
 */
export function observedHeadSha(
  cwd: string,
  run: TicketDeliveryCommandRunner = defaultGitRun,
): string | undefined {
  try {
    const result = run(['rev-parse', 'HEAD'], cwd)
    if (result.status !== 0) return undefined
    const sha = result.stdout.trim()
    return /^[0-9a-f]{40}$/u.test(sha) ? sha : undefined
  } catch {
    return undefined
  }
}

// Limits of the deliverable changeset (CYAU-142): well ABOVE real work (even a large refactoring
// touches tens/a few hundred files) and BELOW the observed incident (15,608 files / 372 MB). A dependency install
// that ended up in the worktree — or any other abnormal output that escaped the managed ignore — is stopped BEFORE
// committing: removing it afterwards is not enough, the blobs stay in history and the push fails halfway, repeatedly.
export const CHANGESET_MAX_FILES = 1000
export const CHANGESET_MAX_BYTES = 100 * 1024 * 1024

export interface ChangesetSize {
  files: number
  bytes: number
}

/**
 * PURE, auditable gate: rejects an abnormal changeset fail-closed (exit 3), before any commit or remote
 * effect. "Too many files OR too much weight" → it stops. Repeatable and testable without git.
 */
export function assertChangesetWithinLimits(
  changeset: ChangesetSize,
  limits: {maxFiles: number; maxBytes: number} = {maxFiles: CHANGESET_MAX_FILES, maxBytes: CHANGESET_MAX_BYTES},
): void {
  const advice = 'Quasi sempre è un dependency-install finito nel worktree: consegna solo il codice'
  if (changeset.files > limits.maxFiles) {
    throw new AutomatorError(
      ErrorCodes.Deliver.changesetTooLarge,
      `Changeset abnorme: ${changeset.files} file da committare (limite ${limits.maxFiles}). ${advice}`,
      3,
    )
  }
  if (changeset.bytes > limits.maxBytes) {
    const mib = (n: number): number => Math.round(n / (1024 * 1024))
    throw new AutomatorError(
      ErrorCodes.Deliver.changesetTooLarge,
      `Changeset abnorme: ${mib(changeset.bytes)} MiB da committare (limite ${mib(limits.maxBytes)} MiB). ${advice}`,
      3,
    )
  }
}

/**
 * Measures the `baseCommit..snapshotTree` changeset (added/modified/renamed files and their weight) by reading IMMUTABLE
 * Git trees: independent of index/HEAD, so valid even before the commit. Short-circuits on the number of
 * files — beyond the limit the weight of thousands of blobs is not listed (the gate blocks on the count anyway).
 */
export function measureChangeset(
  cwd: string,
  baseCommit: string,
  snapshotTree: string,
  execute: (cwd: string, args: string[], allowedStatuses?: readonly (number | null)[]) => string,
): ChangesetSize {
  const raw = execute(cwd, ['diff', '--name-only', '-z', '--diff-filter=ACMR', baseCommit, snapshotTree])
  const files = raw.split('\0').filter((entry) => entry !== '')
  if (files.length === 0 || files.length > CHANGESET_MAX_FILES) return {files: files.length, bytes: 0}
  const listing = execute(cwd, ['ls-tree', '-r', '-l', '-z', snapshotTree, '--', ...files])
  let bytes = 0
  for (const entry of listing.split('\0')) {
    if (entry === '') continue
    // `<mode> blob <sha> <size>\t<path>` (`-l` = with size, right-justified: split on whitespace)
    const size = Number((entry.split('\t')[0] ?? '').trim().split(/\s+/)[3])
    if (Number.isFinite(size)) bytes += size
  }
  return {files: files.length, bytes}
}

/** Local Git: no remote, no hook, commit only if the staged tree matches the review byte for byte. */
export function defaultTicketDeliveryGit(run: TicketDeliveryCommandRunner = defaultGitRun): TicketDeliveryGit {
  const execute = (cwd: string, args: string[], allowedStatuses: readonly (number | null)[] = [0]): string => {
    const result = run([
      '--no-pager',
      '-c', 'core.fsmonitor=false',
      '-c', 'core.hooksPath=/dev/null',
      '-c', 'credential.helper=',
      '-c', 'protocol.allow=never',
      ...args,
    ], cwd)
    if (!allowedStatuses.includes(result.status)) {
      throw new AutomatorError(ErrorCodes.Deliver.commandFailed, `git delivery fallito: ${result.stderr.trim() || `exit ${result.status}`}`, 1)
    }
    return result.stdout.trim()
  }
  const verifyIdentity = (input: ApprovedCommitInput): void => {
    if (realpathSync(execute(input.cwd, ['rev-parse', '--show-toplevel'])) !== realpathSync(path.resolve(input.cwd))) {
      throw new AutomatorError(ErrorCodes.Deliver.invalidInput, 'Worktree delivery non canonico', 2)
    }
    if (execute(input.cwd, ['rev-parse', '--abbrev-ref', 'HEAD']) !== input.branch) {
      throw new AutomatorError(ErrorCodes.Deliver.invalidBranch, 'Branch corrente mutato prima della delivery', 2)
    }
    execute(input.cwd, ['merge-base', '--is-ancestor', input.baseCommit, 'HEAD'])
    // A local clean/process filter can run code during `git add`: the delivery does not need it and it is
    // rejected entirely. The global/system config is already excluded from the real runner's environment.
    const filters = execute(input.cwd, ['config', '--local', '--get-regexp', '^filter\\.'], [0, 1])
    if (filters !== '') throw new AutomatorError(ErrorCodes.Deliver.invalidInput, 'Git clean filter locale non consentito in delivery', 2)
  }
  return {
    commitApproved(input) {
      verifyIdentity(input)
      const existingTree = execute(input.cwd, ['rev-parse', 'HEAD^{tree}']).toLowerCase()
      if (existingTree === input.snapshotTree.toLowerCase()) {
        // The approved tree is already in HEAD: the changeset gate runs anyway, so an abnormal commit does not pass
        // even when it is reused (CYAU-142). The tree is confirmed real here.
        assertChangesetWithinLimits(measureChangeset(input.cwd, input.baseCommit, input.snapshotTree, execute))
        return execute(input.cwd, ['rev-parse', 'HEAD']).toLowerCase()
      }
      // Full staging: includes the new files legitimately present in the approved snapshot. A file that appeared
      // after the review changes the write-tree and is rejected by the comparison below; ignored files stay out.
      execute(input.cwd, ['add', '--all', '--', '.'])
      const stagedTree = execute(input.cwd, ['write-tree']).toLowerCase()
      if (stagedTree !== input.snapshotTree.toLowerCase()) {
        throw new AutomatorError(ErrorCodes.Deliver.invalidInput, 'TOCTOU: il tree da committare non coincide con lo snapshot approvato', 2)
      }
      // Changeset gate BEFORE the commit: "stopped before, not after". The tree is confirmed == approved snapshot.
      assertChangesetWithinLimits(measureChangeset(input.cwd, input.baseCommit, input.snapshotTree, execute))
      execute(input.cwd, ['commit', '--no-gpg-sign', '-m', input.message])
      const commit = execute(input.cwd, ['rev-parse', 'HEAD']).toLowerCase()
      this.attestCommit({...input, commit})
      return commit
    },
    attestCommit(input) {
      verifyIdentity(input)
      const head = execute(input.cwd, ['rev-parse', 'HEAD']).toLowerCase()
      const tree = execute(input.cwd, ['rev-parse', `${input.commit}^{tree}`]).toLowerCase()
      if (head !== input.commit.toLowerCase() || tree !== input.snapshotTree.toLowerCase()) {
        throw new AutomatorError(ErrorCodes.Deliver.invalidInput, 'Commit delivery recuperato non più attestabile', 2)
      }
    },
  }
}
