import {describe, expect, it} from 'vitest'
import {
  attestWriteConfinement,
  composeBwrapArgs,
  createWriteConfinementAttestor,
  requireWriteConfinementForSkillMode,
  type ConfinedRunOutcome,
  type WriteConfinementIo,
} from '../src/lib/write-confinement'

const ROOT = '/private/tmp/probe-root'
const INSIDE = `${ROOT}/inside/allowed`
const OUTSIDE = `${ROOT}/outside/denied`

interface Scripted {
  allowed: ConfinedRunOutcome
  denied: ConfinedRunOutcome
  written: Set<string>
}

/** Simulated IO: the first run is the positive test, the second the negative one. */
function scriptedIo(script: Partial<Scripted> & {platform?: NodeJS.Platform} = {}): {
  io: WriteConfinementIo
  removed: string[]
  allowedDirs: string[]
} {
  const written = script.written ?? new Set([INSIDE])
  const removed: string[] = []
  const allowedDirs: string[] = []
  let call = 0
  const io: WriteConfinementIo = {
    platform: script.platform ?? 'linux',
    makeProbeRoot: () => ROOT,
    exists: (file) => written.has(file),
    remove: (dir) => void removed.push(dir),
    runConfined(allowedDir) {
      allowedDirs.push(allowedDir)
      call += 1
      return call === 1
        ? (script.allowed ?? {status: 0})
        : (script.denied ?? {status: 1})
    },
  }
  return {io, removed, allowedDirs}
}

describe('composeBwrapArgs', () => {
  it('mounts everything read-only and reopens for writing only the allowed subtree', () => {
    const args = composeBwrapArgs('/tmp/probe/inside', '/bin/sh', ['-c', 'true'])
    const roBind = args.indexOf('--ro-bind')
    const bind = args.indexOf('--bind')
    expect(roBind).toBeGreaterThanOrEqual(0)
    expect(args.slice(roBind, roBind + 3)).toEqual(['--ro-bind', '/', '/'])
    expect(args.slice(bind, bind + 3)).toEqual(['--bind', '/tmp/probe/inside', '/tmp/probe/inside'])
    // The order is the substance of the fence: first everything is denied, then only the perimeter is reopened.
    // Swapping them would make the whole filesystem writable, with the probe still "passing".
    expect(roBind).toBeLessThan(bind)
  })

  it('passes the command after the separator, so an argument cannot pose as a bwrap option', () => {
    const args = composeBwrapArgs('/tmp/probe/inside', '/bin/sh', ['-c', 'printf ok > f'])
    expect(args.slice(-4)).toEqual(['--', '/bin/sh', '-c', 'printf ok > f'])
  })

  it('does not mount a tmpfs on /tmp: it would mask the probe root and the positive test would always fail', () => {
    expect(composeBwrapArgs('/tmp/probe/inside', '/bin/true', [])).not.toContain('--tmpfs')
  })

  it('does not mount WRITABLE filesystems: they would pierce the perimeter', () => {
    // --dev is the usual bwrap idiom and looks harmless, but it mounts a new WRITABLE devtmpfs
    // over the read-only root: a command inside the fence really writes into /dev/…, i.e. outside the
    // perimeter, and the probe would attest a non-existent global confinement.
    const args = composeBwrapArgs('/tmp/probe/inside', '/bin/true', [])
    for (const mount of ['--dev', '--tmpfs', '--mqueue', '--dev-bind', '--bind-data']) {
      expect(args).not.toContain(mount)
    }
  })

  it('isolates the PID namespace and mounts a new proc: without it, /proc/<pid>/root bypasses the fence', () => {
    // OPPOSITE case to --dev. With --ro-bind alone the HOST /proc stays visible, and
    // /proc/<pid>/root/<path> resolves through the mount namespace of an external process: one writes
    // outside the fence going through the init root. procfs does not allow creating arbitrary files,
    // so mounting it does not reopen the --dev problem.
    const args = composeBwrapArgs('/tmp/probe/inside', '/bin/true', [])
    expect(args).toContain('--unshare-pid')
    const proc = args.indexOf('--proc')
    expect(args.slice(proc, proc + 2)).toEqual(['--proc', '/proc'])
    // The new proc MUST come after the root ro-bind, otherwise it would be covered by the host
    // one and the gap would stay open.
    expect(args.indexOf('--ro-bind')).toBeLessThan(proc)
  })

  it('ties the namespace lifetime to the parent process: a timeout must not leave orphans', () => {
    // The probe timeout kills `bwrap`, not what lives INSIDE the namespace. Without
    // --die-with-parent a timed-out test can leave live descendants, and in a long-running
    // daemon they pile up at every tick.
    expect(composeBwrapArgs('/tmp/probe/inside', '/bin/true', [])).toContain('--die-with-parent')
  })

  it('the only writable bind is the perimeter, everything else is read-only', () => {
    const args = composeBwrapArgs('/tmp/probe/inside', '/bin/true', [])
    expect(args.filter((a) => a === '--bind')).toHaveLength(1)
    expect(args.filter((a) => a === '--ro-bind')).toHaveLength(1)
  })

  it('rejects a non-absolute path: a relative bind confines nothing', () => {
    expect(() => composeBwrapArgs('inside', '/bin/true', [])).toThrow(/assoluto/)
  })
})

