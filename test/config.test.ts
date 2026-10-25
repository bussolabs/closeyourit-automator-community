import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {
  enableSecureCredentials,
  hasOperationalHostIdentity,
  claimHostFingerprint,
  hostFingerprintPath,
  isHostToken,
  isOrgToken,
  loadSecrets,
  loadSecureCredentialsConfig,
  saveSecrets,
  secretCapabilities,
  updateSecrets,
  withSecretsWriteLock,
  type SecretsPersistence,
  secretsPath,
  secureCredentialsPath,
} from '../src/lib/config'

const saved = {...process.env}
let dir: string

const realPersistence: SecretsPersistence = {
  mkdir: (target) => fs.mkdirSync(target, {recursive: true}),
  read: (target) => fs.readFileSync(target, 'utf8'),
  openExclusive: (target, mode) => fs.openSync(target, 'wx', mode),
  write: (fd, data) => fs.writeFileSync(fd, data, 'utf8'),
  sync: (fd) => fs.fsyncSync(fd),
  close: (fd) => fs.closeSync(fd),
  link: (from, to) => fs.linkSync(from, to),
  rename: (from, to) => fs.renameSync(from, to),
  remove: (target) => fs.rmSync(target, {force: true}),
  syncDirectory: (target) => {
    const fd = fs.openSync(target, 'r')
    try {
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
  },
}

function persistence(overrides: Partial<SecretsPersistence> = {}): SecretsPersistence {
  return {...realPersistence, ...overrides}
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-cfg-'))
  process.env.AUTOMATOR_CONFIG_DIR = dir
})

