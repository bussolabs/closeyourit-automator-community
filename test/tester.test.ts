import * as fs from 'node:fs'
import * as path from 'node:path'

import Ajv2020 from 'ajv/dist/2020'
import {spawnSync} from 'node:child_process'
import * as net from 'node:net'
import * as os from 'node:os'

import {describe, expect, it, vi} from 'vitest'

import {BWRAP, composeBuildArgs, defaultEmulatorIo, type EmulatorIo} from '../src/lib/emulator-test'

import {
  buildTesterPrompt,
  defaultTesterIo,
  parseTesterCommands,
  probeLocalDatabase,
  runTester,
  testerCriteria,
  testerDatabaseEnvironment,
  type LocalDatabase,
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

const NO_DATABASE: LocalDatabase = {available: false, socketDir: null, port: null, detail: 'nessun database PostgreSQL locale in /run/postgresql'}
const DATABASE: LocalDatabase = {available: true, socketDir: '/run/postgresql', port: 5432, detail: 'il server risponde sul socket /run/postgresql/.s.PGSQL.5432'}

function fakeIo(overrides: Partial<TesterIo> = {}): TesterIo {
  return {
    available: async () => ({available: true}),
    database: async () => NO_DATABASE,
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
    const notStarted = await runTester({...base, askCommands: async () => bothCommands}, fakeIo({available: async () => ({available: false, detail: 'x'})}))

    for (const version of ['v1', 'v2']) {
      const schema = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'contracts', 'agent-result', version, 'schema.json'), 'utf8'))
      const validate = new Ajv2020({allErrors: true, strict: false}).compile({$ref: '#/$defs/tester_envelope', $defs: schema.$defs})
      for (const report of [passed, failed, notRun, notStarted]) {
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

  // CYAU-331 — the answer of the mapping session goes through the secret filter before it is read: a file name
  // such as test_check_cyi_sensitive.py came back as test_check_[REDACTED].py, the machine ran that, the file did
  // not exist, and a correct delivery was marked failed.
  it('does not run a command the secret filter has masked: it is not the command the session gave', async () => {
    const io = fakeIo({run: vi.fn(async () => outcome(1, {stderr: 'No such file'}))})
    const masked = answer([
      {criterion_id: 'DOD-1', command: 'python3 -m unittest tests/test_check_[REDACTED].py'},
      {criterion_id: 'DOD-2', command: 'bin/rubocop'},
    ])

    const report = await runTester({...base, askCommands: async () => masked}, fakeIo({run: io.run}))

    expect(report.block?.results[0]).toMatchObject({criterion_id: 'DOD-1', status: 'not_run'})
    expect(report.block?.results[0]?.evidence).toContain('filtro dei segreti')
    expect(io.run).toHaveBeenCalledTimes(1)
    expect(io.run).not.toHaveBeenCalledWith(expect.stringContaining('[REDACTED]'), expect.anything())
  })

  // CYAU-352 — a Tester that did not start used to deliver no block: the reason stayed in the daemon's log.
  it('is unavailable when the machine cannot confine a command, and delivers the reason for every proof', async () => {
    const io = fakeIo({available: async () => ({available: false, detail: 'bubblewrap missing'})})

    const report = await runTester({...base, askCommands: async () => bothCommands}, io)

    expect(report.status).toBe('unavailable')
    expect(report.summary).toContain('bubblewrap missing')
    expect(report.block).toMatchObject({status: 'unavailable', commit: HEAD, summary: report.summary})
    expect(report.block?.results).toEqual([
      expect.objectContaining({criterion_id: 'DOD-1', status: 'not_run', evidence: expect.stringContaining('bubblewrap missing')}),
      expect.objectContaining({criterion_id: 'DOD-2', status: 'not_run', evidence: expect.stringContaining('bubblewrap missing')}),
    ])
    expect(io.run).not.toHaveBeenCalled()
  })

  it('is unavailable when the worktree is not clean before starting: it would not know what it changed', async () => {
    const io = fakeIo({changedFiles: () => ['app/models/agents/plan.rb']})

    const report = await runTester({...base, askCommands: async () => bothCommands}, io)

    expect(report).toMatchObject({status: 'unavailable', block: {status: 'unavailable'}})
    expect(report.summary).toContain('modifiche non consegnate')
    expect(io.run).not.toHaveBeenCalled()
  })

  it('is unavailable when the mapping session gives nothing usable, and says so', async () => {
    for (const reply of [null, 'no json here']) {
      const report = await runTester({...base, askCommands: async () => reply}, fakeIo())
      expect(report).toMatchObject({status: 'unavailable', block: {status: 'unavailable'}})
      expect(report.summary).toContain('non ha indicato i comandi')
    }
  })

  it('delivers nothing when the commit cannot be read: there is no commit to name', async () => {
    expect(await runTester({...base, askCommands: async () => bothCommands}, fakeIo({headCommit: () => null})))
      .toMatchObject({status: 'unavailable', block: null})
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

// CYAU-352 — the Tester was told to give up on every proof that needs a database, even on a machine whose local
// PostgreSQL the coding session already uses for its tests: database proofs never ran, and a broken one never showed.
describe('runTester — the local database', () => {
  const dbCriteria = () => testerCriteria([
    {id: 'AC-1', text: 'The model is saved', verification: {kind: 'test', how: 'Run the model test, it uses the database'}},
  ] as never)
  const base = {criteria: dbCriteria(), cwd: '/work/ticket', ticket: 'CYRA-1', engine: 'codex' as const, timeoutSeconds: 60}
  const dbCommand = answer([{criterion_id: 'AC-1', command: 'bin/rails test test/models/plan_test.rb'}])

  it('with the database present, the prompt lets the proof run and the proof passes (AC-1)', async () => {
    const io = fakeIo({database: async () => DATABASE})
    const prompts: string[] = []

    const report = await runTester({...base, askCommands: async (prompt) => { prompts.push(prompt); return dbCommand }}, io)

    expect(prompts[0]).toContain('This machine has a local PostgreSQL')
    expect(prompts[0]).toContain('A test that needs a database CAN run here')
    expect(prompts[0]).not.toContain('it needs a database,')
    expect(io.run).toHaveBeenCalledWith('bin/rails test test/models/plan_test.rb', expect.objectContaining({database: DATABASE}))
    expect(report.status).toBe('passed')
    expect(report.block?.results[0]).toMatchObject({criterion_id: 'AC-1', status: 'passed'})
  })

  it('without a database, the reason is in the summary and the outcome is unavailable, not failed (AC-2)', async () => {
    const prompts: string[] = []
    const noCommand = answer([{criterion_id: 'AC-1', command: null, note: 'Serve un database PostgreSQL, assente su questa macchina'}])

    const report = await runTester({...base, askCommands: async (prompt) => { prompts.push(prompt); return noCommand }}, fakeIo())

    expect(prompts[0]).toContain('This machine has no local database (nessun database PostgreSQL locale in /run/postgresql)')
    expect(report.status).toBe('unavailable')
    expect(report.summary).toContain('AC-1 (Nessun comando per questa prova. Serve un database PostgreSQL, assente su questa macchina)')
    expect(report.block?.summary).toBe(report.summary)
  })

  it('without a database, a proof that could not connect is not run for the machine, with the reason', async () => {
    const io = fakeIo({run: vi.fn(async () => outcome(1, {stderr: 'PG::ConnectionBad: connection to server on socket "/run/postgresql/.s.PGSQL.5432" failed'}))})

    const report = await runTester({...base, askCommands: async () => dbCommand}, io)

    expect(report.status).toBe('unavailable')
    expect(report.block?.results[0]?.evidence).toContain('chiede un database e qui nessun database PostgreSQL locale')
  })

  it('with the database present, a proof that fails is a failure, even when it cannot connect (AC-3)', async () => {
    for (const stderr of ['1 runs, 1 failures', 'PG::ConnectionBad: connection to server on socket "/run/postgresql/.s.PGSQL.5432" failed']) {
      const io = fakeIo({database: async () => DATABASE, run: vi.fn(async () => outcome(1, {stderr}))})

      const report = await runTester({...base, askCommands: async () => dbCommand}, io)

      expect(report.status).toBe('failed')
      expect(report.summary).toContain('AC-1')
    }
  })

  it('never runs a command that would wipe a database or touch production', async () => {
    for (const command of ['bin/rails db:drop db:create', 'psql -c "DROP DATABASE app_test"', 'RAILS_ENV=production bin/rails test']) {
      const io = fakeIo({database: async () => DATABASE})

      const report = await runTester({...base, askCommands: async () => answer([{criterion_id: 'AC-1', command}])}, io)

      expect(io.run).not.toHaveBeenCalled()
      expect(report.block?.results[0]).toMatchObject({status: 'not_run', evidence: expect.stringContaining('cancellerebbe dati')})
    }
  })

  it('delivers blocks with ticket items that follow the v3 contract', async () => {
    const schema = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'contracts', 'agent-result', 'v3', 'schema.json'), 'utf8'))
    const validate = new Ajv2020({allErrors: true, strict: false}).compile({$ref: '#/$defs/tester_envelope', $defs: schema.$defs})
    const reports = [
      await runTester({...base, askCommands: async () => dbCommand}, fakeIo({database: async () => DATABASE})),
      await runTester({...base, askCommands: async () => answer([{criterion_id: 'AC-1', command: null, note: 'no db'}])}, fakeIo()),
      await runTester({...base, askCommands: async () => dbCommand}, fakeIo({available: async () => ({available: false})})),
    ]
    for (const report of reports) expect(validate(report.block), JSON.stringify(validate.errors)).toBe(true)
  })
})

describe('probeLocalDatabase', () => {
  it('finds the server that accepts a connection, and its port', async () => {
    const accepts = vi.fn(async (socket: string) => socket === '/run/postgresql/.s.PGSQL.5433')
    const probe = await probeLocalDatabase({}, {
      sockets: (dir) => (dir === '/run/postgresql' ? ['/run/postgresql/.s.PGSQL.5433'] : []),
      accepts,
    })

    expect(probe).toMatchObject({available: true, socketDir: '/run/postgresql', port: 5433})
  })

  it('does not count a socket nobody answers on', async () => {
    const probe = await probeLocalDatabase({}, {sockets: (dir) => (dir === '/tmp' ? ['/tmp/.s.PGSQL.5432'] : []), accepts: async () => false})

    expect(probe).toMatchObject({available: false, socketDir: null})
    expect(probe.detail).toContain('/tmp/.s.PGSQL.5432 esiste ma nessun server risponde')
  })

  it('says where it looked when there is no socket at all', async () => {
    const probe = await probeLocalDatabase({}, {sockets: () => [], accepts: async () => true})

    expect(probe.available).toBe(false)
    expect(probe.detail).toContain('nessun database PostgreSQL locale')
  })

  it('connects to a real Unix socket, looking first where PGHOST says', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tester-pg-')))
    const server = net.createServer((socket) => socket.end())
    await new Promise<void>((resolve) => server.listen(path.join(dir, '.s.PGSQL.6543'), resolve))
    try {
      expect(await probeLocalDatabase({PGHOST: dir})).toMatchObject({available: true, socketDir: dir, port: 6543})
    } finally {
      await new Promise((resolve) => server.close(resolve))
      fs.rmSync(dir, {recursive: true, force: true})
    }
  })
})