describe('attestWriteConfinement', () => {
  it('attests when the write inside succeeds and the one outside is denied without leaving the file', async () => {
    const {io, removed} = scriptedIo()
    await expect(attestWriteConfinement(io)).resolves.toEqual({attested: true})
    expect(removed).toEqual([ROOT])
  })

  it('does NOT attest if the positive test fails: the probe did not run at all', async () => {
    // Central trap: with bubblewrap missing or an invalid configuration the write OUTSIDE does not
    // happen anyway, and without this test the verdict would be a false "confined".
    const {io} = scriptedIo({allowed: {status: 1}})
    const outcome = await attestWriteConfinement(io)
    expect(outcome.attested).toBe(false)
    expect(outcome.detail).toMatch(/sonda non eseguita/)
  })

  it('does NOT attest if the positive test exits 0 but the file does not exist', async () => {
    const {io} = scriptedIo({written: new Set()})
    const outcome = await attestWriteConfinement(io)
    expect(outcome.attested).toBe(false)
    expect(outcome.detail).toMatch(/sonda non eseguita/)
  })

  it('does NOT attest if the write outside the perimeter succeeds', async () => {
    const {io} = scriptedIo({denied: {status: 0}})
    const outcome = await attestWriteConfinement(io)
    expect(outcome.attested).toBe(false)
    expect(outcome.detail).toMatch(/fuori dal perimetro/)
  })

  it('does NOT attest if the negative test returns no outcome: timeouts and failed spawns are not denials', async () => {
    // Fail-open mirroring the positive-test trap: with status null the outside file is missing because the
    // command never ran, not because the kernel denied it.
    const {io} = scriptedIo({denied: {status: null}})
    const outcome = await attestWriteConfinement(io)
    expect(outcome.attested).toBe(false)
    expect(outcome.detail).toMatch(/non conclusiva/)
  })

  it('does NOT attest if the outside write is rejected but the file stays on disk', async () => {
    const {io} = scriptedIo({written: new Set([INSIDE, OUTSIDE])})
    const outcome = await attestWriteConfinement(io)
    expect(outcome.attested).toBe(false)
    expect(outcome.detail).toMatch(/ha lasciato il file/)
  })

  it('attests on Linux with the same double test: bubblewrap with double test', async () => {
    // CYAU-123: the double test covers both the allowed path and the denied one.
    const {io, removed} = scriptedIo({platform: 'linux'})
    await expect(attestWriteConfinement(io)).resolves.toEqual({attested: true})
    expect(removed).toEqual([ROOT])
  })

  it('on Linux the probe receives the allowed subtree as the writable perimeter', async () => {
    const {io, allowedDirs} = scriptedIo({platform: 'linux'})
    await attestWriteConfinement(io)
    expect(allowedDirs).toEqual([`${ROOT}/inside`, `${ROOT}/inside`])
  })

  it('on Linux a successful outside write does NOT attest, without exceptions', async () => {
    const {io} = scriptedIo({platform: 'linux', denied: {status: 0}})
    const outcome = await attestWriteConfinement(io)
    expect(outcome.attested).toBe(false)
    expect(outcome.detail).toMatch(/fuori dal perimetro/)
  })

  it('on Linux a negative test without outcome is NOT a denial', async () => {
    // bwrap killed by the timeout leaves the file missing exactly like a kernel denial:
    // treating it as confinement would be fail-open.
    const {io} = scriptedIo({platform: 'linux', denied: {status: null}})
    const outcome = await attestWriteConfinement(io)
    expect(outcome.attested).toBe(false)
    expect(outcome.detail).toMatch(/non conclusiva/)
  })

  it('on Linux without bwrap the positive test fails and the verdict stays negative', async () => {
    // No branch dedicated to the missing binary: execFile fails, the positive does not succeed, done.
    const {io} = scriptedIo({platform: 'linux', allowed: {status: null}, written: new Set()})
    const outcome = await attestWriteConfinement(io)
    expect(outcome.attested).toBe(false)
    expect(outcome.detail).toMatch(/sonda non eseguita/)
  })

  it('does NOT attest on a platform without probe, and runs nothing', async () => {
    const {io, allowedDirs} = scriptedIo({platform: 'win32'})
    const outcome = await attestWriteConfinement(io)
    expect(outcome.attested).toBe(false)
    expect(outcome.detail).toMatch(/win32/)
    expect(allowedDirs).toEqual([])
  })

  it('does NOT attest when the probe throws, and cleans up anyway', async () => {
    const removed: string[] = []
    const io: WriteConfinementIo = {
      platform: 'linux',
      makeProbeRoot: () => ROOT,
      exists: () => true,
      remove: (dir) => void removed.push(dir),
      runConfined() {
        throw new Error('spawn EPERM')
      },
    }
    const outcome = await attestWriteConfinement(io)
    expect(outcome.attested).toBe(false)
    expect(outcome.detail).toMatch(/spawn EPERM/)
    expect(removed).toEqual([ROOT])
  })

  it('does NOT attest if it cannot even create the probe root', async () => {
    const io: WriteConfinementIo = {
      platform: 'linux',
      makeProbeRoot: () => {
        throw new Error('ENOSPC')
      },
      exists: () => false,
      remove: () => undefined,
      runConfined: () => ({status: 0}),
    }
    await expect(attestWriteConfinement(io)).resolves.toMatchObject({attested: false})
  })

  it('a cleanup error does not overturn an already given verdict', async () => {
    const {io} = scriptedIo()
    const failing: WriteConfinementIo = {
      ...io,
      remove: () => {
        throw new Error('EBUSY')
      },
    }
    await expect(attestWriteConfinement(failing)).resolves.toEqual({attested: true})
  })
})

describe('createWriteConfinementAttestor', () => {
  it('runs the probe only once and reuses the verdict', async () => {
    const {io} = scriptedIo()
    let roots = 0
    const attestor = createWriteConfinementAttestor({
      ...io,
      makeProbeRoot: () => {
        roots += 1
        return ROOT
      },
    })

    await expect(attestor()).resolves.toEqual({attested: true})
    await expect(attestor()).resolves.toEqual({attested: true})
    expect(roots).toBe(1)
  })
})

describe('requireWriteConfinementForSkillMode', () => {
  it('passes when attested', () => {
    expect(() => requireWriteConfinementForSkillMode({attested: true})).not.toThrow()
  })

  it('throws reporting the reason, so install explains why it refuses', () => {
    expect(() => requireWriteConfinementForSkillMode({attested: false, detail: 'sonda non eseguita'}))
      .toThrow(/sonda non eseguita/)
  })

  it('throws even without an available reason', () => {
    expect(() => requireWriteConfinementForSkillMode({attested: false})).toThrow(/non attestabile/)
  })
})
