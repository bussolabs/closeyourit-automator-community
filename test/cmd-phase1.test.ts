import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {spawnSync} from 'node:child_process'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import Validate from '../src/commands/validate'
import List from '../src/commands/list'
import RunCommand from '../src/commands/run'
import TickCommand from '../src/commands/tick'
import Logs from '../src/commands/logs'
import {run, runCaptured, runExpectingExit} from './helpers/command'
import {loadState, saveState, updateAction} from '../src/lib/state'

let dir: string
let playbook: string
const savedEnv = {...process.env}

class Run extends RunCommand {
  protected currentPlatform() {
    return 'linux' as const
  }
}

class Tick extends TickCommand {
  protected currentPlatform() {
    return 'linux' as const
  }
}

const VALID = `version: 1
actions:
  hello:
    schedule: "every 1m"
    type: shell
    run: "echo ok"
  fail:
    schedule: "every 1m"
    type: shell
    run: "exit 3"
`

function writeYaml(name: string, content: string): string {
  const file = path.join(dir, name)
  fs.writeFileSync(file, content)
  return file
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-cmd-'))
  spawnSync('git', ['init', '-q', dir])
  playbook = writeYaml('playbook.yml', VALID)
  process.env.AUTOMATOR_STATE_DIR = path.join(dir, 'state')
  // Do not inherit the machine's real config: a configured sync would change the source from the local fixture
  // to the API and make these tests depend on external state (besides attempting network).
  process.env.AUTOMATOR_CONFIG_DIR = path.join(dir, 'config')
  process.env.AUTOMATOR_PLAYBOOK = playbook
})

afterEach(() => {
  process.env = {...savedEnv}
  fs.rmSync(dir, {recursive: true, force: true})
})

describe('validate', () => {
  it('valid playbook → ok', async () => {
    const result = (await run(Validate, [])) as {ok: boolean; actions: string[]}
    expect(result.ok).toBe(true)
    expect(result.actions).toContain('hello')
  })

  it('invalid schema → exit 2', async () => {
    const bad = writeYaml('bad.yml', 'version: 1\nactions: {}\n')
    await runExpectingExit(Validate, [bad], 2)
  })

  it('invalid schedule → exit 2', async () => {
    const bad = writeYaml('badsched.yml', 'version: 1\nactions:\n  a:\n    schedule: "domani"\n    type: shell\n    run: "x"\n')
    const {stderr} = await runExpectingExit(Validate, [bad], 2)
    expect(stderr).toContain('C400-SCHEDULE-001')
  })
})

describe('list', () => {
  it('lists the actions', async () => {
    const result = (await run(List, ['--json'])) as {actions: unknown[]}
    expect(result.actions).toHaveLength(2)
  })

  // An action that already ran has its next round computed from there; a schedule that cannot be read says
  // so instead of bringing down the whole list — the list exists precisely to understand what is wrong.
  it('says when each action runs again, and does not fail on an unreadable schedule', async () => {
    updateAction(loadState(), 'hello', {last_run: '2026-07-14T10:00:00.000Z'})
    const conSchedule = (await run(List, ['--json'])) as {actions: Array<{name: string; next_run: string}>}
    expect(conSchedule.actions.find((a) => a.name === 'hello')?.next_run).not.toBe('-')

    fs.writeFileSync(playbook, VALID.replace('every 1m', 'ogni tanto'))
    const rotta = (await run(List, ['--json'])) as {actions: Array<{next_run: string}>}
    expect(rotta.actions[0].next_run).toBe('schedule invalido')
  })

  // The table is what is really read from the terminal: without `--json` it must be printed, and it must say
  // "no" for a disabled action instead of leaving the column empty.
  it('without --json prints the table, with the enabled/disabled state of each action', async () => {
    fs.writeFileSync(playbook, `${VALID}    enabled: false\n`)
    const {stdout} = await runCaptured(List, [])

    expect(stdout).toContain('NEXT RUN')
    expect(stdout).toContain('hello')
    expect(stdout).toMatch(/\bno\b/)
  })
})

