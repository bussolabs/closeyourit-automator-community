import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {loadSecrets, saveSecrets, type Secrets} from '../src/lib/config'
import {processStartIdentity, recoverHostOperation, withHostRotationLock} from '../src/lib/host-auth'
import {type HostCallResult, type HostRegistration, type RegisteredHost} from '../src/lib/client'

const oldIdentity = {id: 'h1', token: 'cyi_ah_old'}
const newIdentity = {id: 'h1', token: 'cyi_ah_new'}
const unlocked = async <T>(run: () => Promise<T>): Promise<T> => run()
const ok = <T>(value: T): HostCallResult<T> => ({outcome: 'ok', value})

function baseSecrets(overrides: Partial<Secrets> = {}): Secrets {
  return {sync: {orgToken: 'cyi_a_org'}, hostFingerprint: 'fp-stabile', host: {...oldIdentity}, ...overrides}
}


// The host lock identifies its owner through /proc, like the Linux-only service it protects: on macOS these tests
// failed and the file never ended (CYRA-914 D4).
const onLinux = process.platform === 'linux'

describe.runIf(onLinux)('recoverHostOperation', () => {
  it('first pull 401 → rotates on the same fingerprint, persists and retries only once with the new token', async () => {
    const secrets = baseSecrets()
    const saved: Secrets[] = []
    const tokens: string[] = []
    const register = vi.fn(async (registration: HostRegistration) => {
      expect(registration.fingerprint).toBe('fp-stabile')
      return ok<RegisteredHost>(newIdentity)
    })
    const operation = vi.fn(async (token: string) => {
      tokens.push(token)
      return token === oldIdentity.token ? {outcome: 'unauthorized'} as const : ok(['agent'])
    })

    const result = await recoverHostOperation({
      secrets,
      operation,
      register,
      load: () => baseSecrets(),
      save: (next) => saved.push(structuredClone(next)),
      claimFingerprint: (candidate) => candidate,
      withRotationLock: unlocked,
    })

    expect(result).toEqual(ok(['agent']))
    expect(tokens).toEqual(['cyi_ah_old', 'cyi_ah_new'])
    expect(register).toHaveBeenCalledTimes(1)
    expect(saved).toHaveLength(1)
    expect(saved[0].host).toEqual(newIdentity)
    expect(secrets.host).toEqual(newIdentity)
  })

  it('second 401 after the rotation → bounded stop: no second register or third attempt', async () => {
    const operation = vi.fn(async () => ({outcome: 'unauthorized'} as const))
    const register = vi.fn(async () => ok<RegisteredHost>(newIdentity))

    const result = await recoverHostOperation({
      secrets: baseSecrets(), operation, register, load: () => baseSecrets(), save: () => undefined,
      claimFingerprint: (candidate) => candidate, withRotationLock: unlocked,
    })

    expect(result).toEqual({outcome: 'unauthorized'})
    expect(operation).toHaveBeenCalledTimes(2)
    expect(register).toHaveBeenCalledTimes(1)
  })

  it('403 revoked host → terminal, does not register, save or retry', async () => {
    const secrets = baseSecrets()
    const operation = vi.fn(async () => ({outcome: 'forbidden'} as const))
    const register = vi.fn()
    const save = vi.fn()

    expect(await recoverHostOperation({secrets, operation, register, save})).toEqual({outcome: 'forbidden'})
    expect(operation).toHaveBeenCalledTimes(1)
    expect(register).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
    expect(secrets.host).toEqual(oldIdentity)
  })

  it('401 without orgToken → fail-closed, no rotation or retry', async () => {
    const operation = vi.fn(async () => ({outcome: 'unauthorized'} as const))
    const register = vi.fn()
    const secrets = baseSecrets({sync: {}})

    expect(await recoverHostOperation({
      secrets, operation, register, load: () => structuredClone(secrets), withRotationLock: unlocked,
    })).toEqual({outcome: 'unauthorized'})
    expect(operation).toHaveBeenCalledTimes(1)
    expect(register).not.toHaveBeenCalled()
    expect(secrets.host).toEqual(oldIdentity)
  })

  it('401 without an initial orgToken enters the lock and adopts an already rotated durable identity', async () => {
    const durable = baseSecrets({sync: {}, host: {...newIdentity}})
    const operation = vi.fn(async (token: string) => token === oldIdentity.token
      ? {outcome: 'unauthorized'} as const
      : ok(['agent']))
    const register = vi.fn()
    const secrets = baseSecrets({sync: {}})

    await expect(recoverHostOperation({
      secrets, operation, register, load: () => structuredClone(durable), withRotationLock: unlocked,
    })).resolves.toEqual(ok(['agent']))

    expect(operation.mock.calls.map(([token]) => token)).toEqual([oldIdentity.token, newIdentity.token])
    expect(register).not.toHaveBeenCalled()
    expect(secrets).toEqual(durable)
  })

  it('401 without orgToken but with the service account token → rotates using the SA token', async () => {
    // Managed mode: sync carries only apiUrl (no orgToken); the re-registration authority is the cyi_u_.
    const managed = () => baseSecrets({sync: {apiUrl: 'https://x.example'}})
    const saved: Secrets[] = []
    const seenRegistrationTokens: Array<string | undefined> = []
    const register = vi.fn(async (_registration: HostRegistration, _sync, registrationToken?: string) => {
      seenRegistrationTokens.push(registrationToken)
      return ok<RegisteredHost>(newIdentity)
    })
    const operation = vi.fn(async (token: string) => token === oldIdentity.token
      ? {outcome: 'unauthorized'} as const
      : ok(['agent']))
    const secrets = managed()

    const result = await recoverHostOperation({
      secrets,
      operation,
      register,
      loadRegistrationToken: () => 'cyi_u_sa',
      load: managed,
      save: (next) => saved.push(structuredClone(next)),
      claimFingerprint: (candidate) => candidate,
      withRotationLock: unlocked,
    })

    expect(result).toEqual(ok(['agent']))
    expect(register).toHaveBeenCalledTimes(1)
    expect(seenRegistrationTokens).toEqual(['cyi_u_sa'])
    expect(saved.at(-1)?.host).toEqual(newIdentity)
    expect(secrets.host).toEqual(newIdentity)
  })

  it('401 without orgToken nor valid SA token → fail-closed even with loadRegistrationToken', async () => {
    const operation = vi.fn(async () => ({outcome: 'unauthorized'} as const))
    const register = vi.fn()
    const secrets = baseSecrets({sync: {apiUrl: 'https://x.example'}})

    expect(await recoverHostOperation({
      secrets, operation, register,
      loadRegistrationToken: () => 'cyi_a_org', // the org token is NOT a service-account authority on this path
      load: () => structuredClone(secrets), withRotationLock: unlocked,
    })).toEqual({outcome: 'unauthorized'})
    expect(register).not.toHaveBeenCalled()
    expect(secrets.host).toEqual(oldIdentity)
  })

  it.each([
    ['401', {outcome: 'unauthorized'} as const],
    ['403', {outcome: 'forbidden'} as const],
  ])('adopts the durable identity before the retry even when the new token answers %s', async (_label, terminal) => {
    const durable = baseSecrets({sync: {}, host: {...newIdentity}})
    const operation = vi.fn()
      .mockResolvedValueOnce({outcome: 'unauthorized'} as const)
      .mockResolvedValueOnce(terminal)
    const secrets = baseSecrets({sync: {}})

    await expect(recoverHostOperation({
      secrets, operation, register: vi.fn(), load: () => structuredClone(durable), withRotationLock: unlocked,
    })).resolves.toEqual(terminal)

    expect(secrets).toEqual(durable)
  })

  it('orgToken removed from the config re-read inside the lock → does not register with the captured initial token', async () => {
    const operation = vi.fn(async () => ({outcome: 'unauthorized'} as const))
    const register = vi.fn()

    expect(await recoverHostOperation({
      secrets: baseSecrets(), operation, register,
      load: () => baseSecrets({sync: {}}), withRotationLock: unlocked,
    })).toEqual({outcome: 'unauthorized'})
    expect(register).not.toHaveBeenCalled()
    expect(operation).toHaveBeenCalledTimes(1)
  })

  it('orgToken changed in the re-read config → the registration receives only the current one', async () => {
    const operation = vi.fn()
      .mockResolvedValueOnce({outcome: 'unauthorized'} as const)
      .mockResolvedValueOnce(ok(['agent']))
    const register = vi.fn(async (_registration: HostRegistration, currentSync: NonNullable<Secrets['sync']>) => {
      expect(currentSync.orgToken).toBe('cyi_a_current')
      return ok<RegisteredHost>(newIdentity)
    })

    await expect(recoverHostOperation({
      secrets: baseSecrets(), operation, register,
      load: () => baseSecrets({sync: {orgToken: 'cyi_a_current'}}),
      save: () => undefined, claimFingerprint: (candidate) => candidate, withRotationLock: unlocked,
    })).resolves.toEqual(ok(['agent']))
    expect(register).toHaveBeenCalledTimes(1)
  })

  it.each(['unavailable'] as const)('%s (network/5xx) → no rotation', async (outcome) => {
    const operation = vi.fn(async () => ({outcome} as const))
    const register = vi.fn()
    expect(await recoverHostOperation({secrets: baseSecrets(), operation, register})).toEqual({outcome})
    expect(register).not.toHaveBeenCalled()
  })

  it('registration 403 → terminal and does not use/repeat the old identity', async () => {
    const secrets = baseSecrets()
    const operation = vi.fn(async () => ({outcome: 'unauthorized'} as const))
    const register = vi.fn(async () => ({outcome: 'forbidden'} as const))
    const save = vi.fn()

    expect(await recoverHostOperation({
      secrets, operation, register, load: () => baseSecrets(), save,
      claimFingerprint: (candidate) => candidate, withRotationLock: unlocked,
    })).toEqual({outcome: 'forbidden'})
    expect(operation).toHaveBeenCalledTimes(1)
    expect(save).not.toHaveBeenCalled()
    expect(secrets.host).toEqual(oldIdentity)
  })

  it('persist failure → does not use the new volatile identity and does not retry the operation', async () => {
    const secrets = baseSecrets()
    const operation = vi.fn(async () => ({outcome: 'unauthorized'} as const))

    const result = await recoverHostOperation({
      secrets, operation, register: async () => ok<RegisteredHost>(newIdentity), load: () => baseSecrets(),
      save: () => { throw new Error('disk full') }, claimFingerprint: (candidate) => candidate,
      withRotationLock: unlocked,
    })

    expect(result).toEqual({outcome: 'unavailable'})
    expect(operation).toHaveBeenCalledTimes(1)
    expect(secrets.host).toEqual(oldIdentity)
  })

  it('re-reads and merges the snapshot right before the persist without reintroducing a removed orgToken', async () => {
    const secrets = baseSecrets()
    let disk = baseSecrets()
    const save = vi.fn((next: Secrets) => { disk = structuredClone(next) })
    const operation = vi.fn()
      .mockResolvedValueOnce({outcome: 'unauthorized'} as const)
      .mockResolvedValueOnce(ok(['agent']))
    const register = vi.fn(async () => {
      disk = {...disk, sync: {apiUrl: 'https://current.example'}, hosts: {CYAU: {cwd: '/current'}}}
      return ok<RegisteredHost>(newIdentity)
    })

    await expect(recoverHostOperation({
      secrets, operation, register, load: () => structuredClone(disk), save,
      claimFingerprint: (candidate) => candidate, withRotationLock: unlocked,
    })).resolves.toEqual(ok(['agent']))

    expect(disk.host).toEqual(newIdentity)
    expect(disk.sync).toEqual({apiUrl: 'https://current.example'})
    expect(disk.hosts).toEqual({CYAU: {cwd: '/current'}})
    expect(operation.mock.calls[1][1]).toEqual({apiUrl: 'https://current.example'})
  })

  it('atomic commit: a concurrent writer between load and save is not lost and orgToken does not reappear', async () => {
    const secrets = baseSecrets()
    let disk = baseSecrets()
    const operation = vi.fn()
      .mockResolvedValueOnce({outcome: 'unauthorized'} as const)
      .mockResolvedValueOnce(ok(['agent']))

    await expect(recoverHostOperation({
      secrets,
      operation,
      register: async () => ok<RegisteredHost>(newIdentity),
      load: () => structuredClone(disk),
      update: (mutate) => {
        // Deterministic race at the commit: another writer publishes after the host-auth load.
        disk = {...disk, sync: {apiUrl: 'https://current.example'}, hosts: {CYAU: {cwd: '/current'}}}
        const next = mutate(structuredClone(disk))
        if (next === null) return {updated: false, secrets: structuredClone(disk)}
        disk = structuredClone(next)
        return {updated: true, secrets: structuredClone(disk)}
      },
      claimFingerprint: (candidate) => candidate,
      withRotationLock: unlocked,
    })).resolves.toEqual(ok(['agent']))

    expect(disk.host).toEqual(newIdentity)
    expect(disk.sync).toEqual({apiUrl: 'https://current.example'})
    expect(disk.hosts).toEqual({CYAU: {cwd: '/current'}})
    expect(secrets).toEqual(disk)
  })

  it('CAS identity fails: does not overwrite a concurrent rotation and uses the persisted token', async () => {
    const secrets = baseSecrets()
    const concurrentIdentity = {id: 'h1', token: 'cyi_ah_concurrent'}
    let disk = baseSecrets()
    const save = vi.fn((next: Secrets) => { disk = structuredClone(next) })
    const tokens: string[] = []
    const operation = vi.fn(async (token: string) => {
      tokens.push(token)
      return token === oldIdentity.token ? {outcome: 'unauthorized'} as const : ok(['agent'])
    })
    const register = vi.fn(async () => {
      disk = {...disk, host: concurrentIdentity, sync: {apiUrl: 'https://current.example'}}
      return ok<RegisteredHost>(newIdentity)
    })

    await expect(recoverHostOperation({
      secrets, operation, register, load: () => structuredClone(disk), save,
      claimFingerprint: (candidate) => candidate, withRotationLock: unlocked,
    })).resolves.toEqual(ok(['agent']))

    expect(save).not.toHaveBeenCalled()
    expect(disk.host).toEqual(concurrentIdentity)
    expect(secrets.host).toEqual(concurrentIdentity)
    expect(tokens).toEqual(['cyi_ah_old', 'cyi_ah_concurrent'])
  })

  it('CAS identity fails: adopts the concurrent snapshot even if its retry is still 401', async () => {
    const secrets = baseSecrets()
    const concurrent = baseSecrets({host: {id: 'h1', token: 'cyi_ah_concurrent'}})
    let disk = baseSecrets()
    const operation = vi.fn(async () => ({outcome: 'unauthorized'} as const))
    const register = vi.fn(async () => {
      disk = structuredClone(concurrent)
      return ok<RegisteredHost>(newIdentity)
    })

    await expect(recoverHostOperation({
      secrets, operation, register, load: () => structuredClone(disk), save: () => undefined,
      claimFingerprint: (candidate) => candidate, withRotationLock: unlocked,
    })).resolves.toEqual({outcome: 'unauthorized'})

    expect(secrets).toEqual(concurrent)
  })

  it('commit CAS loses: adopts the winning snapshot even if its retry is 403', async () => {
    const secrets = baseSecrets()
    const concurrent = baseSecrets({host: {id: 'h1', token: 'cyi_ah_concurrent'}})
    const operation = vi.fn()
      .mockResolvedValueOnce({outcome: 'unauthorized'} as const)
      .mockResolvedValueOnce({outcome: 'forbidden'} as const)

    await expect(recoverHostOperation({
      secrets,
      operation,
      register: vi.fn(async () => ok<RegisteredHost>(newIdentity)),
      load: () => baseSecrets(),
      update: () => ({updated: false, secrets: structuredClone(concurrent)}),
      claimFingerprint: (candidate) => candidate,
      withRotationLock: unlocked,
    })).resolves.toEqual({outcome: 'forbidden'})

    expect(secrets).toEqual(concurrent)
  })
})

