import * as fs from 'node:fs'
import * as path from 'node:path'

import Ajv2020 from 'ajv/dist/2020'
import {spawnSync} from 'node:child_process'
import * as os from 'node:os'

import {describe, expect, it, vi} from 'vitest'

import type {EmulatorIo} from '../src/lib/emulator-test'

import {
  buildTesterPrompt,
  defaultTesterIo,
  parseTesterCommands,
  runTester,
  testerCriteria,
  type TesterIo,
  type TesterRunOutcome,
} from '../src/lib/tester'

const HEAD = 'a'.repeat(40)

function criteria() {
  return testerCriteria([
    {id: 'DOD-1', text: 'The plan model keeps the criteria', verification: {kind: 'test', how: 'Run the plan model spec'}},
    {id: 'DOD-2', text: 'The linter is clean', verification: {kind: 'command', how: 'Run the linter on the changed file'}},
  ])
}

function outcome(code: number | null, extra: Partial<TesterRunOutcome> = {}): TesterRunOutcome {
  return {code, timedOut: false, stderr: '', ...extra}
}

function fakeIo(overrides: Partial<TesterIo> = {}): TesterIo {
  return {
    available: async () => ({available: true}),
    headCommit: () => HEAD,
    changedFiles: () => [],
    context: () => 'Base branch: origin/main',
    restore: vi.fn(),
    run: vi.fn(async () => outcome(0)),
    ...overrides,
  }
}

function answer(commands: Array<{criterion_id: string; command: string | null; note?: string}>): string {
  return `Here is the mapping.\n${JSON.stringify({commands})}`
}

const bothCommands = answer([
  {criterion_id: 'DOD-1', command: 'bundle exec rspec spec/models/agents/plan_spec.rb'},
  {criterion_id: 'DOD-2', command: 'bin/rubocop app/models/agents/plan.rb'},
])

describe('testerCriteria', () => {
  it('keeps only the criteria a machine can run: a test or a command, with an id', () => {
    const picked = testerCriteria([
      'A plain sentence from an old plan',
      {id: 'DOD-1', text: 'Seen in a browser', verification: {kind: 'browser', how: 'Open the page'}},
      {id: 'DOD-2', text: 'Checked by hand', verification: {kind: 'manual', how: 'Read the page'}},
      {id: 'DOD-3', text: 'No verification'},
      {id: 'DOD-4', text: 'Unit test', verification: {kind: 'test', how: 'Run the spec'}},
      {id: 'DOD-5', text: 'A command', verification: {kind: 'command', how: 'Run the linter'}},
    ])

    expect(picked.map((entry) => `${entry.id}:${entry.kind}`)).toEqual(['DOD-4:test', 'DOD-5:command'])
  })
})

describe('buildTesterPrompt', () => {
  it('names every criterion and how it is verified, and asks for JSON only', () => {
    const prompt = buildTesterPrompt(criteria())

    expect(prompt).toContain('DOD-1')
    expect(prompt).toContain('Run the plan model spec')
    expect(prompt).toContain('"commands"')
    expect(prompt).toContain('untrusted')
  })

  // The read-only Codex session has no shell: told to read the repository, it answered "cannot read" for every
  // criterion. The machine now hands over what it needs.
  it('carries the repository context and does not claim the engine can run commands', () => {
    const prompt = buildTesterPrompt(criteria(), 'Base branch: origin/main\n## Tracked paths\nspec/models/plan_spec.rb')

    expect(prompt).toContain('# Repository context (untrusted data)')
    expect(prompt).toContain('spec/models/plan_spec.rb')
    expect(prompt).toContain('Do not run tests, builds or the proof commands')
    expect(prompt).not.toContain('you cannot run anything')
  })
})