describe('credenziale Agent Host operativa', () => {
  it('accepts exclusively tokens with the cyi_ah_ prefix', () => {
    expect(isHostToken('cyi_ah_host')).toBe(true)
    expect(isHostToken('cyi_h_server')).toBe(false)
    expect(isHostToken('cyi_a_org')).toBe(false)
    expect(isHostToken('cyi_ah_')).toBe(false)
    expect(isHostToken(undefined)).toBe(false)
  })

  it('recognizes the bootstrap organization token separately', () => {
    expect(isOrgToken('cyi_a_org')).toBe(true)
    expect(isOrgToken('cyi_ah_host')).toBe(false)
    expect(isOrgToken(undefined)).toBe(false)
  })

  it('requires a complete identity: non-empty id and valid host token', () => {
    expect(hasOperationalHostIdentity({host: {id: 'h1', token: 'cyi_ah_host'}})).toBe(true)
    expect(hasOperationalHostIdentity({host: {id: '', token: 'cyi_ah_host'}})).toBe(false)
    expect(hasOperationalHostIdentity({host: {id: 'h1', token: 'cyi_h_server'}})).toBe(false)
    expect(hasOperationalHostIdentity({sync: {orgToken: 'cyi_a_org'}})).toBe(false)
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  process.env = {...saved}
  fs.rmSync(dir, {recursive: true, force: true})
})

describe('loadSecrets', () => {
  it('missing file → {}', () => {
    expect(loadSecrets()).toEqual({})
  })

  it('corrupt file → {} and original preserved in quarantine, without printing its content', () => {
    fs.writeFileSync(secretsPath(), 'non-json-di-test')
    const output = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(loadSecrets()).toEqual({})
    expect(fs.existsSync(secretsPath())).toBe(true)
    const quarantined = fs.readdirSync(dir).filter((name) => name.startsWith('secrets.json.corrupt-'))
    expect(quarantined).toHaveLength(1)
    expect(fs.readFileSync(path.join(dir, quarantined[0]), 'utf8')).toBe('non-json-di-test')
    expect(output).not.toHaveBeenCalled()
  })

  it('a non-object JSON root is corrupt and is preserved', () => {
    fs.writeFileSync(secretsPath(), '[]')
    expect(loadSecrets()).toEqual({})
    expect(fs.readdirSync(dir).some((name) => name.startsWith('secrets.json.corrupt-'))).toBe(true)
  })

  it('successive quarantines use unique names and do not overwrite each other', () => {
    fs.writeFileSync(secretsPath(), 'rotto-1')
    loadSecrets()
    const replacement = path.join(dir, 'replacement.json')
    fs.writeFileSync(replacement, 'rotto-2')
    fs.renameSync(replacement, secretsPath())
    loadSecrets()
    const quarantined = fs.readdirSync(dir).filter((name) => name.startsWith('secrets.json.corrupt-'))
    expect(quarantined).toHaveLength(2)
    expect(quarantined.map((name) => fs.readFileSync(path.join(dir, name), 'utf8')).sort()).toEqual(['rotto-1', 'rotto-2'])
  })

  it('concurrent writer between snapshot and quarantine: keeps the read corrupt one and does not move the new valid file', () => {
    fs.writeFileSync(secretsPath(), 'corrotto-letto', {mode: 0o600})
    let replaced = false
    const io = persistence({
      link: (from, to) => {
        realPersistence.link(from, to)
        if (!replaced) {
          replaced = true
          const replacement = path.join(dir, 'replacement.json')
          fs.writeFileSync(replacement, '{"hostFingerprint":"fp-valido"}\n', {mode: 0o600})
          fs.renameSync(replacement, secretsPath())
        }
      },
    })

    expect(loadSecrets(io)).toEqual({})
    expect(JSON.parse(fs.readFileSync(secretsPath(), 'utf8')).hostFingerprint).toBe('fp-valido')
    const quarantined = fs.readdirSync(dir).filter((name) => name.startsWith('secrets.json.corrupt-'))
    expect(quarantined).toHaveLength(1)
    expect(fs.readFileSync(path.join(dir, quarantined[0]), 'utf8')).toBe('corrotto-letto')
  })

  it('round-trip', () => {
    saveSecrets({claudeToken: 'tok', heartbeat: {projectId: 'p', slug: 's', token: 'cyi_x'}})
    const loaded = loadSecrets()
    expect(loaded.claudeToken).toBe('tok')
    expect(loaded.heartbeat?.slug).toBe('s')
  })

  it('round-trip of Agent Host identity + fingerprint', () => {
    saveSecrets({host: {id: 'h1', token: 'cyi_ah_s'}, hostFingerprint: 'fp'})
    const loaded = loadSecrets()
    expect(loaded.host).toEqual({id: 'h1', token: 'cyi_ah_s'})
    expect(loaded.hostFingerprint).toBe('fp')
  })
})

describe('provider sicuro managed', () => {
  const provider = {version: 1, provider: 'closeyourit-keychain', project: 'CYAU', environment: 'production'} as const

  it('migrates the host token into the credential store and leaves only non-sensitive data on disk', () => {
    const retiredTokenKey = ['dop', 'plerToken'].join('')
    saveSecrets({
      claudeToken: 'claude-secret',
      [retiredTokenKey]: 'retired-secret',
      sync: {apiUrl: 'https://app.closeyour.it', orgToken: 'cyi_a_secret'},
      host: {id: 'host-1', token: 'cyi_ah_secret'},
      hostFingerprint: 'fp-1',
    } as Parameters<typeof saveSecrets>[0])
    const credentialWriter = vi.fn(() => true)
    const vaultCredentialWriter = vi.fn(() => true)

    enableSecureCredentials(provider, {
      credentialWriter,
      vaultCredentialWriter,
      serviceAccountToken: 'cyi_u_service',
    })

    expect(credentialWriter).toHaveBeenCalledWith('host-1', 'cyi_ah_secret')
    expect(vaultCredentialWriter).toHaveBeenCalledWith('cyi_u_service')
    expect(loadSecureCredentialsConfig()).toEqual(provider)
    expect(fs.statSync(secureCredentialsPath()).mode & 0o777).toBe(0o600)
    const raw = fs.readFileSync(secretsPath(), 'utf8')
    expect(raw).not.toContain('claude-secret')
    expect(raw).not.toContain('retired-secret')
    expect(raw).not.toContain('cyi_a_secret')
    expect(raw).not.toContain('cyi_ah_secret')
    expect(JSON.parse(raw)).toEqual({
      sync: {apiUrl: 'https://app.closeyour.it'},
      host: {id: 'host-1'},
      hostFingerprint: 'fp-1',
    })
  })

  it('service-account-only bootstrap: without persisted sync, loadSecrets synthesizes an empty one', () => {
    // No sync/host on disk: only the managed provider published with the service account token.
    saveSecrets({})
    enableSecureCredentials(provider, {
      serviceAccountToken: 'cyi_u_service',
      vaultCredentialWriter: () => true,
    })
    // Managed without sync → empty synthesized sync (default apiUrl in makeClient): the registration with
    // only the SA token can start and the host-scoped operations do not stop on `!secrets.sync`.
    expect(loadSecrets().sync).toEqual({})
  })

  it('fails before publishing the provider if the credential store does not accept the host token', () => {
    saveSecrets({host: {id: 'host-1', token: 'cyi_ah_secret'}})

    expect(() => enableSecureCredentials(provider, {
      credentialWriter: () => false,
      serviceAccountToken: 'cyi_u_service',
      vaultCredentialWriter: () => true,
    })).toThrow('credential store host non disponibile')
    expect(fs.existsSync(secureCredentialsPath())).toBe(false)
    expect(JSON.parse(fs.readFileSync(secretsPath(), 'utf8'))).toEqual({host: {id: 'host-1', token: 'cyi_ah_secret'}})
  })

  it('requires a valid service account token (cyi_u_) and does not publish the provider without it', () => {
    // No gate on the project vault: the only authority required is the service account token.
    expect(() => enableSecureCredentials(provider, {vaultCredentialReader: () => undefined}))
      .toThrow('token del service account CloseYourIt (cyi_u_) mancante o non valido')
    expect(() => enableSecureCredentials(provider, {serviceAccountToken: 'cyi_a_org'}))
      .toThrow('token del service account CloseYourIt (cyi_u_) mancante o non valido')
    expect(fs.existsSync(secureCredentialsPath())).toBe(false)
  })

  it('rejects configurations with unsafe identifiers', () => {
    expect(() => enableSecureCredentials({...provider, project: '../production'})).toThrow('configurazione credential provider non valida')
    expect(fs.existsSync(secureCredentialsPath())).toBe(false)
  })
})

describe('saveSecrets', () => {
  it('creates the config directory at the first write before acquiring the shared lock', () => {
    const nested = path.join(dir, 'missing', 'config')
    process.env.AUTOMATOR_CONFIG_DIR = nested
    saveSecrets({hostFingerprint: 'fp-first'})
    expect(loadSecrets()).toEqual({hostFingerprint: 'fp-first'})
  })

  it('writes with 0600 permissions', () => {
    saveSecrets({hostFingerprint: 'fp-mode'})
    const mode = fs.statSync(secretsPath()).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('writes to a unique 0600 temp, fsyncs the file, renames atomically and then fsyncs the directory', () => {
    const temps: string[] = []
    const events: string[] = []
    const sync = vi.fn((fd: number) => {
      events.push('fsync-file')
      realPersistence.sync(fd)
    })
    const rename = vi.fn((from: string, to: string) => {
      events.push('rename')
      const temp = from
      temps.push(temp)
      expect(path.dirname(temp)).toBe(dir)
      expect(fs.statSync(temp).mode & 0o777).toBe(0o600)
      realPersistence.rename(from, to)
    })
    const syncDirectory = vi.fn((target: string) => {
      events.push('fsync-directory')
      realPersistence.syncDirectory(target)
    })
    const io = persistence({sync, rename, syncDirectory})

    saveSecrets({hostFingerprint: 'fp-1'}, io)
    saveSecrets({hostFingerprint: 'fp-2'}, io)

    expect(temps).toHaveLength(2)
    expect(temps[0]).not.toBe(temps[1])
    expect(sync).toHaveBeenCalledTimes(2)
    expect(syncDirectory).toHaveBeenCalledTimes(2)
    expect(events).toEqual([
      'fsync-file', 'rename', 'fsync-directory',
      'fsync-file', 'rename', 'fsync-directory',
    ])
    expect(loadSecrets().hostFingerprint).toBe('fp-2')
  })

  it('a failure between write and rename leaves the previous file intact', () => {
    fs.writeFileSync(secretsPath(), '{"hostFingerprint":"fp-old"}\n', {mode: 0o600})
    const io = persistence({rename: () => { throw new Error('crash simulato prima del rename') }})

    expect(() => saveSecrets({hostFingerprint: 'fp-new'}, io)).toThrow('crash simulato')
    expect(loadSecrets().hostFingerprint).toBe('fp-old')
    expect(fs.readdirSync(dir).filter((name) => name.includes('.tmp-'))).toHaveLength(0)
  })
})

describe('withSecretsWriteLock', () => {
  const ownerName = (pid: number, identity: string, nonce = 'owner'): string =>
    `${pid}~${Buffer.from(identity).toString('base64url')}~${nonce}`

  it('atomically publishes owner and generation: a contender suspended before the claim leaves no empty lock', () => {
    const lockDir = path.join(dir, 'writer.lock')
    const events: string[] = []

    withSecretsWriteLock(() => events.push('outer'), {
      lockDir,
      processIdentity: () => 'start-current',
      beforePublish: () => {
        expect(fs.existsSync(lockDir)).toBe(false)
        withSecretsWriteLock(() => events.push('inner'), {
          lockDir,
          processIdentity: () => 'start-current',
        })
      },
    })

    expect(events).toEqual(['inner', 'outer'])
    expect(fs.existsSync(lockDir)).toBe(false)
  })

  it('a live PID with a different process-start is recycled and the writer lock is recovered', () => {
    const lockDir = path.join(dir, 'writer.lock')
    fs.mkdirSync(path.join(lockDir, ownerName(process.pid, 'start-stale')), {recursive: true})

    expect(withSecretsWriteLock(() => 'ok', {
      lockDir,
      timeoutMs: 500,
      pollMs: 1,
      isAlive: () => true,
      processIdentity: () => 'start-current',
    })).toBe('ok')
    expect(fs.existsSync(lockDir)).toBe(false)
  })

  it('an unverifiable process-start degrades fail-closed without stealing the writer lock', () => {
    const lockDir = path.join(dir, 'writer.lock')
    const ownerPid = 424_242
    fs.mkdirSync(path.join(lockDir, ownerName(ownerPid, 'start-owner')), {recursive: true})

    expect(() => withSecretsWriteLock(() => 'mai', {
      lockDir,
      timeoutMs: 5,
      pollMs: 1,
      isAlive: () => true,
      processIdentity: (pid) => pid === process.pid ? 'start-contender' : null,
    })).toThrow('timeout acquisizione lock scrittura secrets')
    expect(fs.existsSync(lockDir)).toBe(true)
  })

  it('limits every process-start probe to the remaining time of the writer deadline only', () => {
    const lockDir = path.join(dir, 'writer.lock')
    for (const pid of [101, 102, 103]) {
      fs.mkdirSync(path.join(lockDir, ownerName(pid, `start-${pid}`, String(pid))), {recursive: true})
    }
    let elapsed = 0
    const budgets: number[] = []

    expect(() => withSecretsWriteLock(() => 'mai', {
      lockDir,
      timeoutMs: 10,
      pollMs: 1,
      clock: () => elapsed,
      isAlive: () => true,
      processIdentity: (pid, timeoutMs) => {
        if (pid === process.pid) return 'self'
        budgets.push(timeoutMs)
        elapsed += Math.min(timeoutMs, 6)
        return `start-${pid}`
      },
    })).toThrow('timeout acquisizione lock scrittura secrets')
    expect(budgets).toEqual([10, 4])
    expect(elapsed).toBe(10)
  })
})

describe('updateSecrets', () => {
  it('runs load→merge→save without losing fields published by another writer', () => {
    saveSecrets({sync: {apiUrl: 'https://current.example'}, host: {id: 'h1', token: 'cyi_ah_new'}})

    const result = updateSecrets((current) => ({...current, hosts: {CYAU: {cwd: '/repo'}}}))

    expect(result.updated).toBe(true)
    expect(loadSecrets()).toEqual({
      sync: {apiUrl: 'https://current.example'},
      host: {id: 'h1', token: 'cyi_ah_new'},
      hosts: {CYAU: {cwd: '/repo'}},
    })
  })

  it('null mutator leaves the file unchanged', () => {
    saveSecrets({hostFingerprint: 'fp-current'})
    const result = updateSecrets(() => null)
    expect(result).toEqual({updated: false, secrets: {hostFingerprint: 'fp-current'}})
    expect(loadSecrets()).toEqual({hostFingerprint: 'fp-current'})
  })
})

describe('claimHostFingerprint', () => {
  it('the first claim wins atomically and the retries converge to the same fingerprint', () => {
    expect(claimHostFingerprint('fp-primo')).toBe('fp-primo')
    expect(claimHostFingerprint('fp-secondo')).toBe('fp-primo')
    expect(fs.statSync(hostFingerprintPath()).mode & 0o777).toBe(0o600)
  })

  it('the claim fsync precedes the atomic link and the directory fsync', () => {
    const events: string[] = []
    const io = persistence({
      sync: (fd) => {
        events.push('fsync-file')
        realPersistence.sync(fd)
      },
      link: (from, to) => {
        events.push('link')
        realPersistence.link(from, to)
      },
      syncDirectory: (target) => {
        events.push('fsync-directory')
        realPersistence.syncDirectory(target)
      },
    })

    expect(claimHostFingerprint('fp', io)).toBe('fp')
    expect(events).toEqual(['fsync-file', 'link', 'fsync-directory'])
  })
})

describe('secretCapabilities', () => {
  it('does not expose the Claude token, managed by the local auth', () => {
    expect(secretCapabilities({claudeToken: 'c'})).toEqual({})
  })

  it('no token → {}', () => {
    expect(secretCapabilities({})).toEqual({})
  })

  it('does not expose the Agent Host credential in the child process envs', () => {
    const capabilities = secretCapabilities({host: {id: 'h1', token: 'cyi_ah_s'}, hostFingerprint: 'fp'})
    expect(JSON.stringify(capabilities)).not.toContain('cyi_ah_s')
  })
})
