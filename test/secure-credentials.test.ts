import {describe, expect, it, vi} from 'vitest'

import {
  clearClaudeCredential,
  composeSecureSecrets,
  loadClaudeCredential,
  saveClaudeCredential,
  loadHostCredential,
  loadVaultCredential,
  persistableSecrets,
  saveHostCredential,
  saveVaultCredential,
  type CredentialCommand,
  validSecureCredentialsConfig,
} from '../src/lib/secure-credentials'

describe('validSecureCredentialsConfig', () => {
  it('accepts only the exact marker and safe names', () => {
    expect(validSecureCredentialsConfig({
      version: 1,
      provider: 'closeyourit-keychain',
      project: 'CYAU',
      environment: 'production',
    })).toBe(true)

    for (const value of [
      null,
      [],
      {version: 2, provider: 'closeyourit-keychain', project: 'CYAU', environment: 'production'},
      {version: 1, provider: 'other', project: 'CYAU', environment: 'production'},
      {version: 1, provider: 'closeyourit-keychain', project: '../CYAU', environment: 'production'},
      {version: 1, provider: 'closeyourit-keychain', project: 'CYAU', environment: '../production'},
      {version: 1, provider: 'closeyourit-keychain', project: 'CYAU', environment: 'production', extra: true},
    ]) expect(validSecureCredentialsConfig(value)).toBe(false)
  })
})

describe('persistableSecrets', () => {
  it('removes every token but keeps configuration and public identity', () => {
    const retiredTokenKey = ['dop', 'plerToken'].join('')
    expect(persistableSecrets({
      claudeToken: 'claude-secret',
      [retiredTokenKey]: 'legacy-secret',
      heartbeat: {projectId: 'p1', slug: 'worker', token: 'heartbeat-secret', environment: 'production'},
      sync: {apiUrl: 'https://app.closeyour.it', orgToken: 'cyi_a_secret'},
      hosts: {CYAU: {cwd: '/repo'}},
      host: {id: 'host-1', token: 'cyi_ah_secret'},
      hostFingerprint: 'fingerprint',
    } as Parameters<typeof persistableSecrets>[0])).toEqual({
      heartbeat: {projectId: 'p1', slug: 'worker', environment: 'production'},
      sync: {apiUrl: 'https://app.closeyour.it'},
      hosts: {CYAU: {cwd: '/repo'}},
      host: {id: 'host-1'},
      hostFingerprint: 'fingerprint',
    })
  })

  it('omits missing sections, optional URLs and hosts without identity', () => {
    expect(persistableSecrets({
      heartbeat: {projectId: 'p1', slug: 'worker', token: 'secret'},
      sync: {orgToken: 'cyi_a_secret'},
      host: {id: '', token: 'cyi_ah_secret'},
    })).toEqual({
      heartbeat: {projectId: 'p1', slug: 'worker'},
      sync: {},
    })
    expect(persistableSecrets({})).toEqual({})
  })

  it('keeps workspaceRoot (non-sensitive local path) in the persistable projection', () => {
    expect(persistableSecrets({workspaceRoot: '/srv/ws', host: {id: 'h1', token: 'cyi_ah_s'}})).toEqual({
      host: {id: 'h1'},
      workspaceRoot: '/srv/ws',
    })
  })
})

describe('composeSecureSecrets', () => {
  it('composes the public sections with the host token from the credential store, without vault', () => {
    expect(composeSecureSecrets(
      {sync: {apiUrl: 'https://app.closeyour.it'}, host: {id: 'host-1'} as never, hostFingerprint: 'fp'},
      'cyi_ah_secret',
    )).toEqual({
      sync: {apiUrl: 'https://app.closeyour.it'},
      host: {id: 'host-1', token: 'cyi_ah_secret'},
      hostFingerprint: 'fp',
    })
  })

  it('discards a host token with an invalid prefix and keeps only the public identity', () => {
    expect(composeSecureSecrets(
      {sync: {apiUrl: 'https://app.closeyour.it'}, host: {id: 'host-1'} as never},
      'cyi_h_wrong',
    )).toEqual({sync: {apiUrl: 'https://app.closeyour.it'}, host: {id: 'host-1'}})
  })

  it('keeps the public sections even without device credentials; sync only if already persisted', () => {
    expect(composeSecureSecrets({
      heartbeat: {projectId: 'p1', slug: 'worker'},
      hosts: {CYAU: {cwd: '/repo'}},
    })).toEqual({
      heartbeat: {projectId: 'p1', slug: 'worker'},
      hosts: {CYAU: {cwd: '/repo'}},
    })
    expect(composeSecureSecrets({workspaceRoot: '/srv/ws'})).toEqual({workspaceRoot: '/srv/ws'})
    expect(composeSecureSecrets({})).toEqual({})
  })
})