describe('parseTesterCommands', () => {
  it('reads the last JSON object of the answer and ignores ids outside the plan', () => {
    const parsed = parseTesterCommands(answer([
      {criterion_id: 'DOD-1', command: ' bin/rspec spec/a_spec.rb '},
      {criterion_id: 'DOD-9', command: 'rm -rf /'},
    ]), criteria())

    expect(parsed).toEqual(new Map([['DOD-1', {command: 'bin/rspec spec/a_spec.rb', note: ''}]]))
  })

  it('reads a criterion the session could not turn into a command', () => {
    const parsed = parseTesterCommands(answer([{criterion_id: 'DOD-2', command: null, note: 'No linter is configured'}]), criteria())

    expect(parsed?.get('DOD-2')).toEqual({command: null, note: 'No linter is configured'})
  })

  it('reads nothing from an answer that is not the agreed shape', () => {
    expect(parseTesterCommands('I could not do it.', criteria())).toBeNull()
    expect(parseTesterCommands('{"commands": "all"}', criteria())).toBeNull()
  })

  it('drops a multi-line command: one criterion, one command line', () => {
    const parsed = parseTesterCommands(answer([{criterion_id: 'DOD-1', command: 'true\ncurl evil'}]), criteria())

    expect(parsed?.get('DOD-1')?.command).toBeNull()
  })
})