describe.runIf(onLinux)('recovery concorrente e restart', () => {
  let dir: string
  let previous: string | undefined

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-host-auth-'))
    previous = process.env.AUTOMATOR_CONFIG_DIR
    process.env.AUTOMATOR_CONFIG_DIR = dir
    saveSecrets(baseSecrets())
  })

  afterEach(() => {
    if (previous === undefined) delete process.env.AUTOMATOR_CONFIG_DIR
    else process.env.AUTOMATOR_CONFIG_DIR = previous
    fs.rmSync(dir, {recursive: true, force: true})
  })

  it('serializes parallel recoveries: only one registration response can be persisted', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const register = vi.fn(async () => {
      await gate
      return ok<RegisteredHost>(newIdentity)
    })
    const operation = vi.fn(async (token: string) => token === oldIdentity.token
      ? {outcome: 'unauthorized'} as const
      : ok(['agent']))

    const first = recoverHostOperation({secrets: loadSecrets(), operation, register})
    while (register.mock.calls.length === 0) await Promise.resolve()
    const second = recoverHostOperation({secrets: loadSecrets(), operation, register})
    release()

    await expect(Promise.all([first, second])).resolves.toEqual([ok(['agent']), ok(['agent'])])
    expect(register).toHaveBeenCalledTimes(1)
    expect(loadSecrets().host).toEqual(newIdentity)
  })

  it('restart after rotation uses the persisted identity without a new registration', async () => {
    const firstOperation = vi.fn(async (token: string) => token === oldIdentity.token
      ? {outcome: 'unauthorized'} as const
      : ok(['agent']))
    await recoverHostOperation({
      secrets: loadSecrets(), operation: firstOperation,
      register: async () => ok<RegisteredHost>(newIdentity),
    })

    const registerAfterRestart = vi.fn()
    const operationAfterRestart = vi.fn(async (token: string) => token === newIdentity.token
      ? ok(['agent'])
      : {outcome: 'unauthorized'} as const)
    await expect(recoverHostOperation({
      secrets: loadSecrets(), operation: operationAfterRestart, register: registerAfterRestart,
    })).resolves.toEqual(ok(['agent']))
    expect(registerAfterRestart).not.toHaveBeenCalled()
  })
})