describe('credential store device', () => {
  it('Linux uses secret-tool via stdin and rejects output with a wrong prefix', () => {
    const command = vi.fn<CredentialCommand>((_cmd, args, options) => args[0] === 'lookup'
      ? {status: 0, stdout: 'cyi_h_wrong\n', stderr: ''}
      : {status: options?.input?.startsWith('cyi_') ? 0 : 1, stdout: '', stderr: ''})

    expect(saveHostCredential('host-1', 'cyi_ah_secret', command)).toBe(true)
    expect(saveVaultCredential('cyi_u_service', command)).toBe(true)
    expect(loadHostCredential('host-1', command)).toBeUndefined()
    expect(loadVaultCredential(command)).toBeUndefined()
    expect(command).toHaveBeenCalledWith('/usr/bin/secret-tool', expect.any(Array), expect.anything())
  })

  it('fails closed for invalid accounts, tokens and commands', () => {
    const failed = vi.fn<CredentialCommand>(() => ({status: 1, stdout: 'cyi_ah_secret\n', stderr: 'no'}))

    expect(saveHostCredential('../host', 'cyi_ah_secret', failed)).toBe(false)
    expect(loadHostCredential('../host', failed)).toBeUndefined()
    expect(saveHostCredential('host-1', 'wrong', failed)).toBe(false)
    expect(saveVaultCredential('wrong', failed)).toBe(false)
    expect(saveHostCredential('host-1', 'cyi_ah_secret', failed)).toBe(false)
    expect(saveVaultCredential('cyi_u_service', failed)).toBe(false)
    expect(loadHostCredential('host-1', failed)).toBeUndefined()
    expect(loadVaultCredential(failed)).toBeUndefined()
  })
})

// CYAU-108: the service account token enters the IN-MEMORY secrets and never goes back to disk.
describe('composeSecureSecrets — machine cyi identity (CYAU-108)', () => {
  it('accepts a valid service token as cyi identity', () => {
    const composed = composeSecureSecrets({}, undefined, 'cyi_u_valido')
    expect(composed.cyiToken).toBe('cyi_u_valido')
  })

  it('discards a malformed value: an invalid token must authenticate nothing', () => {
    for (const bad of ['', 'cyi_ah_host', 'cyi_a_org', 'garbage']) {
      expect(composeSecureSecrets({}, undefined, bad).cyiToken).toBeUndefined()
    }
    expect(composeSecureSecrets({}, undefined).cyiToken).toBeUndefined()
  })

  it('never ends up in the persisted secrets', () => {
    const composed = composeSecureSecrets({}, undefined, 'cyi_u_valido')
    expect(persistableSecrets(composed)).not.toHaveProperty('cyiToken')
    expect(JSON.stringify(persistableSecrets(composed))).not.toContain('cyi_u_valido')
  })
})

describe('organization Claude credential in the credential store (CYAU-224)', () => {
  it('stores, reads and clears it under its own service, rejecting other formats', () => {
    const command = vi.fn<CredentialCommand>((_cmd, args) => args[0] === 'lookup'
      ? {status: 0, stdout: 'sk-ant-oat01-stored\n', stderr: ''}
      : {status: 0, stdout: '', stderr: ''})

    expect(saveClaudeCredential('sk-ant-api03-key', command)).toBe(true)
    expect(saveClaudeCredential('cyi_ah_not_claude', command)).toBe(false)
    expect(loadClaudeCredential(command)).toBe('sk-ant-oat01-stored')
    expect(clearClaudeCredential(command)).toBe(true)
    expect(command.mock.calls.map(([, args]) => args.slice(0, 1).concat(args.slice(-4)))).toEqual([
      ['store', 'service', 'it.closeyour.automator.claude', 'account', 'organization'],
      ['lookup', 'service', 'it.closeyour.automator.claude', 'account', 'organization'],
      ['clear', 'service', 'it.closeyour.automator.claude', 'account', 'organization'],
    ])
    expect(command.mock.calls[0][2]).toEqual({input: 'sk-ant-api03-key\n'})
  })

  it('reads a malformed stored value as missing', () => {
    const command = vi.fn<CredentialCommand>(() => ({status: 0, stdout: 'garbage\n', stderr: ''}))

    expect(loadClaudeCredential(command)).toBeUndefined()
  })
})
