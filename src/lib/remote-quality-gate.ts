import {spawnSync} from 'node:child_process'
import {z} from 'zod'
import {isGitHubPrUrl} from './github-pr-url'
import {type RemoteQualityGateConfig} from './quality-gate'

export type GitHubCheckBucket = 'pass' | 'fail' | 'pending' | 'skipping' | 'cancel'

export interface GitHubCheck {
  name: string
  bucket: GitHubCheckBucket
  state: string
}

export interface GitHubPrSnapshot {
  url: string
  headRefOid: string
  headRefName: string
  isDraft: boolean
  state: string
}

export interface RemoteGateProbe {
  localHead(cwd: string): Promise<string>
  readPr(prUrl: string, cwd: string): Promise<GitHubPrSnapshot>
  readChecks(prUrl: string, cwd: string): Promise<GitHubCheck[]>
  markReady(prUrl: string, cwd: string): Promise<void>
}

export interface RemoteGateInput {
  config: RemoteQualityGateConfig
  cwd: string
  repository: string
  branch: string
  prUrl: string
}

export type RemoteGateResult =
  | {status: 'passed'; summary: string; headSha: string; requiredChecks: string[]}
  | {status: 'failed'; summary: string; failedChecks?: string[]}
  | {status: 'unavailable'; summary: string; pendingChecks: string[]}

export interface RemoteGateDeps {
  probe?: RemoteGateProbe
  now?: () => number
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>
}

const PrSchema = z.object({
  url: z.string(), headRefOid: z.string().regex(/^[0-9a-f]{40}$/iu), headRefName: z.string(),
  isDraft: z.boolean(), state: z.string(),
}).strict()
const ChecksSchema = z.array(z.object({
  name: z.string(), bucket: z.enum(['pass', 'fail', 'pending', 'skipping', 'cancel']), state: z.string(),
}).passthrough())

function run(command: string, args: string[], cwd: string, acceptedStatuses: readonly number[] = [0]): string {
  const result = spawnSync(command, args, {cwd, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024})
  if (result.error || result.status === null || !acceptedStatuses.includes(result.status)) {
    throw new Error(`${command} non disponibile`)
  }
  return result.stdout.trim()
}

/** Real probe: argv array, output validated and never propagated into reports. */
export function defaultRemoteGateProbe(): RemoteGateProbe {
  return {
    async localHead(cwd) {
      const sha = run('git', ['rev-parse', 'HEAD'], cwd)
      if (!/^[0-9a-f]{40}$/iu.test(sha)) throw new Error('HEAD locale non interpretabile')
      return sha.toLowerCase()
    },
    async readPr(prUrl, cwd) {
      return PrSchema.parse(JSON.parse(run('gh', [
        'pr', 'view', prUrl, '--json', 'url,headRefOid,headRefName,isDraft,state',
      ], cwd)))
    },
    async readChecks(prUrl, cwd) {
      // `gh pr checks` uses exit 1 when a check is red and exit 8 when it is still pending, even though with
      // `--json` it returned the valid data we must judge. Accepting the transport here does not mean
      // accepting the verdict: `inspectChecks` stays fail-closed on the buckets.
      return ChecksSchema.parse(JSON.parse(run('gh', [
        'pr', 'checks', prUrl, '--json', 'name,bucket,state',
      ], cwd, [0, 1, 8])))
    },
    async markReady(prUrl, cwd) {
      run('gh', ['pr', 'ready', prUrl], cwd)
    },
  }
}

function repositoryFromPrUrl(prUrl: string): string | null {
  if (!isGitHubPrUrl(prUrl)) return null
  const parts = new URL(prUrl).pathname.split('/').filter(Boolean)
  return parts.length === 4 ? `${parts[0]}/${parts[1]}` : null
}

function identityFailure(
  input: RemoteGateInput,
  snapshot: GitHubPrSnapshot,
  localHead: string,
  expectedSha = localHead,
): string | null {
  if (repositoryFromPrUrl(input.prUrl)?.toLowerCase() !== input.repository.trim().toLowerCase()) {
    return 'repository della PR diverso da quello autorizzato'
  }
  if (snapshot.url !== input.prUrl || snapshot.state !== 'OPEN') return 'PR non aperta o identità URL divergente'
  if (snapshot.headRefName !== input.branch) return 'branch della PR diverso dal branch autorizzato'
  if (localHead !== expectedSha || snapshot.headRefOid.toLowerCase() !== expectedSha) {
    return 'SHA della PR diverso dal commit locale autorizzato'
  }
  return null
}

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('attesa CI annullata'))
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('attesa CI annullata'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    signal?.addEventListener('abort', onAbort, {once: true})
  })
}