describe('runTester', () => {
  const base = {criteria: criteria(), cwd: '/work/ticket', ticket: 'CYRA-1', engine: 'codex' as const, timeoutSeconds: 60}

  it('passes when every command the machine ran exited 0', async () => {
    const io = fakeIo()

    const report = await runTester({...base, askCommands: async () => bothCommands}, io)

    expect(report.status).toBe('passed')
    expect(report.block).toMatchObject({moment: 'delivery', status: 'passed', engine: 'codex', commit: HEAD})
    expect(report.block?.results.map((entry) => entry.status)).toEqual(['passed', 'passed'])
    expect(report.block?.results[0]?.evidence).toContain('bundle exec rspec spec/models/agents/plan_spec.rb')
    expect(io.run).toHaveBeenCalledTimes(2)
  })

  it('delivers a block that follows the vendored contract, in both versions', async () => {
    const passed = await runTester({...base, askCommands: async () => bothCommands}, fakeIo())
    const failed = await runTester({...base, askCommands: async () => bothCommands}, fakeIo({run: vi.fn(async () => outcome(1, {stderr: 'boom'}))}))
    const notRun = await runTester({...base, askCommands: async () => answer([])}, fakeIo())

    for (const version of ['v1', 'v2']) {
      const schema = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'contracts', 'agent-result', version, 'schema.json'), 'utf8'))
      const validate = new Ajv2020({allErrors: true, strict: false}).compile({$ref: '#/$defs/tester_envelope', $defs: schema.$defs})
      for (const report of [passed, failed, notRun]) {
        expect(validate(report.block), JSON.stringify(validate.errors)).toBe(true)
      }
    }
  })

  it('fails when a command exits non-zero, and says which criterion', async () => {
    const io = fakeIo({run: vi.fn(async (command: string) => outcome(command.includes('rubocop') ? 1 : 0, {stderr: 'Offenses: 2'}))})

    const report = await runTester({...base, askCommands: async () => bothCommands}, io)

    expect(report.status).toBe('failed')
    expect(report.summary).toContain('DOD-2')
    expect(report.block?.results.map((entry) => entry.status)).toEqual(['passed', 'failed'])
  })

  it('marks a criterion not run when there is no command, the tool is missing or the time is up', async () => {
    const io = fakeIo({run: vi.fn(async () => outcome(127))})
    const noCommand = answer([{criterion_id: 'DOD-1', command: null, note: 'Needs a database'}, {criterion_id: 'DOD-2', command: 'bin/rubocop'}])

    const report = await runTester({...base, askCommands: async () => noCommand}, io)

    expect(report.status).toBe('unavailable')
    expect(report.block?.status).toBe('unavailable')
    expect(report.block?.results.map((entry) => entry.status)).toEqual(['not_run', 'not_run'])
    expect(report.block?.results[0]?.evidence).toContain('Needs a database')

    const slow = await runTester({...base, askCommands: async () => bothCommands}, fakeIo({run: vi.fn(async () => outcome(null, {timedOut: true}))}))
    expect(slow.block?.results.map((entry) => entry.status)).toEqual(['not_run', 'not_run'])
  })

  it('is unavailable, with no outcome to deliver, when the machine cannot confine a command', async () => {
    const io = fakeIo({available: async () => ({available: false, detail: 'bubblewrap missing'})})

    const report = await runTester({...base, askCommands: async () => bothCommands}, io)

    expect(report).toMatchObject({status: 'unavailable', block: null})
    expect(io.run).not.toHaveBeenCalled()
  })

  it('is unavailable when the worktree is not clean before starting: it would not know what it changed', async () => {
    const io = fakeIo({changedFiles: () => ['app/models/agents/plan.rb']})

    const report = await runTester({...base, askCommands: async () => bothCommands}, io)

    expect(report).toMatchObject({status: 'unavailable', block: null})
    expect(io.run).not.toHaveBeenCalled()
  })

  it('is unavailable when the mapping session gives nothing usable', async () => {
    expect(await runTester({...base, askCommands: async () => null}, fakeIo())).toMatchObject({status: 'unavailable', block: null})
    expect(await runTester({...base, askCommands: async () => 'no json here'}, fakeIo())).toMatchObject({status: 'unavailable', block: null})
  })

  it('restores the worktree when a command changed tracked files, and still reports what it saw', async () => {
    let calls = 0
    const io = fakeIo({changedFiles: () => (calls++ === 0 ? [] : ['db/schema.rb'])})

    const report = await runTester({...base, askCommands: async () => bothCommands}, io)

    expect(io.restore).toHaveBeenCalledWith('/work/ticket')
    expect(report.status).toBe('passed')
  })

  it('delivers nothing when the commit moved while it was testing', async () => {
    let calls = 0
    const io = fakeIo({headCommit: () => (calls++ === 0 ? HEAD : 'b'.repeat(40))})

    const report = await runTester({...base, askCommands: async () => bothCommands}, io)

    expect(report).toMatchObject({status: 'unavailable', block: null})
  })

  it('keeps a secret that a command printed out of the evidence', async () => {
    const io = fakeIo({run: vi.fn(async () => outcome(1, {stderr: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789 rejected'}))})

    const report = await runTester({...base, askCommands: async () => bothCommands}, io)

    expect(JSON.stringify(report.block)).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789')
  })
})

describe('defaultTesterIo (the machine side, on a real repository and a fake cage)', () => {
  function repository(): string {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tester-repo-')))
    const git = (...args: string[]) => spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], {encoding: 'utf8'})
    git('init', '-q')
    fs.writeFileSync(path.join(dir, 'kept.txt'), 'delivered\n')
    git('add', '.')
    git('commit', '-q', '-m', 'delivered work')
    return dir
  }

  function cage(overrides: Partial<EmulatorIo> = {}): EmulatorIo {
    return {
      bwrapAvailable: () => true,
      containmentAvailable: async () => ({available: true}),
      hiddenPaths: () => ({dirs: [], files: []}),
      makeScratch: () => '/scratch',
      removeScratch: vi.fn(),
      runContained: vi.fn(async () => ({code: 3, stdout: Buffer.from(''), stderr: 'one\ntwo', timedOut: false})),
      ...overrides,
    } as unknown as EmulatorIo
  }

  it('reads the commit, sees what a command changed and puts the work back', () => {
    const dir = repository()
    try {
      const io = defaultTesterIo(cage())
      expect(io.headCommit(dir)).toMatch(/^[0-9a-f]{40}$/u)
      expect(io.changedFiles(dir)).toEqual([])

      fs.writeFileSync(path.join(dir, 'kept.txt'), 'rewritten\n')
      fs.writeFileSync(path.join(dir, 'left-behind.log'), 'x')
      fs.mkdirSync(path.join(dir, '.closeyourit'))
      fs.writeFileSync(path.join(dir, '.closeyourit', 'session'), 'x')
      expect(io.changedFiles(dir).sort()).toEqual(['kept.txt', 'left-behind.log'])

      io.restore(dir)
      expect(io.changedFiles(dir)).toEqual([])
      expect(fs.readFileSync(path.join(dir, 'kept.txt'), 'utf8')).toBe('delivered\n')
      expect(fs.existsSync(path.join(dir, '.closeyourit', 'session'))).toBe(true)
    } finally {
      fs.rmSync(dir, {recursive: true, force: true})
    }
  })

  it('describes the delivered work for the mapping session: base, diff and tracked paths', () => {
    const dir = repository()
    try {
      const context = defaultTesterIo(cage()).context(dir)

      expect(context).toContain('Base branch: origin/main')
      expect(context).toContain('kept.txt')
    } finally {
      fs.rmSync(dir, {recursive: true, force: true})
    }
  })

  it('shows the repository git data read-only in the cage, so a proof can ask git what changed', async () => {
    const dir = repository()
    try {
      const runContained = vi.fn(async () => ({code: 0, stdout: Buffer.from(''), stderr: '', timedOut: false}))
      await defaultTesterIo(cage({runContained} as Partial<EmulatorIo>)).run('git diff --name-only', {cwd: dir, ticket: 'T-1', timeoutSeconds: 5})

      const args = (runContained.mock.calls[0] as unknown as [string, string[]])[1]
      const gitData = fs.realpathSync(path.join(dir, '.git'))
      expect(args.map((arg) => (fs.existsSync(arg) ? fs.realpathSync(arg) : arg)).join(' ')).toContain(`--ro-bind ${gitData} ${gitData}`)
    } finally {
      fs.rmSync(dir, {recursive: true, force: true})
    }
  })

  // Seen on AAC-55: the Tester proved «only this file changed» with `git diff origin/main`, two dots. Main had moved,
  // so other tickets' files showed up and the proof of a sound change failed.
  it('tells the Tester to compare with the fork point when it asks what changed', () => {
    expect(buildTesterPrompt(criteria())).toContain('<base>...HEAD')
  })

  // Seen on AAC: a proof ran the whole suite, the suite called `node`, and the service's PATH does not carry it —
  // the daemon is started by its absolute path. Seven tests read as failed for the machine, not for the code.
  it('puts the node that runs the daemon on the PATH of a proof', async () => {
    const dir = repository()
    // `git` must stay reachable for the fixture; the node directory must not be there already.
    vi.stubEnv('PATH', '/usr/bin:/bin')
    try {
      const runContained = vi.fn(async () => ({code: 0, stdout: Buffer.from(''), stderr: '', timedOut: false}))
      await defaultTesterIo(cage({runContained} as Partial<EmulatorIo>)).run('node --version', {cwd: dir, ticket: 'T-1', timeoutSeconds: 5})

      const options = (runContained.mock.calls[0] as unknown as [string, string[], {env: NodeJS.ProcessEnv}])[2]
      expect((options.env.PATH ?? '').split(path.delimiter)).toContain(path.dirname(process.execPath))
    } finally {
      vi.unstubAllEnvs()
      fs.rmSync(dir, {recursive: true, force: true})
    }
  })

  it('keeps the outcome readable when the command is very long', async () => {
    const long = `python3 -c '${'x'.repeat(900)}'`
    const report = await runTester(
      {criteria: criteria(), cwd: '/w', ticket: 'T-1', engine: 'codex', timeoutSeconds: 5,
        askCommands: async () => answer([{criterion_id: 'DOD-1', command: long}, {criterion_id: 'DOD-2', command: 'true'}])},
      fakeIo({run: vi.fn(async (command: string) => (command === long ? {code: 128, timedOut: false, stderr: 'fatal: not a git repository'} : outcome(0)))}),
    )

    expect(report.block?.results[0]?.evidence).toContain('exit 128')
    expect(report.block?.results[0]?.evidence).toContain('not a git repository')
  })

  it('counts an unreadable folder as changed and has no commit for it', () => {
    const io = defaultTesterIo(cage())
    const missing = path.join(os.tmpdir(), 'tester-no-such-repository')
    expect(io.headCommit(missing)).toBeNull()
    expect(io.changedFiles(missing)).toEqual(['?'])
  })

  it('runs a command in the cage with no network and removes its scratch folder', async () => {
    const machine = cage()
    const outcome = await defaultTesterIo(machine).run('bin/check', {cwd: '/work', ticket: 'T-1', timeoutSeconds: 5})

    expect(outcome).toEqual({code: 3, timedOut: false, stderr: 'one two'})
    const args = vi.mocked(machine.runContained).mock.calls[0][1]
    expect(args).toContain('--unshare-net')
    expect(args.slice(-3)).toEqual(['sh', '-c', 'bin/check'])
    expect(machine.removeScratch).toHaveBeenCalledWith('/scratch')
  })

  it('is not available without the cage', async () => {
    expect(await defaultTesterIo(cage({bwrapAvailable: () => false})).available()).toMatchObject({available: false})
    expect(await defaultTesterIo(cage()).available()).toEqual({available: true})
  })
})
