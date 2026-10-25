import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {describe, expect, it} from 'vitest'
import {AutomatorError, ErrorCodes} from '../src/errors/error-codes'
import {RetryableDeliveryError} from '../src/lib/delivery-errors'
import {
  canonicalSourceFile,
  defaultKbPublisher,
  defaultPublishBodyFiles,
  type CommandOutcome,
  type CommandRunner,
  type KbPublisher,
  parseKbPublishResponse,
  planPublish,
  publicationKeyFor,
  type PublishBodyFiles,
  type PublishRepo,
  runPublish,
} from '../src/lib/publish'

const input = {
  project: 'CYAU',
  title: 'Guida "deploy" con spazi',
  kind: 'guide' as const,
  sourceFile: './docs/runbooks/../deploy.md',
  cwd: '/checkout/worker-a',
  ticket: 'CYAU-59',
  runId: 'run-1',
}

function repo(over: Partial<PublishRepo> = {}): PublishRepo {
  return {
    read: () => '# Doc versionata\n\nCorpo.',
    isTracked: () => true,
    headCommit: () => 'abc123',
    ...over,
  }
}

function caught(fn: () => unknown): AutomatorError | undefined {
  try {
    fn()
    return undefined
  } catch (error) {
    return error as AutomatorError
  }
}

interface Invocation {
  args: string[]
  cmd: string
}

function runner(outcomes: CommandOutcome[]): {invocations: Invocation[]; run: CommandRunner} {
  const invocations: Invocation[] = []
  return {
    invocations,
    run(cmd, args) {
      invocations.push({cmd, args})
      return outcomes.shift() ?? {status: 0, stdout: '', stderr: ''}
    },
  }
}

function bodyFiles(path = '/private/tmp/automator body.md'): PublishBodyFiles & {bodies: string[]} {
  const bodies: string[] = []
  return {
    bodies,
    use(body, callback) {
      bodies.push(body)
      return callback(path)
    },
  }
}

function success(operation: 'created' | 'updated', adoptedLegacy = false, id = 'page-1'): CommandOutcome {
  return {
    status: 0,
    stderr: '',
    stdout: JSON.stringify({data: {id}, meta: {operation, adopted_legacy: adoptedLegacy}}),
  }
}

function failure(code: string, message = 'backend rejected'): CommandOutcome {
  return {status: 1, stderr: '', stdout: JSON.stringify({error: {code, message}})}
}

describe('publicationKeyFor — deterministic atomic identity of the versioned source', () => {
  it('canonicalizes the source without depending on the worker absolute path', () => {
    expect(canonicalSourceFile('/checkout/worker-a', './docs/runbooks/../deploy.md')).toBe('docs/deploy.md')
    expect(canonicalSourceFile('/checkout/worker-b', '/checkout/worker-b/docs/deploy.md')).toBe('docs/deploy.md')
  })

  it('produces a URI-safe <=255 key stable per project+source and opaque to the contents', () => {
    const first = publicationKeyFor('CYAU', 'docs/deploy.md')
    const same = publicationKeyFor('cyau', 'docs/deploy.md')
    expect(first).toBe(same)
    expect(first).toMatch(/^[A-Za-z0-9][A-Za-z0-9._~:-]{0,254}$/)
    expect(first.length).toBeLessThanOrEqual(255)
    expect(first).not.toContain('docs/deploy.md')
    expect(first).not.toContain('run-1')
    expect(publicationKeyFor('CYRA', 'docs/deploy.md')).not.toBe(first)
    expect(publicationKeyFor('CYAU', 'docs/other.md')).not.toBe(first)
  })

  it('planPublish keeps the provenance and makes the key independent of commit, ticket, run and content', () => {
    const first = planPublish(input, repo())
    const retry = planPublish(
      {...input, ticket: 'CYAU-60', runId: 'run-2', commit: 'd'.repeat(40)},
      repo({read: () => '# Contenuto aggiornato'}),
    )
    expect(first.sourceFile).toBe('docs/deploy.md')
    expect(first.publicationKey).toBe(retry.publicationKey)
    expect(first.body).toContain('docs/deploy.md')
    expect(first.body).toContain('CYAU-59')
  })

  it('rejects a source resolving outside the worktree before reading files or invoking the KB', () => {
    let reads = 0
    const err = caught(() => planPublish({...input, sourceFile: '../secret.md'}, repo({read: () => { reads++; return 'x' }})))
    expect(err?.code).toBe(ErrorCodes.Publish.invalidInput)
    expect(reads).toBe(0)
  })
})

