import {describe, expect, it, vi} from 'vitest'
import {
  probeLinuxHost,
  requireLinuxHost,
  type LinuxHostProbeIo,
} from '../src/lib/linux-host'

function healthyIo(overrides: Partial<LinuxHostProbeIo> = {}): LinuxHostProbeIo {
  return {
    platform: 'linux',
    strongContainmentAvailable: vi.fn(async () => ({available: true})),
    attestWriteConfinement: vi.fn(async () => ({attested: true})),
    secretServiceAvailable: vi.fn(async () => ({available: true})),
    ...overrides,
  }
}

describe('contratto host Linux', () => {
  it('approves only a Linux host with strong containment, bubblewrap and Secret Service', async () => {
    const checks = await probeLinuxHost(healthyIo())

    expect(checks).toEqual([
      {id: 'linux', ok: true},
      {id: 'systemd-cgroup-v2', ok: true},
      {id: 'bubblewrap', ok: true},
      {id: 'secret-service', ok: true},
    ])
    expect(() => requireLinuxHost(checks)).not.toThrow()
  })

  it('rejects macOS without starting Linux probes', async () => {
    const strong = vi.fn(async () => ({available: true}))
    const write = vi.fn(async () => ({attested: true}))
    const secrets = vi.fn(async () => ({available: true}))

    const checks = await probeLinuxHost(healthyIo({
      platform: 'darwin',
      strongContainmentAvailable: strong,
      attestWriteConfinement: write,
      secretServiceAvailable: secrets,
    }))

    expect(checks).toEqual([{id: 'linux', ok: false, detail: 'Automator supporta esclusivamente Linux'}])
    expect(strong).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
    expect(secrets).not.toHaveBeenCalled()
    expect(() => requireLinuxHost(checks)).toThrow(/esclusivamente Linux/)
  })

  it('reports all missing Linux prerequisites without degrading', async () => {
    const checks = await probeLinuxHost(healthyIo({
      strongContainmentAvailable: async () => ({available: false, detail: 'systemd >= 254 richiesto'}),
      attestWriteConfinement: async () => ({attested: false, detail: 'bubblewrap assente'}),
      secretServiceAvailable: async () => ({available: false, detail: 'Secret Service non raggiungibile'}),
    }))

    expect(checks).toEqual([
      {id: 'linux', ok: true},
      {id: 'systemd-cgroup-v2', ok: false, detail: 'systemd >= 254 richiesto'},
      {id: 'bubblewrap', ok: false, detail: 'bubblewrap assente'},
      {id: 'secret-service', ok: false, detail: 'Secret Service non raggiungibile'},
    ])
    expect(() => requireLinuxHost(checks)).toThrow(
      /systemd-cgroup-v2: systemd >= 254 richiesto; bubblewrap: bubblewrap assente; secret-service: Secret Service non raggiungibile/,
    )
  })
})
