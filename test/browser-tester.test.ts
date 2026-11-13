import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {afterEach, describe, expect, it, vi} from 'vitest'

import type {EmulatorIo, EmulatorRunOutcome} from '../src/lib/emulator-test'

import {
  browserCriteria,
  browserStepArgs,
  browserTesterDelivery,
  browserTesterRuntimes,
  defaultBrowserTesterIo,
  readBrowserAccess,
  resolveBrowserTools,
  buildBrowserPrompt,
  parseBrowserActions,
  runBrowserTester,
  type BrowserAccess,
  type BrowserSession,
  type BrowserTesterIo,
} from '../src/lib/browser-tester'

const HEAD = 'b'.repeat(40)
const ACCESS: BrowserAccess = {url: 'https://staging.example.test/login', username: 'tester@example.test', password: 'S3cret-pass!'}

function criteria() {
  return browserCriteria([
    {id: 'DOD-1', text: 'The plan model keeps the criteria', verification: {kind: 'test', how: 'Run the spec'}},
    {id: 'DOD-2', text: 'The settings page saves the choice', verification: {kind: 'browser', how: 'Open settings, pick a value, save'}},
    'an old plain criterion',
  ])
}

function fakeSession(overrides: Partial<BrowserSession> = {}): BrowserSession {
  return {
    step: vi.fn(async () => ({ok: true, output: '✓ Done'})),
    snapshot: vi.fn(async () => '- textbox "Email" [ref=e1]\n- textbox "Password" [ref=e2]\n- button "Sign in" [ref=e3]'),
    pageText: vi.fn(async () => 'Settings saved'),
    screenshot: vi.fn(async () => Buffer.from('png')),
    close: vi.fn(async () => undefined),
    ...overrides,
  }
}

function fakeIo(session: BrowserSession | null, overrides: Partial<BrowserTesterIo> = {}): BrowserTesterIo {
  return {
    available: async () => ({available: true}),
    start: vi.fn(async () => session),
    attach: vi.fn(async () => 'tester-DOD-2-bbbbbbbbbbbb.png'),
    ...overrides,
  }
}

function reply(actions: unknown[]): string {
  return `Next.\n${JSON.stringify({actions})}`
}

function input(asks: Array<string | null>) {
  const queue = [...asks]
  return {
    criteria: criteria(), access: ACCESS, commit: HEAD, ticket: 'CYRA-1', project: 'CYRA', engine: 'codex' as const,
    askStep: vi.fn(async () => (queue.length > 0 ? queue.shift()! : null)),
  }
}

describe('browserCriteria', () => {
  it('keeps only the criteria proven in a browser', () => {
    expect(criteria()).toEqual([{id: 'DOD-2', text: 'The settings page saves the choice', how: 'Open settings, pick a value, save'}])
  })
})

describe('parseBrowserActions', () => {
  it('reads the known actions and drops what is outside the agreed shape', () => {
    const parsed = parseBrowserActions(reply([
      {action: 'fill', ref: 'e1', text: '{{USERNAME}}'},
      {action: 'click', ref: '@e3'},
      {action: 'eval', code: 'document.cookie'},
      {action: 'press', key: 'Enter'},
    ]))
    expect(parsed).toEqual([
      {action: 'fill', ref: 'e1', text: '{{USERNAME}}'},
      {action: 'click', ref: 'e3'},
      {action: 'press', key: 'Enter'},
    ])
  })

  it('returns null when the answer is not the agreed shape', () => {
    expect(parseBrowserActions('I clicked the button and it worked.')).toBeNull()
  })

  it('keeps at most six actions and nothing after a done', () => {
    const many = Array.from({length: 9}, () => ({action: 'press', key: 'Tab'}))
    expect(parseBrowserActions(reply(many))).toHaveLength(6)
    const afterDone = parseBrowserActions(reply([
      {action: 'done', status: 'passed', evidence: 'saved', expect: 'Settings saved'}, {action: 'press', key: 'Tab'},
    ]))
    expect(afterDone).toEqual([{action: 'done', status: 'passed', evidence: 'saved', expect: 'Settings saved'}])
  })
})