describe('run', () => {
  it('--dry-run shows the command without executing', async () => {
    const result = (await run(Run, ['hello', '--dry-run'])) as {dryRun: boolean; command: string}
    expect(result.dryRun).toBe(true)
    expect(result.command).toContain('echo ok')
  })

  it('--dry-run masks command/display and cwd both in the JSON payload and in the human output', async () => {
    const commandToken = 'cyi_ah_C'
    const cwdToken = `cyi_h_${'D'.repeat(24)}`
    playbook = writeYaml('secret-playbook.yml', `version: 1\nactions:\n  leak:\n    schedule: "every 1m"\n    type: shell\n    cwd: "archive_${cwdToken}"\n    run: "echo backup_${commandToken}"\n`)
    process.env.AUTOMATOR_PLAYBOOK = playbook

    const json = await runCaptured(Run, ['leak', '--dry-run', '--json'])
    expect(JSON.stringify(json.result)).toContain('[REDACTED]')
    expect(JSON.stringify(json.result)).not.toContain(commandToken)
    expect(JSON.stringify(json.result)).not.toContain(cwdToken)

    const human = await runCaptured(Run, ['leak', '--dry-run'])
    expect(human.stdout).toContain('[REDACTED]')
    expect(human.stdout).not.toContain(commandToken)
    expect(human.stdout).not.toContain(cwdToken)
  })

  it('azione shell reale → success', async () => {
    const result = (await run(Run, ['hello'])) as {status: string}
    expect(result.status).toBe('success')
  })

  it('azione inesistente → exit 2', async () => {
    await runExpectingExit(Run, ['nope'], 2)
  })

  it('failing action → exit 1', async () => {
    await runExpectingExit(Run, ['fail'], 1)
  })

})

describe('tick', () => {
  it('--dry-run at the first run → all to be seeded, none due', async () => {
    const result = (await run(Tick, ['--dry-run'])) as {seed: string[]; due: unknown[]}
    expect(result.due).toHaveLength(0)
    expect(result.seed.sort()).toEqual(['fail', 'hello'])
  })

  it('real tick seeds the state (empty executed)', async () => {
    const result = (await run(Tick, [])) as {executed: unknown[]; seeded: string[]}
    expect(result.executed).toHaveLength(0)
    expect(result.seeded).toHaveLength(2)
  })
})

describe('logs', () => {
  it('no log for an action → empty content', async () => {
    const result = (await run(Logs, ['hello'])) as {content: string}
    expect(result.content).toBe('')
  })

  it('after a real run, shows the action log', async () => {
    await run(Run, ['hello'])
    const result = (await run(Logs, ['hello'])) as {content: string; file: string | null}
    expect(result.file).not.toBeNull()
    expect(result.content).toContain('echo ok')
  })
})

describe('human output (without --json)', () => {
  it('list prints the table', async () => {
    const {stdout} = await runCaptured(List, [])
    expect(stdout).toContain('NOME')
  })

  it('run stampa "success"', async () => {
    const {stdout} = await runCaptured(Run, ['hello'])
    expect(stdout).toContain('success')
  })

  it('run --dry-run prints the command', async () => {
    const {stdout} = await runCaptured(Run, ['hello', '--dry-run'])
    expect(stdout).toContain('dry-run')
  })

  it('tick reale stampa "eseguite"', async () => {
    const {stdout} = await runCaptured(Tick, [])
    expect(stdout).toContain('eseguite')
  })

  it('tick --dry-run stampa due/seed', async () => {
    const {stdout} = await runCaptured(Tick, ['--dry-run'])
    expect(stdout).toContain('due:')
    expect(stdout).toContain('seed:')
  })

  it('tick shows state and reason of a preflight stop', async () => {
    playbook = writeYaml('ticket.yml', `version: 1
actions:
  worker:
    schedule: "every 1m"
    type: codex
    run: "Implementa"
    cwd: missing-repository
    containment: strong
    ticket:
      project: CYAU
      code: CYAU-34
      repository: closeyourit/closeyourit-automator
`)
    process.env.AUTOMATOR_PLAYBOOK = playbook
    await run(Tick, [])
    const stateFile = path.join(process.env.AUTOMATOR_STATE_DIR!, 'state.json')
    const state = loadState(stateFile)
    saveState(stateFile, updateAction(state, 'worker', {last_run: '2026-07-01T00:00:00.000Z'}))

    const {stdout} = await runCaptured(Tick, [])
    expect(stdout).toContain('preflight stop "worker" [blocked]')
    expect(stdout).toContain('fail-closed')
  })

  it('tick skips if the lock is held by a live process', async () => {
    const stateDir = path.join(dir, 'state')
    fs.mkdirSync(stateDir, {recursive: true})
    fs.writeFileSync(path.join(stateDir, 'tick.lock'), JSON.stringify({pid: process.pid, startedAt: 'x', label: 'held'}))
    const {stdout} = await runCaptured(Tick, [])
    expect(stdout).toContain('skip')
  })

  it('logs without logs → empty message', async () => {
    const {stdout} = await runCaptured(Logs, ['hello'])
    expect(stdout).toContain('nessun log')
  })

  it('logs lists the files after a run', async () => {
    await run(Run, ['hello'])
    const {stdout} = await runCaptured(Logs, [])
    expect(stdout).toContain('FILE')
  })
})