describe('defaultKbPublisher — a single cyi kb publish with injected runner/body-file', () => {
  it('uses atomic argv and puts no body or quoting in the command line', () => {
    const r = runner([success('created')])
    const files = bodyFiles()
    const publisher = defaultKbPublisher(r.run, files)
    const body = '# Segreto-no: contenuto con "quote" e\npiù righe'

    const result = publisher.publish({
      project: 'CYAU',
      publicationKey: 'automator:knowledge:v1:key',
      title: 'Guida "deploy" con spazi',
      kind: 'guide',
      body,
    })

    expect(result).toEqual({id: 'page-1', action: 'create', adoptedLegacy: false})
    expect(r.invocations).toEqual([{
      cmd: 'cyi',
      args: [
        'kb', 'publish', '-p', 'CYAU',
        '--publication-key', 'automator:knowledge:v1:key',
        '--title', 'Guida "deploy" con spazi',
        '--kind', 'guide',
        '--body-file', '/private/tmp/automator body.md',
        '--json',
      ],
    }])
    expect(r.invocations[0].args).not.toContain(body)
    expect(r.invocations[0].args).not.toContain('--body')
    expect(files.bodies).toEqual([body])
    expect('listPages' in publisher).toBe(false)
    expect('create' in publisher).toBe(false)
    expect('update' in publisher).toBe(false)
    expect('delete' in publisher).toBe(false)
  })

  it('respects the contract even through a real but local cyi subprocess', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-fake-cyi-'))
    const executable = path.join(directory, 'cyi')
    const oldPath = process.env.PATH
    try {
      fs.writeFileSync(
        executable,
        `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
const expected = ['kb', 'publish', '-p', 'CYAU', '--publication-key', 'automator:knowledge:v1:key', '--title', 'Titolo con "quote"', '--kind', 'guide']
if (!expected.every((value, index) => args[index] === value)) process.exit(41)
if (args.includes('--body') || args.includes('BODY_SUBPROCESS')) process.exit(42)
const bodyFile = args[args.indexOf('--body-file') + 1]
if (fs.readFileSync(bodyFile, 'utf8') !== 'BODY_SUBPROCESS') process.exit(43)
process.stdout.write(JSON.stringify({data: {id: 'subprocess-page'}, meta: {operation: 'created', adopted_legacy: false}}))
`,
        {mode: 0o700},
      )
      process.env.PATH = `${directory}${path.delimiter}${oldPath ?? ''}`
      expect(defaultKbPublisher().publish({
        project: 'CYAU',
        publicationKey: 'automator:knowledge:v1:key',
        title: 'Titolo con "quote"',
        kind: 'guide',
        body: 'BODY_SUBPROCESS',
      })).toEqual({id: 'subprocess-page', action: 'create', adoptedLegacy: false})
    } finally {
      process.env.PATH = oldPath
      fs.rmSync(directory, {recursive: true, force: true})
    }
  })

  it('reads the JSON error from the Oclif stdout in --json even through a subprocess', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-fake-cyi-error-'))
    const executable = path.join(directory, 'cyi')
    const oldPath = process.env.PATH
    try {
      fs.writeFileSync(
        executable,
        `#!/usr/bin/env node
if (!process.argv.includes('--json')) process.exit(40)
process.stdout.write(JSON.stringify({error: {code: 'R409-KNOWLEDGE-001', message: 'BODY_SUBPROCESS'}}))
process.exit(1)
`,
        {mode: 0o700},
      )
      process.env.PATH = `${directory}${path.delimiter}${oldPath ?? ''}`
      const err = caught(() => defaultKbPublisher().publish({
        project: 'CYAU', publicationKey: 'k', title: 'T', kind: 'note', body: 'BODY_SUBPROCESS',
      }))
      expect(err?.message).toContain('R409-KNOWLEDGE-001')
      expect(err?.message).not.toContain('BODY_SUBPROCESS')
    } finally {
      process.env.PATH = oldPath
      fs.rmSync(directory, {recursive: true, force: true})
    }
  })

  it.each([
    ['created', false, 'create'],
    ['updated', false, 'update'],
    ['updated', true, 'update'],
  ] as const)('interpreta operation=%s adopted=%s', (operation, adopted, action) => {
    const r = runner([success(operation, adopted)])
    expect(defaultKbPublisher(r.run, bodyFiles()).publish({
      project: 'CYAU', publicationKey: 'k', title: 'T', kind: 'note', body: 'B',
    })).toEqual({id: 'page-1', action, adoptedLegacy: adopted})
  })

  it.each([
    ['R409-KNOWLEDGE-001', 'N legacy'],
    ['C404-KNW-001', 'backend route missing'],
    ['R401-CLIAUTH-001', 'not authenticated'],
    ['R403-CLIAUTH-002', 'not authorized'],
    ['R422-KNOWLEDGE-005', 'invalid payload'],
  ])('propagates fail-closed %s (%s) from the CYCL-8 JSON stdout without exposing the body', (code) => {
    const r = runner([failure(code)])
    const secretBody = `non-esporre-${'x'.repeat(40)}`
    const err = caught(() => defaultKbPublisher(r.run, bodyFiles()).publish({
      project: 'CYAU', publicationKey: 'k', title: 'T', kind: 'note', body: secretBody,
    }))
    expect(err?.code).toBe(ErrorCodes.Publish.commandFailed)
    expect(err?.message).toContain(code)
    expect(err?.message).not.toContain(secretBody)
  })

  it('does not reflect a body the backend included in the error message', () => {
    const secretBody = `non-esporre-${'x'.repeat(40)}`
    const r = runner([failure('R422-KNOWLEDGE-005', `body non valido: ${secretBody}`)])
    const err = caught(() => defaultKbPublisher(r.run, bodyFiles()).publish({
      project: 'CYAU', publicationKey: 'k', title: 'T', kind: 'note', body: secretBody,
    }))
    expect(err?.message).toContain('R422-KNOWLEDGE-005')
    expect(err?.message).not.toContain(secretBody)
  })

  it('preserves the structured code even if the envelope contains no message', () => {
    const r = runner([{status: 1, stderr: '', stdout: '{"error":{"code":"R403-CLIAUTH-002"}}'}])
    const err = caught(() => defaultKbPublisher(r.run, bodyFiles()).publish({
      project: 'CYAU', publicationKey: 'k', title: 'T', kind: 'note', body: 'B',
    }))
    expect(err?.message).toContain('R403-CLIAUTH-002')
  })

  it('in --json considera stdout autorevole e usa stderr soltanto come fallback', () => {
    const r = runner([{
      status: 1,
      stderr: '{"error":{"code":"R401-CLIAUTH-001","message":"non riflettere"}}',
      stdout: '{"error":{"code":"R409-KNOWLEDGE-001","message":"non riflettere"}}',
    }])
    const err = caught(() => defaultKbPublisher(r.run, bodyFiles()).publish({
      project: 'CYAU', publicationKey: 'k', title: 'T', kind: 'note', body: 'B',
    }))
    expect(err?.message).toContain('R409-KNOWLEDGE-001')
    expect(err?.message).not.toContain('R401-CLIAUTH-001')
    expect(err?.message).not.toContain('non riflettere')
  })

  it('uses the structured code on stderr when stdout contains no JSON envelope', () => {
    const r = runner([{
      status: 1,
      stderr: '{"error":{"code":"R403-CLIAUTH-002","message":"non riflettere"}}',
      stdout: 'output non strutturato',
    }])
    const err = caught(() => defaultKbPublisher(r.run, bodyFiles()).publish({
      project: 'CYAU', publicationKey: 'k', title: 'T', kind: 'note', body: 'B',
    }))
    expect(err?.message).toContain('R403-CLIAUTH-002')
    expect(err?.message).not.toContain('non riflettere')
    expect(err?.message).not.toContain('output non strutturato')
  })

  it('rejects arbitrary or multiline error.code values without reflecting the payload', () => {
    const leaked = `R401-CLIAUTH-001\nTOKEN_${'x'.repeat(80)}`
    const r = runner([{
      status: 1,
      stderr: '',
      stdout: JSON.stringify({error: {code: leaked, message: 'BODY_DA_NON_RIFLETTERE'}}),
    }])
    const err = caught(() => defaultKbPublisher(r.run, bodyFiles()).publish({
      project: 'CYAU', publicationKey: 'k', title: 'T', kind: 'note', body: 'BODY_DA_NON_RIFLETTERE',
    }))
    expect(err?.message).toContain('exit 1')
    expect(err?.message).not.toContain('TOKEN_')
    expect(err?.message).not.toContain('BODY_DA_NON_RIFLETTERE')
  })

  it.each(['{}', '{"data":{"id":"p"}}', '{"data":{"id":"p"},"meta":{"operation":"created"}}', 'not-json'])(
    'risposta successo invalida %s → fail-closed',
    (stdout) => {
      const r = runner([{status: 0, stdout, stderr: ''}])
      const err = caught(() => defaultKbPublisher(r.run, bodyFiles()).publish({
        project: 'CYAU', publicationKey: 'k', title: 'T', kind: 'note', body: 'B',
      }))
      expect(err?.code).toBe(ErrorCodes.Publish.invalidResponse)
      expect(err).not.toBeInstanceOf(RetryableDeliveryError)
    },
  )

  it('makes only explicit outages retryable, not auth/policy or malformed success responses', () => {
    const outage = caught(() => defaultKbPublisher(runner([{
      status: 1, stdout: '{"error":{"code":"C502-KNOWLEDGE-001"}}', stderr: '',
    }]).run, bodyFiles()).publish({project: 'CYAU', publicationKey: 'k', title: 'T', kind: 'note', body: 'B'}))
    expect(outage).toBeInstanceOf(RetryableDeliveryError)

    const auth = caught(() => defaultKbPublisher(runner([failure('R403-CLIAUTH-002')]).run, bodyFiles()).publish({
      project: 'CYAU', publicationKey: 'k', title: 'T', kind: 'note', body: 'B',
    }))
    expect(auth).not.toBeInstanceOf(RetryableDeliveryError)
  })
})