describe('browserStepArgs', () => {
  it('puts the real credentials in place of the placeholders, for a fill only', () => {
    expect(browserStepArgs({action: 'fill', ref: 'e2', text: '{{PASSWORD}}'}, ACCESS)).toEqual(['fill', '@e2', 'S3cret-pass!'])
    expect(browserStepArgs({action: 'fill', ref: 'e1', text: '{{USERNAME}}'}, ACCESS)).toEqual(['fill', '@e1', 'tester@example.test'])
  })

  it('refuses a page outside the staging host', () => {
    expect(browserStepArgs({action: 'open', url: 'https://staging.example.test/settings'}, ACCESS)).toEqual(['open', 'https://staging.example.test/settings'])
    expect(browserStepArgs({action: 'open', url: 'https://evil.example.org/'}, ACCESS)).toBeNull()
    expect(browserStepArgs({action: 'open', url: 'https://staging.example.test/?p={{PASSWORD}}'}, ACCESS)).toBeNull()
  })

  it('bounds a wait', () => {
    expect(browserStepArgs({action: 'wait', ms: 60_000}, ACCESS)).toEqual(['wait', '5000'])
  })
})

describe('buildBrowserPrompt', () => {
  it('never carries the password', () => {
    const prompt = buildBrowserPrompt(criteria()[0], ACCESS, {page: 'a page', history: ['fill e2 → ok']})
    expect(prompt).not.toContain(ACCESS.password)
    expect(prompt).toContain('{{PASSWORD}}')
    expect(prompt).toContain('DOD-2')
  })
})

describe('runBrowserTester', () => {
  it('passes a criterion when the expected text is on the page, and attaches the screenshot', async () => {
    const session = fakeSession()
    const io = fakeIo(session)
    const report = await runBrowserTester(input([
      reply([{action: 'fill', ref: 'e1', text: '{{USERNAME}}'}, {action: 'fill', ref: 'e2', text: '{{PASSWORD}}'}, {action: 'click', ref: 'e3'}]),
      reply([{action: 'done', status: 'passed', evidence: 'The page says the choice is saved', expect: 'settings saved'}]),
    ]), io)

    expect(report.status).toBe('passed')
    expect(report.block).toMatchObject({moment: 'staging', status: 'passed', engine: 'codex', commit: HEAD})
    expect(report.block?.results).toEqual([expect.objectContaining({
      criterion_id: 'DOD-2', kind: 'browser', status: 'passed', attachment: 'tester-DOD-2-bbbbbbbbbbbb.png',
    })])
    expect(session.step).toHaveBeenCalledWith(['fill', '@e2', ACCESS.password])
    expect(session.close).toHaveBeenCalled()
  })

  it('does not take a pass whose expected text is not on the page', async () => {
    const session = fakeSession({pageText: vi.fn(async () => 'Something went wrong')})
    const report = await runBrowserTester(input([
      reply([{action: 'done', status: 'passed', evidence: 'saved', expect: 'Settings saved'}]),
      reply([{action: 'done', status: 'failed', evidence: 'The page shows an error instead of the confirmation'}]),
    ]), fakeIo(session))

    expect(report.status).toBe('failed')
    expect(report.block?.results[0].status).toBe('failed')
  })

  it('is not run when the session gives no usable step', async () => {
    const report = await runBrowserTester(input([null]), fakeIo(fakeSession()))
    expect(report.status).toBe('unavailable')
    expect(report.block?.results[0].status).toBe('not_run')
  })

  it('stops after the turn limit', async () => {
    const turns = Array.from({length: 30}, () => reply([{action: 'press', key: 'Tab'}]))
    const run = input(turns)
    const report = await runBrowserTester(run, fakeIo(fakeSession()))
    expect(report.block?.results[0].status).toBe('not_run')
    expect(run.askStep.mock.calls.length).toBeLessThanOrEqual(12)
  })

  it('never lets the password reach the report or the next prompt', async () => {
    const session = fakeSession({
      step: vi.fn(async () => ({ok: false, output: `✗ could not type ${ACCESS.password}`})),
      snapshot: vi.fn(async () => `- textbox "Password" value "${ACCESS.password}" [ref=e2]`),
    })
    const run = input([
      reply([{action: 'fill', ref: 'e2', text: '{{PASSWORD}}'}]),
      reply([{action: 'done', status: 'failed', evidence: `typed ${ACCESS.password} and nothing happened`}]),
    ])
    const report = await runBrowserTester(run, fakeIo(session))

    expect(JSON.stringify(report)).not.toContain(ACCESS.password)
    for (const call of run.askStep.mock.calls) expect(String(call[0])).not.toContain(ACCESS.password)
  })

  it('is unavailable, with nothing to deliver, when the browser does not start', async () => {
    const report = await runBrowserTester(input([]), fakeIo(null))
    expect(report).toMatchObject({status: 'unavailable', block: null})
  })

  it('is unavailable when the machine has no browser', async () => {
    const io = fakeIo(fakeSession(), {available: async () => ({available: false, detail: 'agent-browser missing'})})
    const report = await runBrowserTester(input([]), io)
    expect(report).toMatchObject({status: 'unavailable', block: null})
    expect(io.start).not.toHaveBeenCalled()
  })
})