describe('testerDatabaseEnvironment', () => {
  it('points the proof at the local socket in the test environment, with no other database and no password', () => {
    const env = testerDatabaseEnvironment({
      PATH: '/usr/bin', DATABASE_URL: 'postgres://prod', QUEUE_DATABASE_URL: 'postgres://q', PGPASSWORD: 'x', PGPASSFILE: '/p',
      PGHOST: 'db.example', PGSERVICE: 's', PGUSER: 'admin', RAILS_ENV: 'development',
    }, DATABASE)

    expect(env).toEqual({PATH: '/usr/bin', RAILS_ENV: 'test', RACK_ENV: 'test', PGHOST: '/run/postgresql', PGPORT: '5432'})
  })

  it('without a database it still drops what would point elsewhere', () => {
    expect(testerDatabaseEnvironment({DATABASE_URL: 'postgres://x', PGHOST: 'h'}, NO_DATABASE)).toEqual({RAILS_ENV: 'test', RACK_ENV: 'test'})
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

  // CYAU-331 — the mapping session cannot open files: asked for «the whole suite passes» it answered that the
  // command is not documented in what it was given, and the proof stayed not run. The project's own
  // instructions, where that command is written, now travel with the context.
  it('hands the project instructions to the mapping session, as committed on the delivered branch', () => {
    const dir = repository()
    try {
      fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Project\nRun everything with `make verify`.\n')
      spawnSync('git', ['-C', dir, 'add', 'CLAUDE.md'])
      spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'docs'])
      fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'edited after the delivery, must not be read')

      const context = defaultTesterIo(cage()).context(dir)

      expect(context).toContain('## Project instructions (CLAUDE.md)')
      expect(context).toContain('Run everything with `make verify`.')
      expect(context).not.toContain('edited after the delivery')
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

  it('tells the Tester not to write its own program to judge how the code is shaped', () => {
    // AAC-177: a hand-made source inspector counted direct calls and failed four sound tests that call through a helper.
    expect(buildTesterPrompt(criteria())).toContain('do not write your own program to inspect the source')
  })

  // Seen on AAC: a proof ran the whole suite, the suite called `node`, and the service's PATH does not carry it —
  // the daemon is started by its absolute path. Seven tests read as failed for the machine, not for the code.
  it('puts the node that runs the daemon on the PATH of a proof', async () => {
    const dir = repository()
    // `git` must stay reachable for the fixture; the node directory must not be there already.
    vi.stubEnv('PATH', '/usr/bin:/bin')
    try {
      const runContained = vi.fn(async () => ({code: 0, stdout: Buffer.from(''), stderr: '', timedOut: false}))
      await defaultTesterIo(cage({runContained} as Partial<EmulatorIo>), () => []).run('node --version', {cwd: dir, ticket: 'T-1', timeoutSeconds: 5})

      const options = (runContained.mock.calls[0] as unknown as [string, string[], {env: NodeJS.ProcessEnv}])[2]
      expect((options.env.PATH ?? '').split(path.delimiter)).toContain(path.dirname(process.execPath))
    } finally {
      vi.unstubAllEnvs()
      fs.rmSync(dir, {recursive: true, force: true})
    }
  })

  // CYAU-331 — on a host whose PATH starts with a version-manager shim, `node` resolved to the shim, which cannot
  // run inside the cage: a suite calling node failed for the machine (105 false failures on server-minion-1).
  it('puts the daemon node before anything else on the PATH of a proof', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tester-node-first-'))
    vi.stubEnv('PATH', `/home/x/.local/share/mise/shims:${path.dirname(process.execPath)}:/usr/bin`)
    try {
      const runContained = vi.fn(async () => ({code: 0, stdout: Buffer.from(''), stderr: '', timedOut: false}))
      await defaultTesterIo(cage({runContained} as Partial<EmulatorIo>), () => []).run('node --version', {cwd: dir, ticket: 'T-1', timeoutSeconds: 5})

      const options = (runContained.mock.calls[0] as unknown as [string, string[], {env: NodeJS.ProcessEnv}])[2]
      expect((options.env.PATH ?? '').split(path.delimiter)[0]).toBe(path.dirname(process.execPath))
    } finally {
      vi.unstubAllEnvs()
      fs.rmSync(dir, {recursive: true, force: true})
    }
  })

  // CYAU-331 — the service finds cyi and node through version-manager shims, and a shim needs the real HOME:
  // inside the cage HOME is a scratch folder, so every suite calling cyi failed for the machine (16 deliveries
  // out of 20 read as failed in one run). The real tool folders go on the PATH instead.
  it('puts the real tool folders before the shims on the PATH of a proof', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tester-real-tools-'))
    vi.stubEnv('PATH', '/home/x/.local/share/mise/shims:/usr/bin')
    try {
      const runContained = vi.fn(async () => ({code: 0, stdout: Buffer.from(''), stderr: '', timedOut: false}))
      const io = defaultTesterIo(cage({runContained} as Partial<EmulatorIo>), () => ['/opt/tools/cyi/bin', '/opt/tools/gh/bin'])
      await io.run('cyi --version', {cwd: dir, ticket: 'T-1', timeoutSeconds: 5})

      const options = (runContained.mock.calls[0] as unknown as [string, string[], {env: NodeJS.ProcessEnv}])[2]
      const entries = (options.env.PATH ?? '').split(path.delimiter)
      expect(entries.slice(0, 3)).toEqual(['/opt/tools/cyi/bin', '/opt/tools/gh/bin', path.dirname(process.execPath)])
      // The shims leave the PATH: where python3 itself is a shim, it rewrote the PATH of everything it started,
      // and the suite found the shims again (seen on server-minion-1).
      expect(entries).not.toContain('/home/x/.local/share/mise/shims')
      expect(entries).toContain('/usr/bin')
    } finally {
      vi.unstubAllEnvs()
      fs.rmSync(dir, {recursive: true, force: true})
    }
  })

  it('keeps the shims on the PATH when the real tool folders are unknown', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tester-no-tools-'))
    vi.stubEnv('PATH', '/home/x/.local/share/mise/shims:/usr/bin')
    try {
      const runContained = vi.fn(async () => ({code: 0, stdout: Buffer.from(''), stderr: '', timedOut: false}))
      await defaultTesterIo(cage({runContained} as Partial<EmulatorIo>), () => []).run('cyi --version', {cwd: dir, ticket: 'T-1', timeoutSeconds: 5})

      const options = (runContained.mock.calls[0] as unknown as [string, string[], {env: NodeJS.ProcessEnv}])[2]
      expect((options.env.PATH ?? '').split(path.delimiter)).toContain('/home/x/.local/share/mise/shims')
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

  it('shows the database socket folder read-only in the cage and points the proof at it, network still off', async () => {
    const runContained = vi.fn(async () => ({code: 0, stdout: Buffer.from(''), stderr: '', timedOut: false}))
    const machine = cage({runContained, hiddenPaths: () => ({dirs: ['/run/user'], files: ['/run/docker.sock']})} as Partial<EmulatorIo>)

    await defaultTesterIo(machine, () => []).run('bin/rails test', {cwd: '/work', ticket: 'T-1', timeoutSeconds: 5, database: DATABASE})

    const [, args, options] = runContained.mock.calls[0] as unknown as [string, string[], {env: NodeJS.ProcessEnv}]
    const shown = args.indexOf('/run/postgresql')
    expect(args.slice(shown - 1, shown + 2)).toEqual(['--ro-bind', '/run/postgresql', '/run/postgresql'])
    expect(shown).toBeGreaterThan(args.lastIndexOf('--tmpfs'))
    expect(args).toContain('--unshare-net')
    expect(options.env).toMatchObject({PGHOST: '/run/postgresql', PGPORT: '5432', RAILS_ENV: 'test'})
  })

  it('does not show a socket folder that would show a hidden path again', async () => {
    const runContained = vi.fn(async () => ({code: 0, stdout: Buffer.from(''), stderr: '', timedOut: false}))
    const machine = cage({runContained, hiddenPaths: () => ({dirs: ['/run/user'], files: []})} as Partial<EmulatorIo>)

    await defaultTesterIo(machine, () => []).run('bin/rails test', {cwd: '/work', ticket: 'T-1', timeoutSeconds: 5, database: {...DATABASE, socketDir: '/run'}})

    const args = (runContained.mock.calls[0] as unknown as [string, string[]])[1]
    expect(args).not.toContain('/run')
    expect(args).toEqual(expect.arrayContaining(['--tmpfs', '/run/user']))
  })

  it('is not available without the cage', async () => {
    expect(await defaultTesterIo(cage({bwrapAvailable: () => false})).available()).toMatchObject({available: false})
    expect(await defaultTesterIo(cage()).available()).toEqual({available: true})
  })
})

// CYAU-352 — the real cage on a Linux machine with bubblewrap: the proof reaches the database socket with the network
// off, and every hidden path stays empty. The machine's own PostgreSQL when it answers, a stand-in socket otherwise.
describe('the real cage on this Linux machine', () => {
  const bwrapRuns = process.platform === 'linux' && fs.existsSync(BWRAP) &&
    spawnSync(BWRAP, ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-net', '--', 'true']).status === 0

  it.runIf(bwrapRuns)('reaches the local database through its socket and sees none of the hidden paths (AC-4)', async () => {
    const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tester-cage-')))
    const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tester-cage-scratch-')))
    let standIn: net.Server | null = null
    try {
      let database = await probeLocalDatabase()
      if (!database.available) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tester-cage-db-'))
        const server = net.createServer((socket) => socket.end())
        standIn = server
        await new Promise<void>((resolve) => server.listen(path.join(dir, '.s.PGSQL.6544'), resolve))
        database = await probeLocalDatabase({PGHOST: dir})
      }
      const hidden = defaultEmulatorIo().hiddenPaths()
      fs.writeFileSync(path.join(work, 'check.cjs'), [
        "const fs = require('node:fs'); const net = require('node:net')",
        'const [socket, hiddenJson] = process.argv.slice(2); const hidden = JSON.parse(hiddenJson)',
        // A hidden socket is masked by a device node on a nodev mount: it cannot even be opened, which hides it too.
        'const readable = (file) => { try { return fs.readFileSync(file).length > 0 } catch { return false } }',
        'const seen = [...hidden.dirs.filter((dir) => fs.readdirSync(dir).length > 0), ...hidden.files.filter(readable)]',
        'const client = net.createConnection({path: socket})',
        "client.once('connect', () => { client.destroy(); console.log(JSON.stringify({connected: true, seen})); process.exit(seen.length ? 3 : 0) })",
        "client.once('error', (error) => { console.log(JSON.stringify({connected: false, error: error.message, seen})); process.exit(2) })",
      ].join('\n'))
      const socket = path.join(database.socketDir!, `.s.PGSQL.${database.port}`)
      const quote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`
      const script = [process.execPath, 'check.cjs', socket, JSON.stringify(hidden)].map(quote).join(' ')
      const args = composeBuildArgs({worktree: work, scratch, script, hidden, network: false, sockets: [database.socketDir!]})
      expect(args).toContain('--unshare-net')

      const ran = spawnSync(BWRAP, args, {encoding: 'utf8', timeout: 30_000})

      expect(ran.status, `${ran.stdout}\n${ran.stderr}`).toBe(0)
      expect(JSON.parse(ran.stdout.trim())).toEqual({connected: true, seen: []})
    } finally {
      if (standIn) await new Promise((resolve) => standIn!.close(resolve))
      fs.rmSync(work, {recursive: true, force: true})
      fs.rmSync(scratch, {recursive: true, force: true})
    }
  })
})
