import {execFileSync} from 'node:child_process'
import {existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterAll, describe, expect, it} from 'vitest'
import {
  attestWriteConfinement,
  composeBwrapArgs,
  defaultWriteConfinementIo,
} from '../src/lib/write-confinement'

// REAL confinement test (CYAU-67, third DoD point): no mocks, the kernel decides.
// On Linux it really runs bubblewrap; elsewhere it checks that the attestation declares itself unavailable.

/**
 * Timeout on EVERY synchronous bwrap invocation. Without it, a process stuck inside the namespace
 * would indefinitely occupy a self-hosted runner, which is persistent and shared.
 * A test that never ends is not a slow test: it is a stalled runner.
 */
const PROBE_TIMEOUT_MS = 15_000

const onLinux = process.platform === 'linux'
const roots: string[] = []

function probeRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'automator-confinement-real-')))
  mkdirSync(join(root, 'inside'))
  mkdirSync(join(root, 'outside'))
  roots.push(root)
  return root
}

afterAll(() => {
  for (const root of roots) rmSync(root, {recursive: true, force: true})
})

/**
 * On Linux the fence is bubblewrap and the kernel decides, without mocks.
 *
 * `AUTOMATOR_REQUIRE_BWRAP_PROBE=1` turns an unusable bwrap into a FAILURE instead of a skip.
 * It is needed because this module exists precisely to not confuse "probe never run" with "perfect
 * fence": a silently skipped test recreates that illusion at a higher level, and CI
 * would say green without having verified anything. Set it ONLY where bwrap really runs.
 */
const bwrapRequired = process.env.AUTOMATOR_REQUIRE_BWRAP_PROBE === '1'

/**
 * Presence != executability. The binary can be there and the kernel still refuse it: on
 * GitHub-hosted runners `bwrap` exists but dies with `setting up uid map: Permission denied` because
 * unprivileged user namespaces are restricted. Deducing "the fence is there" from `existsSync` alone makes
 * the tests fail exactly where the fail-closed behaviour is CORRECT. We probe by running it.
 */
function probeBwrapUsable(): boolean {
  if (!existsSync('/usr/bin/bwrap')) return false
  try {
    // We probe with the REAL ARGUMENTS (`composeBwrapArgs`), not with a simplified bwrap: a host
    // may allow `--ro-bind` and refuse `--unshare-pid` (seccomp, namespace restrictions).
    // Probing a configuration more permissive than the real one would declare usable a fence that
    // then fails, and the negative tests would pass for the wrong reason.
    execFileSync('/usr/bin/bwrap', composeBwrapArgs(tmpdir(), '/bin/true', []), {
      stdio: 'ignore',
      timeout: PROBE_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    })
    return true
  } catch {
    return false
  }
}

const bwrapUsable = onLinux && probeBwrapUsable()

/**
 * Really runs under bubblewrap. Returns the kernel status, or `null` when the outcome is NOT
 * conclusive (process never started, killed by a signal, timeout).
 *
 * The distinction is the same the production module makes with `status === null`, and for the same
 * reason: flattening a non-conclusive outcome onto any number would make it pass for a
 * kernel denial in `expect(...).not.toBe(0)` — the negative test would say green without any
 * fence ever denying anything.
 */
function runBwrap(allowedDir: string, script: string): number | null {
  try {
    execFileSync('/usr/bin/bwrap', composeBwrapArgs(allowedDir, '/bin/sh', ['-c', script]), {
      stdio: 'pipe',
      timeout: PROBE_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    })
    return 0
  } catch (error) {
    const status = (error as {status?: number | null}).status
    return typeof status === 'number' ? status : null
  }
}

/** A valid denial is a CONCLUSIVE, non-zero outcome. */
function expectDenied(outcome: number | null): void {
  expect(outcome).not.toBeNull()
  expect(outcome).not.toBe(0)
}

describe.runIf(onLinux)('real write-confinement on Linux (CYAU-123)', () => {
  it('bubblewrap is USABLE when the gate requires it', () => {
    // Explicit gate: if this fails, the three tests below would have been silently skipped.
    // Executability is checked, not presence: a binary the kernel refuses is not a fence.
    if (bwrapRequired) expect(bwrapUsable).toBe(true)
    else expect(true).toBe(true)
  })

  it.runIf(bwrapUsable)('the kernel denies the write outside the perimeter and leaves no file', () => {
    const root = probeRoot()
    const outside = join(root, 'outside', 'denied')

    expectDenied(runBwrap(join(root, 'inside'), `printf x > ${JSON.stringify(outside)}`))
    expect(existsSync(outside)).toBe(false)
  })

  it.runIf(bwrapUsable)('the kernel allows the write inside the perimeter', () => {
    // POSITIVE test: without it, a missing bwrap or one blocked by AppArmor would give the same
    // observable outcome as the denial, and we would attest a non-existent fence.
    const root = probeRoot()
    const inside = join(root, 'inside', 'allowed')

    expect(runBwrap(join(root, 'inside'), `printf ok > ${JSON.stringify(inside)}`)).toBe(0)
    expect(existsSync(inside)).toBe(true)
  })

  it.runIf(bwrapUsable)('the confinement is inherited by descendants, not only by the direct child', () => {
    const root = probeRoot()
    const outside = join(root, 'outside', 'grandchild')
    const nested = `/bin/sh -c ${JSON.stringify(`printf x > ${JSON.stringify(outside)}`)}`

    expectDenied(runBwrap(join(root, 'inside'), nested))
    expect(existsSync(outside)).toBe(false)
  })

  it.runIf(bwrapUsable)('the fence cannot be bypassed through /proc/<pid>/root of an external process', () => {
    // The sneakiest gap: the read-only bind applies to the MOUNT, but /proc/1/root resolves through the
    // mount namespace of init, which lives outside the fence. Without --unshare-pid --proc this
    // write really SUCCEEDS (verified), and the probe would attest a bypassable confinement.
    const root = probeRoot()
    const outside = join(root, 'outside', 'via-proc')

    expectDenied(runBwrap(join(root, 'inside'), `printf x > /proc/1/root${outside}`))
    expect(existsSync(outside)).toBe(false)
  })

  it.runIf(bwrapUsable)('the PID namespace is isolated: host processes are not visible', () => {
    // Observable corollary of the test above: if the host processes were visible, /proc/<pid>/root
    // would offer a way out for each of them.
    const root = probeRoot()
    const count = execFileSync(
      '/usr/bin/bwrap',
      composeBwrapArgs(join(root, 'inside'), '/bin/sh', ['-c', 'ls /proc | grep -c "^[0-9]"']),
      {encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, killSignal: 'SIGKILL'},
    ).trim()

    expect(Number(count)).toBeLessThan(10)
  })

  it('attestWriteConfinement with the real IO reflects the presence of the fence', async () => {
    // It holds in BOTH directions, and that is the point: with a working bwrap it attests, otherwise
    // it stays fail-closed. The comparison is with the real USABILITY, not with the file presence: on a
    // host where the kernel refuses user namespaces the false verdict is CORRECT, not a defect.
    const outcome = await attestWriteConfinement(defaultWriteConfinementIo())
    expect(outcome.attested).toBe(bwrapUsable)
  })
})

describe.runIf(!onLinux)('write-confinement on a platform without probe', () => {
  it('does not attest, and says so', async () => {
    const outcome = await attestWriteConfinement(defaultWriteConfinementIo())
    expect(outcome.attested).toBe(false)
    expect(outcome.detail).toMatch(/esclusivamente su Linux/)
  })
})