describe('readBrowserAccess', () => {
  const project = JSON.stringify({data: {key: 'CYRA', test_access: {
    url: 'https://staging.example.test/login', username: 'tester@example.test', password_secret: 'TEST_ACCESS_PASSWORD', environment: 'staging',
  }}})

  it('reads link and user from the project and the password from the named staging secret', () => {
    const run = vi.fn((args: string[]) => (args[0] === 'projects' ? {status: 0, stdout: project} : {status: 0, stdout: 'S3cret-pass!\n'}))
    expect(readBrowserAccess('CYRA', run)).toEqual(ACCESS)
    expect(run).toHaveBeenLastCalledWith(['secrets', 'get', 'TEST_ACCESS_PASSWORD', '-p', 'CYRA', '-e', 'staging'])
  })

  it('is null when the project gives no access or the secret cannot be read', () => {
    expect(readBrowserAccess('CYRA', () => ({status: 0, stdout: JSON.stringify({data: {test_access: null}})}))).toBeNull()
    expect(readBrowserAccess('CYRA', (args) => (args[0] === 'projects' ? {status: 0, stdout: project} : {status: 1, stdout: ''}))).toBeNull()
  })

  it('does not ask the vault for a name that is not a secret name', () => {
    const odd = JSON.stringify({data: {test_access: {url: 'https://s.example.test', username: 'u', password_secret: '--yes', environment: 'staging'}}})
    const run = vi.fn(() => ({status: 0, stdout: odd}))
    expect(readBrowserAccess('CYRA', run)).toBeNull()
    expect(run).toHaveBeenCalledTimes(1)
  })
})

describe('browserTesterRuntimes', () => {
  const tools = () => ({bin: '/bin/true', chrome: '/bin/true'})

  it('declares the browser only with the Tester on and the tools installed', () => {
    expect(browserTesterRuntimes({AUTOMATOR_TESTER: '1'}, tools)[0]).toMatchObject({name: 'tester-browser', present: true})
    expect(browserTesterRuntimes({}, tools)[0]).toMatchObject({name: 'tester-browser', present: false})
    expect(browserTesterRuntimes({AUTOMATOR_TESTER: '1'}, () => null)[0]).toMatchObject({present: false})
  })
})

