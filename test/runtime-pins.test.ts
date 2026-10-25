import {describe, expect, it} from 'vitest'
import {defaultPinCommand, reconcileRuntimePins, type PinCommand} from '../src/lib/runtime-pins'

const PINS = {claude: '2.1.274', codex: '0.156.1'}

/** Fake machine: keeps the installed versions and records the commands. */
function machine(installed: {claude: string | null; codex: string | null}, opts: {failInstall?: string} = {}) {
  const calls: string[] = []
  const run: PinCommand = (cmd, args) => {
    calls.push([cmd, ...args].join(' '))
    if (args[0] === '--version') {
      const version = installed[cmd as 'claude' | 'codex']
      return version ? {code: 0, stdout: cmd === 'claude' ? `${version} (Claude Code)` : `codex-cli ${version}`} : {code: 127, stdout: ''}
    }
    const target = cmd === 'claude' ? args[1] : args[2].replace('@openai/codex@', '')
    if (opts.failInstall === target) return {code: 1, stdout: ''}
    installed[cmd === 'claude' ? 'claude' : 'codex'] = target
    return {code: 0, stdout: ''}
  }
  return {run, calls, installed}
}

describe('reconcileRuntimePins', () => {
  it('already aligned versions → no installation, no probe', async () => {
    const m = machine({claude: '2.1.274', codex: '0.156.1'})
    let probed = false
    const result = await reconcileRuntimePins({run: m.run, probe: async () => { probed = true; return {ready: true} }}, PINS)
    expect(result).toEqual({outcome: 'aligned'})
    expect(probed).toBe(false)
    expect(m.calls).toEqual(['claude --version', 'codex --version'])
  })

  it('a CLI behind is brought to the pinned version and probed', async () => {
    const m = machine({claude: '2.1.274', codex: '0.146.1'})
    const result = await reconcileRuntimePins({run: m.run, probe: async () => ({ready: true})}, PINS)
    expect(result).toEqual({outcome: 'updated', changes: ['codex 0.146.1 → 0.156.1']})
    expect(m.calls).toContain('npm install -g @openai/codex@0.156.1')
    expect(m.installed.codex).toBe('0.156.1')
  })

  it('if the probe fails after the installation, it goes back to the previous versions', async () => {
    const m = machine({claude: '2.1.222', codex: '0.156.1'})
    const result = await reconcileRuntimePins(
      {run: m.run, probe: async () => ({ready: false, detail: 'claude: autenticazione scaduta o revocata'})}, PINS)
    expect(result).toEqual({
      outcome: 'rolled-back',
      detail: 'prova fallita con claude 2.1.274 (claude: autenticazione scaduta o revocata): tornato a claude 2.1.222',
    })
    expect(m.calls).toEqual(['claude --version', 'codex --version', 'claude install 2.1.274', 'claude install 2.1.222'])
    expect(m.installed.claude).toBe('2.1.222')
  })

  it('a failed installation probes nothing and restores what already changed', async () => {
    const m = machine({claude: '2.1.222', codex: '0.146.1'}, {failInstall: '0.156.1'})
    const result = await reconcileRuntimePins({run: m.run, probe: async () => ({ready: true})}, PINS)
    expect(result).toEqual({outcome: 'failed', detail: 'installazione di codex 0.156.1 non riuscita: tornato a claude 2.1.222, codex 0.146.1'})
    expect(m.installed).toEqual({claude: '2.1.222', codex: '0.146.1'})
  })

  it('a missing CLI gets installed, but cannot be brought back to "missing"', async () => {
    const m = machine({claude: '2.1.274', codex: null})
    const result = await reconcileRuntimePins({run: m.run, probe: async () => ({ready: false, detail: 'codex: exit 1'})}, PINS)
    expect(result).toEqual({outcome: 'rolled-back', detail: 'prova fallita con codex 0.156.1 (codex: exit 1): nessuna versione precedente da ripristinare'})
  })
})

// CYRA-878: the host runs with umask 0002, so codex landed group-writable and the review trust policy
// refused it: no diff review could ever start there.
describe('defaultPinCommand', () => {
  it('installs with umask 022 whatever the process umask is', () => {
    const previous = process.umask(0o002)
    try {
      expect(defaultPinCommand('sh', ['-c', 'umask']).stdout.trim()).toBe('0022')
      expect(process.umask()).toBe(0o002)
    } finally {
      process.umask(previous)
    }
  })
})