function inspectChecks(required: string[], checks: GitHubCheck[]): {
  status: 'passed' | 'failed' | 'pending'
  failed: string[]
  pending: string[]
} {
  const failed: string[] = []
  const pending: string[] = []
  for (const name of required) {
    const matching = checks.filter((check) => check.name === name)
    // GitHub can return several checks with the same name (reruns or concurrent suites). A single green must
    // not hide a red/pending duplicate: the policy passes only if ALL current occurrences
    // of the required name are green.
    if (matching.length === 0 || matching.some((check) => check.bucket === 'pending')) pending.push(name)
    else if (matching.some((check) => check.bucket !== 'pass')) failed.push(name)
  }
  return {status: failed.length > 0 ? 'failed' : pending.length > 0 ? 'pending' : 'passed', failed, pending}
}

/**
 * Waits for the draft PR's CI and binds it to repository + branch + local HEAD. Re-reads the identity after the green:
 * a push that happened during polling invalidates the attestation instead of reusing checks of the previous commit.
 */
export async function verifyRemoteQualityGate(
  input: RemoteGateInput,
  deps: RemoteGateDeps = {},
  signal?: AbortSignal,
): Promise<RemoteGateResult> {
  const probe = deps.probe ?? defaultRemoteGateProbe()
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? defaultSleep
  const startedAt = now()
  const timeoutMs = input.config.timeout * 1000
  let pendingChecks = [...input.config.required_checks]

  while (true) {
    if (signal?.aborted) return {status: 'unavailable', summary: 'attesa CI annullata', pendingChecks}
    try {
      const localHead = await probe.localHead(input.cwd)
      const snapshot = await probe.readPr(input.prUrl, input.cwd)
      const identity = identityFailure(input, snapshot, localHead)
      if (identity) return {status: 'failed', summary: identity}
      if (!snapshot.isDraft) return {status: 'failed', summary: 'la PR deve restare draft fino a CI e cross-review verdi'}

      const checks = await probe.readChecks(input.prUrl, input.cwd)
      const verdict = inspectChecks(input.config.required_checks, checks)
      pendingChecks = verdict.pending
      if (verdict.status === 'failed') {
        // The aggregate gate says the CI is red; the red child checks say WHERE. We carry only structured
        // names (never arbitrary output/logs) into the retry prompt, so the implementer does not have to guess.
        const diagnostics = [...new Set(checks
          .filter((check) => check.bucket === 'fail' || check.bucket === 'cancel')
          .map((check) => check.name))]
        const failedChecks = [...new Set([...verdict.failed, ...diagnostics])]
        return {
          status: 'failed', summary: `CI rossa: ${failedChecks.join(', ')}`,
          failedChecks,
        }
      }
      if (verdict.status === 'passed') {
        const finalLocalHead = await probe.localHead(input.cwd)
        const finalSnapshot = await probe.readPr(input.prUrl, input.cwd)
        if (identityFailure(input, finalSnapshot, finalLocalHead, localHead) || !finalSnapshot.isDraft) {
          return {status: 'failed', summary: 'SHA o identità della PR cambiato durante il controllo CI'}
        }
        return {
          status: 'passed', summary: `CI verde su ${localHead}`,
          headSha: localHead, requiredChecks: [...input.config.required_checks],
        }
      }
    } catch {
      // Outage or invalid response: retry within the same window, without delivering or spending a review.
    }

    const elapsed = now() - startedAt
    if (elapsed >= timeoutMs) {
      return {status: 'unavailable', summary: 'CI non attestabile entro il timeout', pendingChecks}
    }
    try {
      await sleep(Math.min(input.config.poll_interval * 1000, timeoutMs - elapsed), signal)
    } catch {
      return {status: 'unavailable', summary: 'attesa CI annullata', pendingChecks}
    }
  }
}

/** Promotes draft→ready only if the already verified commit is still the local and remote HEAD; idempotent on recovery. */
export async function finalizeRemoteQualityGate(
  input: RemoteGateInput,
  verifiedSha: string,
  deps: Pick<RemoteGateDeps, 'probe'> = {},
): Promise<RemoteGateResult> {
  const probe = deps.probe ?? defaultRemoteGateProbe()
  try {
    const localHead = await probe.localHead(input.cwd)
    const before = await probe.readPr(input.prUrl, input.cwd)
    const identity = identityFailure(input, before, localHead, verifiedSha)
    if (identity) return {status: 'failed', summary: identity}
    if (before.isDraft) await probe.markReady(input.prUrl, input.cwd)
    const after = await probe.readPr(input.prUrl, input.cwd)
    const finalIdentity = identityFailure(input, after, await probe.localHead(input.cwd), verifiedSha)
    if (finalIdentity || after.isDraft) {
      return {status: 'failed', summary: finalIdentity ?? 'PR rimasta draft dopo la promozione'}
    }
    return {status: 'passed', summary: `PR pronta sullo SHA ${verifiedSha}`, headSha: verifiedSha, requiredChecks: []}
  } catch {
    return {status: 'unavailable', summary: 'promozione della PR non attestabile', pendingChecks: []}
  }
}