describe('browserTesterDelivery', () => {
  const target = {criteria: criteria(), commit: HEAD, ticket: 'CYRA-1', project: 'CYRA'}

  it('is unavailable and says so on the ticket when the project gives no access', async () => {
    const comment = vi.fn()
    const run = vi.fn()
    const report = await browserTesterDelivery(target, {readAccess: () => null, run, comment})('codex', async () => null)
    expect(report).toMatchObject({status: 'unavailable', block: null})
    expect(run).not.toHaveBeenCalled()
    expect(comment).toHaveBeenCalledWith('CYRA-1', 'CYRA', expect.stringContaining('non è partito'))
  })

  it('writes nothing on the ticket when the proofs pass', async () => {
    const comment = vi.fn()
    const passed = {status: 'passed' as const, summary: 'ok', block: null}
    const report = await browserTesterDelivery(target, {readAccess: () => ACCESS, run: async () => passed, comment})('codex', async () => null)
    expect(report).toBe(passed)
    expect(comment).not.toHaveBeenCalled()
  })

  it('never throws', async () => {
    const report = await browserTesterDelivery(target, {readAccess: () => { throw new Error('boom') }, comment: vi.fn()})('codex', async () => null)
    expect(report.status).toBe('unavailable')
  })
})

describe('defaultBrowserTesterIo (the machine side, with a fake machine)', () => {
  const dirs: string[] = []
  const temp = (): string => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bt-')))
    dirs.push(dir)
    return dir
  }
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, {recursive: true, force: true})
  })

  const ran = (stdout: string, code: number | null = 0): EmulatorRunOutcome => ({code, stdout: Buffer.from(stdout), stderr: '', timedOut: false})

  function machine(answer: (script: string, env: NodeJS.ProcessEnv) => EmulatorRunOutcome, overrides: Partial<EmulatorIo> = {}) {
    const scratch = temp()
    let clock = 0
    const calls: Array<{script: string; args: string[]; env: NodeJS.ProcessEnv}> = []
    const io = {
      bwrapAvailable: () => true,
      containmentAvailable: async () => ({available: true}),
      hiddenPaths: () => ({dirs: [], files: []}),
      makeScratch: () => scratch,
      removeScratch: vi.fn(),
      now: () => (clock += 1000),
      sleep: async () => undefined,
      runContained: vi.fn(async (_cmd: string, args: string[], opts: {env?: NodeJS.ProcessEnv; signal?: AbortSignal}) => {
        const script = args[args.length - 1]
        calls.push({script, args, env: opts.env ?? {}})
        if (script.includes('exec sleep')) {
          // The holder lives until it is aborted.
          await new Promise<void>((resolve) => opts.signal?.addEventListener('abort', () => resolve(), {once: true}))
          return ran('', null)
        }
        return answer(script, opts.env ?? {})
      }),
      ...overrides,
    } as unknown as EmulatorIo
    return {io, calls, scratch}
  }
  const tools = () => ({bin: '/opt/agent-browser', chrome: '/opt/chrome'})

  it('is not available without the tools or without the cage', async () => {
    const {io} = machine(() => ran('ok'))
    expect(await defaultBrowserTesterIo(io, () => null).available()).toMatchObject({available: false})
    const noCage = machine(() => ran('ok'), {bwrapAvailable: () => false})
    expect(await defaultBrowserTesterIo(noCage.io, tools).available()).toMatchObject({available: false})
    expect(await defaultBrowserTesterIo(io, tools).available()).toEqual({available: true})
    expect(await defaultBrowserTesterIo(io, () => null).start({ticket: 'T-1', url: 'https://staging.example.test/'})).toBeNull()
  })

  it('keeps one cage for the browser and sends each step from a short one, limited to the staging host', async () => {
    const {io, calls, scratch} = machine((_script, env) => {
      if (env.AB_ARG_0 === 'screenshot') fs.writeFileSync(env.AB_ARG_1!, 'PNG')
      return ran(env.AB_ARG_0 === 'open' ? '✗ Domain not allowed' : '✓ Done')
    })
    const session = await defaultBrowserTesterIo(io, tools).start({ticket: 'T-1', url: 'https://staging.example.test/login'})
    expect(session).not.toBeNull()

    expect(await session!.step(['click', '@e1'])).toEqual({ok: true, output: '✓ Done'})
    expect((await session!.step(['open', 'https://elsewhere.test/'])).ok).toBe(false)
    expect(await session!.snapshot()).toBe('✓ Done')
    expect(await session!.pageText()).toBe('✓ Done')
    expect((await session!.screenshot())?.toString()).toBe('PNG')
    await session!.close()

    const holder = calls[0]
    expect(holder.script).toContain('exec sleep')
    expect(holder.env).toMatchObject({
      AB_BIN: '/opt/agent-browser', AGENT_BROWSER_EXECUTABLE_PATH: '/opt/chrome', AGENT_BROWSER_ALLOWED_DOMAINS: 'staging.example.test',
      AB_ARG_0: 'https://staging.example.test/login', HOME: scratch,
    })
    const click = calls.find((call) => call.env.AB_ARG_0 === 'click')!
    expect(click.script).toBe('exec "$AB_BIN" "$AB_ARG_0" "$AB_ARG_1"')
    expect(click.env.AB_ARG_1).toBe('@e1')
    // The socket folder is short, bound into the cage, and gone after the session.
    const sockets = String(click.env.XDG_RUNTIME_DIR)
    expect(click.args).toContain(sockets)
    expect(click.env.TMPDIR).toBe(sockets)
    expect(fs.existsSync(sockets)).toBe(false)
    expect(io.removeScratch).toHaveBeenCalledWith(scratch)
  })

  it('gives up, and cleans up, when the browser never answers', async () => {
    const {io} = machine(() => ran('✗ Failed to start daemon', 1))
    expect(await defaultBrowserTesterIo(io, tools).start({ticket: 'T-1', url: 'https://staging.example.test/'})).toBeNull()
    expect(io.removeScratch).toHaveBeenCalled()
  })

  it('has no screenshot when the tool does not write one', async () => {
    const {io} = machine(() => ran('✓ Done'))
    const session = await defaultBrowserTesterIo(io, tools).start({ticket: 'T-1', url: 'https://staging.example.test/'})
    expect(await session!.screenshot()).toBeNull()
    await session!.close()
  })

  it('attaches a screenshot once per name', async () => {
    const {io} = machine(() => ran('ok'))
    const image = Buffer.from('PNG')
    const fresh = vi.fn((args: string[]) => ({status: 0, stdout: args[1] === 'attachments' ? '[]' : ''}))
    expect(await defaultBrowserTesterIo(io, tools, fresh).attach({ticket: 'T-1', project: 'P', name: 'shot.png', image})).toBe('shot.png')
    expect(fresh).toHaveBeenLastCalledWith(expect.arrayContaining(['tickets', 'attach', 'T-1', '-p', 'P', '--file']), expect.any(Number))

    const already = vi.fn(() => ({status: 0, stdout: '[{"name":"shot.png"}]'}))
    expect(await defaultBrowserTesterIo(io, tools, already).attach({ticket: 'T-1', project: 'P', name: 'shot.png', image})).toBe('shot.png')
    expect(already).toHaveBeenCalledTimes(1)

    const down = vi.fn(() => ({status: 1, stdout: ''}))
    expect(await defaultBrowserTesterIo(io, tools, down).attach({ticket: 'T-1', project: 'P', name: 'shot.png', image})).toBeNull()
  })

  it('finds the tool and its newest Chrome from the environment and the home folder', () => {
    const home = temp()
    const bin = path.join(home, 'agent-browser-bin')
    fs.writeFileSync(bin, '#!/bin/sh\n', {mode: 0o755})
    for (const version of ['chrome-150.0', 'chrome-157.0']) {
      fs.mkdirSync(path.join(home, '.agent-browser', 'browsers', version), {recursive: true})
      fs.writeFileSync(path.join(home, '.agent-browser', 'browsers', version, 'chrome'), '#!/bin/sh\n', {mode: 0o755})
    }
    expect(resolveBrowserTools({AUTOMATOR_AGENT_BROWSER: bin}, home)).toEqual({
      bin, chrome: path.join(home, '.agent-browser', 'browsers', 'chrome-157.0', 'chrome'),
    })
    expect(resolveBrowserTools({AUTOMATOR_AGENT_BROWSER: bin}, temp())).toBeNull()
    expect(resolveBrowserTools({AUTOMATOR_AGENT_BROWSER: bin, AGENT_BROWSER_EXECUTABLE_PATH: bin}, temp())).toEqual({bin, chrome: bin})
  })
})
