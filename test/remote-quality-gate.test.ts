import {describe, expect, it, vi} from 'vitest'
import {
  finalizeRemoteQualityGate,
  verifyRemoteQualityGate,
  type GitHubCheck,
  type RemoteGateProbe,
} from '../src/lib/remote-quality-gate'
import {QualityGateConfigSchema} from '../src/lib/quality-gate'

const config = QualityGateConfigSchema.parse({
  version: 2,
  checks: [{stage: 'lint', run: 'bin/rubocop'}],
  remote: {
    provider: 'github', required_checks: ['ci / ci-gate', 'migration-versions'],
    timeout: 3, poll_interval: 1,
  },
})

const sha = 'a'.repeat(40)
const prUrl = 'https://github.com/bussolabs/closeyourit-rails/pull/72'
const basePr = {
  url: prUrl, headRefOid: sha, headRefName: 'ticket/CYAU-181', isDraft: true, state: 'OPEN',
}

function check(name: string, bucket: GitHubCheck['bucket']): GitHubCheck {
  return {name, bucket, state: bucket === 'pass' ? 'SUCCESS' : bucket === 'pending' ? 'IN_PROGRESS' : 'FAILURE'}
}

function probe(overrides: Partial<RemoteGateProbe> = {}): RemoteGateProbe {
  return {
    localHead: vi.fn(async () => sha),
    readPr: vi.fn(async () => basePr),
    readChecks: vi.fn(async () => [check('ci / ci-gate', 'pass'), check('migration-versions', 'pass')]),
    markReady: vi.fn(async () => undefined),
    ...overrides,
  }
}

const input = {
  config: config.remote,
  cwd: '/worktree', repository: 'bussolabs/closeyourit-rails',
  branch: 'ticket/CYAU-181', prUrl,
}