describe.runIf(onLinux)('withHostRotationLock', () => {
  const ownerName = (pid: number, identity: string, nonce = 'owner'): string =>
    `${pid}~${Buffer.from(identity).toString('base64url')}~${nonce}`

  it('publishes owner and generation in the same atomic claim without an empty-lock window', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-host-lock-'))
    const lockDir = path.join(dir, 'rotation.lock')
    let prepared!: () => void
    let release!: () => void
    const preparedGate = new Promise<void>((resolve) => { prepared = resolve })
    const releaseGate = new Promise<void>((resolve) => { release = resolve })
    const events: string[] = []

    try {
      const first = withHostRotationLock(async () => events.push('first'), {
        lockDir,
        timeoutMs: 2_000,
        processIdentity: () => 'start-current',
        beforePublish: async () => {
          expect(fs.existsSync(lockDir)).toBe(false)
          prepared()
          await releaseGate
        },
      })
      await preparedGate

      await withHostRotationLock(async () => events.push('second'), {
        lockDir, timeoutMs: 2_000, processIdentity: () => 'start-current',
      })
      release()
      await first

      expect(events).toEqual(['second', 'first'])
      expect(fs.existsSync(lockDir)).toBe(false)
    } finally {
      release()
      fs.rmSync(dir, {recursive: true, force: true})
    }
  })

  it('recovers a dead owner and completes the critical section', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-host-lock-'))
    const lockDir = path.join(dir, 'rotation.lock')
    fs.mkdirSync(path.join(lockDir, ownerName(999999, 'start-dead')), {recursive: true})

    try {
      await expect(withHostRotationLock(async () => 'ok', {
        lockDir, timeoutMs: 500, pollMs: 1, isAlive: () => false,
      })).resolves.toBe('ok')
      expect(fs.existsSync(lockDir)).toBe(false)
    } finally {
      fs.rmSync(dir, {recursive: true, force: true})
    }
  })

  it('live owner → ends within the bounded timeout without stealing the lock', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-host-lock-'))
    const lockDir = path.join(dir, 'rotation.lock')
    fs.mkdirSync(path.join(lockDir, ownerName(process.pid, 'start-current')), {recursive: true})
    const run = vi.fn()

    try {
      await expect(withHostRotationLock(run, {
        lockDir, timeoutMs: 5, pollMs: 1, isAlive: () => true, processIdentity: () => 'start-current',
      })).rejects.toThrow('timeout acquisizione lock rotazione host')
      expect(run).not.toHaveBeenCalled()
      expect(fs.existsSync(lockDir)).toBe(true)
    } finally {
      fs.rmSync(dir, {recursive: true, force: true})
    }
  })

  it('live PID but different start identity → recognizes PID reuse and recovers the lock', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-host-lock-'))
    const lockDir = path.join(dir, 'rotation.lock')
    fs.mkdirSync(path.join(lockDir, ownerName(process.pid, 'start-stale')), {recursive: true})

    try {
      await expect(withHostRotationLock(async () => 'ok', {
        lockDir, timeoutMs: 500, pollMs: 1, isAlive: () => true, processIdentity: () => 'start-current',
      })).resolves.toBe('ok')
      expect(fs.existsSync(lockDir)).toBe(false)
    } finally {
      fs.rmSync(dir, {recursive: true, force: true})
    }
  })

  it('monotonic deadline during a multi-owner scan: every probe uses only the remaining time', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-host-lock-'))
    const lockDir = path.join(dir, 'rotation.lock')
    for (const pid of [101, 102, 103]) {
      fs.mkdirSync(path.join(lockDir, ownerName(pid, `start-${pid}`, String(pid))), {recursive: true})
    }
    let elapsed = 0
    const probeBudgets: number[] = []
    const run = vi.fn()

    try {
      await expect(withHostRotationLock(run, {
        lockDir,
        timeoutMs: 10,
        pollMs: 1,
        clock: () => elapsed,
        isAlive: () => true,
        processIdentity: (pid, timeoutMs) => {
          if (pid === process.pid) return 'self'
          probeBudgets.push(timeoutMs)
          elapsed += Math.min(timeoutMs, 6)
          return `start-${pid}`
        },
      })).rejects.toThrow('timeout acquisizione lock rotazione host')

      expect(probeBudgets).toEqual([10, 4])
      expect(elapsed).toBe(10)
      expect(run).not.toHaveBeenCalled()
    } finally {
      fs.rmSync(dir, {recursive: true, force: true})
    }
  })

  it('the start identity of the current process is available and stable', () => {
    const first = processStartIdentity(process.pid)
    expect(first).toBeTruthy()
    expect(processStartIdentity(process.pid)).toBe(first)
  })

  it('owner process terminated abruptly → the contender recovers the real lock', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-host-lock-'))
    const lockDir = path.join(dir, 'rotation.lock')
    const child = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1_000)'], {stdio: 'ignore'})

    try {
      await once(child, 'spawn')
      const pid = child.pid!
      const identity = processStartIdentity(pid)
      expect(identity).toBeTruthy()
      fs.mkdirSync(path.join(lockDir, ownerName(pid, identity!)), {recursive: true})
      child.kill('SIGKILL')
      await once(child, 'exit')

      await expect(withHostRotationLock(async () => 'ok', {
        lockDir, timeoutMs: 1_000, pollMs: 2,
      })).resolves.toBe('ok')
      expect(fs.existsSync(lockDir)).toBe(false)
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      fs.rmSync(dir, {recursive: true, force: true})
    }
  })
})