describe('runPublish — retry, concorrenza e legacy 0/1/N delegati al server atomico', () => {
  it('retry after a lost response reuses the same key and returns the same updated page', () => {
    const r = runner([
      {status: null, stdout: '', stderr: 'socket closed after commit'},
      success('updated', false, 'same-page'),
    ])
    const files = bodyFiles()
    const publisher = defaultKbPublisher(r.run, files)

    const lostResponse = caught(() => runPublish(input, repo(), publisher))
    expect(lostResponse?.code).toBe(ErrorCodes.Publish.commandFailed)
    expect(lostResponse).toBeInstanceOf(RetryableDeliveryError)
    const retry = runPublish(input, repo(), publisher)

    expect(retry).toMatchObject({action: 'update', pageId: 'same-page'})
    const keys = r.invocations.map(({args}) => args[args.indexOf('--publication-key') + 1])
    expect(keys[0]).toBe(keys[1])
  })

  it('two workers on the same source use the same key and converge on the same page', () => {
    const r = runner([success('created', false, 'shared-page'), success('updated', false, 'shared-page')])
    const publisher = defaultKbPublisher(r.run, bodyFiles())
    const workerA = runPublish(input, repo(), publisher)
    const workerB = runPublish({...input, cwd: '/checkout/worker-b', sourceFile: 'docs/deploy.md'}, repo(), publisher)

    expect([workerA.action, workerB.action]).toEqual(['create', 'update'])
    expect(workerA.pageId).toBe(workerB.pageId)
    expect(workerA.publicationKey).toBe(workerB.publicationKey)
  })

  it('legacy 0/1/N: create, update adoption, or 409 propagated without list/create/update fallback', () => {
    const zero = defaultKbPublisher(runner([success('created', false, 'new')]).run, bodyFiles())
    const one = defaultKbPublisher(runner([success('updated', true, 'legacy')]).run, bodyFiles())
    const many = defaultKbPublisher(runner([failure('R409-KNOWLEDGE-001')]).run, bodyFiles())

    expect(runPublish(input, repo(), zero)).toMatchObject({action: 'create', pageId: 'new', adoptedLegacy: false})
    expect(runPublish(input, repo(), one)).toMatchObject({action: 'update', pageId: 'legacy', adoptedLegacy: true})
    expect(caught(() => runPublish(input, repo(), many))?.message).toContain('R409-KNOWLEDGE-001')
  })
})

describe('defaultPublishBodyFiles — file effimero 0600 e cleanup', () => {
  it('writes the body outside the argv and always removes the file', () => {
    let usedPath = ''
    defaultPublishBodyFiles().use('body privato', (file) => {
      usedPath = file
      expect(fs.readFileSync(file, 'utf8')).toBe('body privato')
      expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    })
    expect(fs.existsSync(usedPath)).toBe(false)
  })

  it('removes the file even when the callback fails', () => {
    let usedPath = ''
    expect(() => defaultPublishBodyFiles().use('body privato', (file) => {
      usedPath = file
      throw new Error('subprocess fallito')
    })).toThrow('subprocess fallito')
    expect(fs.existsSync(usedPath)).toBe(false)
  })
})

describe('parseKbPublishResponse', () => {
  it('accepts only complete atomic envelopes', () => {
    expect(parseKbPublishResponse(success('updated', true).stdout)).toEqual({
      id: 'page-1', action: 'update', adoptedLegacy: true,
    })
    expect(parseKbPublishResponse('{}')).toBeNull()
  })
})