describe('remote quality gate — PR and CI attestation on the delivered SHA', () => {
  it('passes only when all required checks are green on the same local and remote HEAD', async () => {
    const result = await verifyRemoteQualityGate(input, {probe: probe()})
    expect(result).toMatchObject({status: 'passed', headSha: sha, requiredChecks: ['ci / ci-gate', 'migration-versions']})
  })

  it('fails immediately on red and reports only the check names, not arbitrary output', async () => {
    const p = probe({readChecks: vi.fn(async () => [
      check('ci / ci-gate', 'fail'), check('ci / test (shard 7/8)', 'fail'),
      check('migration-versions', 'pass'),
    ])})
    const result = await verifyRemoteQualityGate(input, {probe: p})
    expect(result).toMatchObject({
      status: 'failed', failedChecks: ['ci / ci-gate', 'ci / test (shard 7/8)'],
    })
    expect(result.summary).toContain('ci / test (shard 7/8)')
    expect(JSON.stringify(result)).not.toContain('stderr')
  })

  it('a missing or pending check is awaited within the timeout, then stays unavailable fail-closed', async () => {
    let now = 0
    const p = probe({readChecks: vi.fn(async () => [check('ci / ci-gate', 'pass')])})
    const result = await verifyRemoteQualityGate(input, {
      probe: p,
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds },
    })
    expect(result).toMatchObject({status: 'unavailable', pendingChecks: ['migration-versions']})
    expect(p.readChecks).toHaveBeenCalledTimes(4)
  })

  it('also waits for a check that is present but still pending', async () => {
    let now = 0
    const p = probe({readChecks: vi.fn(async () => [
      check('ci / ci-gate', 'pass'), check('migration-versions', 'pending'),
    ])})
    const result = await verifyRemoteQualityGate(input, {
      probe: p,
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds },
    })
    expect(result).toMatchObject({status: 'unavailable', pendingChecks: ['migration-versions']})
  })

  it('considers a cancelled check red even if it has no fail bucket', async () => {
    const p = probe({readChecks: vi.fn(async () => [
      check('ci / ci-gate', 'cancel'), check('migration-versions', 'pass'),
    ])})
    const result = await verifyRemoteQualityGate(input, {probe: p})
    expect(result).toMatchObject({status: 'failed', failedChecks: ['ci / ci-gate']})
  })

  it('rejects PRs of a different repository, branch or SHA before reading the checks', async () => {
    const p = probe({readPr: vi.fn(async () => ({...basePr, headRefOid: 'b'.repeat(40)}))})
    const result = await verifyRemoteQualityGate(input, {probe: p})
    expect(result).toMatchObject({status: 'failed'})
    expect(result.summary).toContain('SHA')
    expect(p.readChecks).not.toHaveBeenCalled()
  })

  it.each([
    [{repository: 'bussolabs/altro-repository'}, basePr, 'repository'],
    [{prUrl: 'https://github.com/bussolabs/closeyourit-rails/issues/72'}, basePr, 'repository'],
    [{}, {...basePr, url: `${prUrl}/files`}, 'URL'],
    [{}, {...basePr, state: 'CLOSED'}, 'aperta'],
    [{}, {...basePr, headRefName: 'ticket/CYAU-999'}, 'branch'],
  ])('fails closed on an unauthorized PR identity', async (inputOverride, snapshot, reason) => {
    const p = probe({readPr: vi.fn(async () => snapshot)})
    const result = await verifyRemoteQualityGate({...input, ...inputOverride}, {probe: p})
    expect(result).toMatchObject({status: 'failed'})
    expect(result.summary).toContain(reason)
    expect(p.readChecks).not.toHaveBeenCalled()
  })

  it('rejects an already ready PR before spending the CI check', async () => {
    const p = probe({readPr: vi.fn(async () => ({...basePr, isDraft: false}))})
    const result = await verifyRemoteQualityGate(input, {probe: p})
    expect(result).toMatchObject({status: 'failed'})
    expect(result.summary).toContain('restare draft')
    expect(p.readChecks).not.toHaveBeenCalled()
  })

  it('stops before the probes when the check is already cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    const p = probe()
    const result = await verifyRemoteQualityGate(input, {probe: p}, controller.signal)
    expect(result).toMatchObject({status: 'unavailable', pendingChecks: config.remote.required_checks})
    expect(result.summary).toContain('annullata')
    expect(p.localHead).not.toHaveBeenCalled()
  })

  it('retries a transient probe error within the gate window', async () => {
    let now = 0
    const p = probe({readChecks: vi.fn()
      .mockRejectedValueOnce(new Error('GitHub temporaneamente non disponibile'))
      .mockResolvedValue([check('ci / ci-gate', 'pass'), check('migration-versions', 'pass')])})
    const result = await verifyRemoteQualityGate(input, {
      probe: p,
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds },
    })
    expect(result.status).toBe('passed')
    expect(p.readChecks).toHaveBeenCalledTimes(2)
  })

  it('fails closed if the wait between two pollings is interrupted', async () => {
    const p = probe({readChecks: vi.fn(async () => [check('ci / ci-gate', 'pass')])})
    const result = await verifyRemoteQualityGate(input, {
      probe: p,
      now: () => 0,
      sleep: async () => { throw new Error('interrotta') },
    })
    expect(result).toMatchObject({status: 'unavailable', pendingChecks: ['migration-versions']})
    expect(result.summary).toContain('annullata')
  })

  it('re-reads the PR after green and fails if the SHA changes during the check', async () => {
    const p = probe({readPr: vi.fn()
      .mockResolvedValueOnce(basePr)
      .mockResolvedValueOnce({...basePr, headRefOid: 'b'.repeat(40)})})
    const result = await verifyRemoteQualityGate(input, {probe: p})
    expect(result).toMatchObject({status: 'failed'})
    expect(result.summary).toContain('cambiato')
  })

  it('does not accept a green duplicate if the same required check also has a red run', async () => {
    const p = probe({readChecks: vi.fn(async () => [
      check('ci / ci-gate', 'pass'), check('ci / ci-gate', 'fail'), check('migration-versions', 'pass'),
    ])})
    const result = await verifyRemoteQualityGate(input, {probe: p})
    expect(result).toMatchObject({status: 'failed', failedChecks: ['ci / ci-gate']})
  })

  it('fails if the PR is made ready while the green is being attested', async () => {
    const p = probe({readPr: vi.fn()
      .mockResolvedValueOnce(basePr)
      .mockResolvedValueOnce({...basePr, isDraft: false})})
    const result = await verifyRemoteQualityGate(input, {probe: p})
    expect(result).toMatchObject({status: 'failed'})
    expect(result.summary).toContain('cambiato')
  })

  it('makes the PR ready only after a new SHA attestation and verifies the result', async () => {
    const p = probe({readPr: vi.fn()
      .mockResolvedValueOnce(basePr)
      .mockResolvedValueOnce({...basePr, isDraft: false})})
    const result = await finalizeRemoteQualityGate(input, sha, {probe: p})
    expect(result.status).toBe('passed')
    expect(p.markReady).toHaveBeenCalledWith(prUrl, '/worktree')
  })

  it('does not make a PR ready if the local commit is no longer the verified one', async () => {
    const p = probe({localHead: vi.fn(async () => 'b'.repeat(40))})
    const result = await finalizeRemoteQualityGate(input, sha, {probe: p})
    expect(result.status).toBe('failed')
    expect(p.markReady).not.toHaveBeenCalled()
  })

  it('is idempotent when the PR is already ready on the verified commit', async () => {
    const readyPr = {...basePr, isDraft: false}
    const p = probe({readPr: vi.fn(async () => readyPr)})
    const result = await finalizeRemoteQualityGate(input, sha, {probe: p})
    expect(result.status).toBe('passed')
    expect(p.markReady).not.toHaveBeenCalled()
  })

  it('fails closed if GitHub leaves the PR draft after the promotion', async () => {
    const p = probe({readPr: vi.fn(async () => basePr)})
    const result = await finalizeRemoteQualityGate(input, sha, {probe: p})
    expect(result).toMatchObject({status: 'failed'})
    expect(result.summary).toContain('rimasta draft')
    expect(p.markReady).toHaveBeenCalledOnce()
  })

  it('does not attest the promotion if a remote probe fails', async () => {
    const p = probe({markReady: vi.fn(async () => { throw new Error('GitHub non disponibile') })})
    const result = await finalizeRemoteQualityGate(input, sha, {probe: p})
    expect(result).toMatchObject({status: 'unavailable', pendingChecks: []})
  })
})
