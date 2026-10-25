import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {spawnSync} from 'node:child_process'
import {describe, expect, it} from 'vitest'
import {AutomatorError, ErrorCodes} from '../src/errors/error-codes'
import {
  assertKbKind,
  composePublishBody,
  DEFAULT_KB_KIND,
  defaultPublishRepo,
  isKbKind,
  isSensitiveSourceFile,
  KB_KINDS,
  type KbPublisher,
  planPublish,
  PROVENANCE_MARKER,
  type PublishRepo,
  PublishResultSchema,
  runPublish,
  scanForSecrets,
  SECRET_PATTERNS,
} from '../src/lib/publish'
import {CREDENTIAL_SECRET_PATTERNS} from '../src/lib/secret-redaction'

function caught(fn: () => unknown): AutomatorError | undefined {
  try {
    fn()
    return undefined
  } catch (error) {
    return error as AutomatorError
  }
}

function commitIndex(root: string): void {
  expect(spawnSync('git', [
    '-c', 'user.name=Automator Test',
    '-c', 'user.email=automator@example.invalid',
    'commit', '-qm', 'fixture',
  ], {cwd: root}).status).toBe(0)
}

function fakeRepo(overrides: Partial<PublishRepo> = {}): PublishRepo {
  return {
    read: () => '# Doc versionata\n\nCorpo.',
    isTracked: () => true,
    headCommit: () => 'headsha',
    ...overrides,
  }
}

const baseInput = {
  project: 'CYAU',
  title: 'Guida deploy',
  kind: 'guide' as const,
  sourceFile: 'docs/deploy.md',
  cwd: '/wt',
  ticket: 'CYAU-59',
  runId: 'run-1',
}

describe('kind and page composition', () => {
  it('riconosce soltanto note|decision|guide', () => {
    expect(KB_KINDS).toEqual(['note', 'decision', 'guide'])
    expect(DEFAULT_KB_KIND).toBe('note')
    for (const kind of KB_KINDS) expect(isKbKind(kind)).toBe(true)
    expect(isKbKind('runbook')).toBe(false)
    expect(caught(() => assertKbKind('runbook'))?.code).toBe(ErrorCodes.Publish.invalidInput)
  })

  it('composes a deterministic body with complete or explicitly missing provenance', () => {
    const metadata = {sourceFile: 'docs/adr/queue.md', commit: 'deadbeef', ticket: 'CYAU-59', runId: 'run-42'}
    const body = composePublishBody('# ADR\n\nDecisione.', metadata)
    expect(body).toContain(PROVENANCE_MARKER)
    for (const value of ['# ADR', 'docs/adr/queue.md', 'deadbeef', 'CYAU-59', 'run-42']) expect(body).toContain(value)
    expect(body).toBe(composePublishBody('# ADR\n\nDecisione.', metadata))
    expect(composePublishBody('x', {...metadata, commit: null, runId: null})).toContain('non disponibile')
  })
})

describe('gate secret', () => {
  it('detects high-confidence secret values without blocking documentation placeholders', () => {
    expect(scanForSecrets('-----BEGIN RSA PRIVATE KEY-----')).toContain('chiave privata PEM')
    expect(scanForSecrets(`ghp_${'a'.repeat(36)}`)).toContain('GitHub personal access token')
    expect(scanForSecrets(`cyi_a_${'x'.repeat(24)}`)).toContain('token CloseYourIt')
    expect(scanForSecrets(`cyi_ah_${'x'.repeat(24)}`)).toContain('token CloseYourIt')
    expect(scanForSecrets(`cyi_agent_host_${'x'.repeat(24)}`)).toContain('token CloseYourIt')
    expect(scanForSecrets(`archive_cyi_ah_${'x'.repeat(24)}`)).toContain('token CloseYourIt')
    expect(scanForSecrets(`backup_cyi_h_${'x'.repeat(24)}`)).toContain('token CloseYourIt')
    expect(scanForSecrets(`sk-${'a'.repeat(32)}`)).toContain('chiave API generica (sk-)')
    expect(scanForSecrets('usa `cyi_a_…` o `cyi_ah_…`; il formato GitHub è `ghp_`')).toHaveLength(0)
  })

  it('also detects the minimum payload accepted for an Agent Host token', () => {
    expect(scanForSecrets('cyi_ah_s')).toContain('token CloseYourIt')
    expect(scanForSecrets(`cyi_ah_${'s'.repeat(24)}`)).toEqual(['token CloseYourIt'])
  })

  // CYAU-113: the cloud credential shapes and the session tokens have ONE single definition, shared with the
  // log redaction (secret-redaction.ts): the publication gate and the logs can no longer diverge.
  it('shares the definition of the credential shapes with the log redaction (CYAU-113)', () => {
    for (const shared of CREDENTIAL_SECRET_PATTERNS) {
      expect(SECRET_PATTERNS).toContainEqual(shared)
    }
  })

  it.each([
    '.env',
    '.env.production',
    'config/id_rsa',
    'config/credentials.json',
    'config/server.key',
    'config/client.pem',
    'config/archive.p12',
  ])('recognises the sensitive path %s', (file) => {
    expect(isSensitiveSourceFile(file)).toBe(true)
  })

  it('does not confuse documentation about secrets with credential files', () => {
    expect(isSensitiveSourceFile('docs/credentials.md')).toBe(false)
    expect(isSensitiveSourceFile('docs/secrets-management.md')).toBe(false)
  })
})

describe('planPublish — gate before the read', () => {
  it('produces plan, publication key and provenance from the tracked canonical file', () => {
    const plan = planPublish(baseInput, fakeRepo())
    expect(plan).toMatchObject({sourceFile: 'docs/deploy.md', commit: 'headsha'})
    expect(plan.publicationKey).toMatch(/^automator:knowledge:v1:/)
    expect(plan.body).toContain(PROVENANCE_MARKER)
  })

  it('a file missing from the selected commit is rejected without reading it', () => {
    let reads = 0
    let heads = 0
    let publishes = 0
    const error = caught(() => runPublish(baseInput, fakeRepo({
      isTracked: () => false,
      read: () => { reads++; return 'non leggere' },
      headCommit: () => { heads++; return 'sha' },
    }), {publish: () => { publishes++; return {id: 'never', action: 'create', adoptedLegacy: false} }}))
    expect(error?.code).toBe(ErrorCodes.Publish.notVersioned)
    expect(reads).toBe(0)
    expect(heads).toBe(1)
    expect(publishes).toBe(0)
  })

  it.each(['.env', '.env.local', 'config/id_ed25519', 'config/credentials.json']) (
    'a sensitive path %s is rejected before tracked/read/HEAD',
    (sourceFile) => {
      let tracked = 0
      let reads = 0
      let heads = 0
      let publishes = 0
      const error = caught(() => runPublish({...baseInput, sourceFile}, fakeRepo({
        isTracked: () => { tracked++; return true },
        read: () => { reads++; return 'secret' },
        headCommit: () => { heads++; return 'sha' },
      }), {publish: () => { publishes++; return {id: 'never', action: 'create', adoptedLegacy: false} }}))
      expect(error?.code).toBe(ErrorCodes.Publish.secretDetected)
      expect({tracked, reads, heads}).toEqual({tracked: 0, reads: 0, heads: 0})
      expect(publishes).toBe(0)
    },
  )

  it('a secret in the tracked documentation content is rejected after the read', () => {
    const error = caught(() => planPublish(baseInput, fakeRepo({read: () => `token: ghp_${'a'.repeat(36)}`})))
    expect(error?.code).toBe(ErrorCodes.Publish.secretDetected)
  })

  it.each([
    ['project', (token: string) => ({...baseInput, project: token}), fakeRepo()],
    ['title', (token: string) => ({...baseInput, title: `Guida ${token}`}), fakeRepo()],
    ['source path', (token: string) => ({...baseInput, sourceFile: `docs/${token}.md`}), fakeRepo()],
    ['ticket', (token: string) => ({...baseInput, ticket: token}), fakeRepo()],
    ['run id', (token: string) => ({...baseInput, runId: token}), fakeRepo()],
    ['resolved commit', (_token: string) => baseInput, fakeRepo({headCommit: () => `cyi_ah_${'r'.repeat(24)}`})],
  ] as const)('blocks a synthetic Agent Host token introduced by %s before the Knowledge', (_label, inputFor, repo) => {
    const token = `cyi_ah_${'s'.repeat(24)}`
    const error = caught(() => planPublish(inputFor(token), repo))
    expect(error?.code).toBe(ErrorCodes.Publish.secretDetected)
    expect(error?.message).not.toContain(token)
  })

  it('allows documenting harmless placeholders even in the title and in the provenance', () => {
    const plan = planPublish({
      ...baseInput,
      title: 'Formato Agent Host cyi_ah_…',
      sourceFile: 'docs/prefisso-cyi_ah_….md',
    }, fakeRepo({read: () => 'Il token Agent Host usa il formato `cyi_ah_…`.'}))
    expect(plan.title).toContain('cyi_ah_…')
    expect(plan.body).toContain('cyi_ah_…')
  })

  it('hostile input or unreadable file fail with the input code without publishing', () => {
    expect(caught(() => planPublish({...baseInput, project: 'a/b'}, fakeRepo()))?.code).toBe(ErrorCodes.Publish.invalidInput)
    expect(caught(() => planPublish({...baseInput, commit: 'non-un-oid'}, fakeRepo()))?.code).toBe(ErrorCodes.Publish.invalidInput)
    expect(caught(() => planPublish(baseInput, fakeRepo({read: () => null})))?.code).toBe(ErrorCodes.Publish.invalidInput)
  })

  it('resolves --commit and uses the same full OID for gate, read and provenance', () => {
    const requested = 'a'.repeat(12)
    const resolved = 'b'.repeat(40)
    let trackedCommit: string | null | undefined
    let readCommit: string | null | undefined
    const plan = planPublish({...baseInput, commit: requested}, fakeRepo({
      headCommit: (_cwd, revision) => {
        expect(revision).toBe(requested)
        return resolved
      },
      isTracked: ({commit}) => { trackedCommit = commit; return true },
      read: ({commit}) => { readCommit = commit; return '# snapshot selezionato' },
    }))
    expect({trackedCommit, readCommit, provenance: plan.commit}).toEqual({
      trackedCommit: resolved, readCommit: resolved, provenance: resolved,
    })
  })
})

describe('runPublish — record atomico e gate fail-closed', () => {
  it('maps the server-side outcome into an auditable record', () => {
    const kb: KbPublisher = {
      publish: () => ({id: 'page-1', action: 'update', adoptedLegacy: true}),
    }
    const result = runPublish(baseInput, fakeRepo(), kb)
    expect(result).toMatchObject({action: 'update', pageId: 'page-1', adoptedLegacy: true})
    expect(() => PublishResultSchema.parse(result)).not.toThrow()
  })

  it('a failed gate never invokes the Knowledge', () => {
    let publishes = 0
    const kb: KbPublisher = {
      publish: () => { publishes++; return {id: 'never', action: 'create', adoptedLegacy: false} },
    }
    expect(caught(() => runPublish(baseInput, fakeRepo({isTracked: () => false}), kb))?.code).toBe(
      ErrorCodes.Publish.notVersioned,
    )
    expect(publishes).toBe(0)
  })
})

describe('defaultPublishRepo — literal Git identity and immutable blob', () => {
  it('resolves the commit and verifies the regular blob with a literal ls-tree', () => {
    const invocations: Array<{cmd: string; args: string[]}> = []
    const commit = 'a'.repeat(40)
    const blob = 'b'.repeat(40)
    const repo = defaultPublishRepo((cmd, args) => {
      invocations.push({cmd, args})
      if (args.includes('rev-parse')) return {status: 0, stdout: `${commit}\n`, stderr: ''}
      return {status: 0, stdout: `100644 blob ${blob}\tdocs/x.md\0`, stderr: ''}
    })
    expect(repo.isTracked({cwd: '/wt', file: 'docs/x.md'})).toBe(true)
    expect(repo.headCommit('/wt', commit.slice(0, 12))).toBe(commit)
    expect(invocations[0].args).toEqual([
      '-C', '/wt', 'rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}',
    ])
    expect(invocations[1].args).toEqual([
      '-C', '/wt', '--literal-pathspecs', 'ls-tree', '-rz', '--full-tree', commit, '--', 'docs/x.md',
    ])
  })

  it('a path with metacharacters does not use the Git pathspec to pretend to be tracked', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-publish-literal-'))
    try {
      fs.mkdirSync(path.join(root, 'docs'))
      fs.writeFileSync(path.join(root, 'docs', 'actual.md'), '# tracked')
      expect(spawnSync('git', ['init', '-q'], {cwd: root}).status).toBe(0)
      expect(spawnSync('git', ['add', 'docs/actual.md'], {cwd: root}).status).toBe(0)
      commitIndex(root)

      const actual = defaultPublishRepo()
      let reads = 0
      let publishes = 0
      const error = caught(() => runPublish({...baseInput, cwd: root, sourceFile: 'docs/*.md'}, {
        isTracked: (args) => actual.isTracked(args),
        read: (args) => { reads++; return actual.read(args) },
        headCommit: (cwd) => actual.headCommit(cwd),
      }, {
        publish: () => { publishes++; return {id: 'never', action: 'create', adoptedLegacy: false} },
      }))
      expect(error?.code).toBe(ErrorCodes.Publish.notVersioned)
      expect(reads).toBe(0)
      expect(publishes).toBe(0)
    } finally {
      fs.rmSync(root, {recursive: true, force: true})
    }
  })

  it('staged add/delete do not change the gate of the selected immutable commit', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-publish-index-independent-'))
    try {
      fs.mkdirSync(path.join(root, 'docs'))
      fs.writeFileSync(path.join(root, 'docs', 'committed.md'), '# versione committata')
      expect(spawnSync('git', ['init', '-q'], {cwd: root}).status).toBe(0)
      expect(spawnSync('git', ['add', 'docs/committed.md'], {cwd: root}).status).toBe(0)
      commitIndex(root)
      expect(spawnSync('git', ['rm', '--cached', '-q', 'docs/committed.md'], {cwd: root}).status).toBe(0)
      fs.writeFileSync(path.join(root, 'docs', 'staged.md'), '# soltanto staged')
      expect(spawnSync('git', ['add', 'docs/staged.md'], {cwd: root}).status).toBe(0)

      const repo = defaultPublishRepo()
      const commit = repo.headCommit(root)
      expect(repo.isTracked({cwd: root, file: 'docs/committed.md', commit})).toBe(true)
      expect(repo.isTracked({cwd: root, file: 'docs/staged.md', commit})).toBe(false)
      expect(repo.read({cwd: root, file: 'docs/committed.md', commit})).toBe('# versione committata')
      expect(repo.read({cwd: root, file: 'docs/staged.md', commit})).toBeNull()
    } finally {
      fs.rmSync(root, {recursive: true, force: true})
    }
  })

  it('in a real git repo a tracked symlink pointing outside is rejected before read and publish', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-publish-root-'))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-publish-outside-'))
    try {
      fs.writeFileSync(path.join(root, 'doc.md'), '# interno')
      fs.writeFileSync(path.join(outside, 'secret.md'), 'CONTENUTO_DA_NON_LEGGERE')
      fs.symlinkSync(path.join(outside, 'secret.md'), path.join(root, 'linked.md'))
      expect(spawnSync('git', ['init', '-q'], {cwd: root}).status).toBe(0)
      expect(spawnSync('git', ['add', 'linked.md'], {cwd: root}).status).toBe(0)
      commitIndex(root)

      let reads = 0
      const run = (cmd: string, args: string[]) => {
        if (args.includes('cat-file')) reads++
        const outcome = spawnSync(cmd, args, {encoding: 'utf8'})
        return {status: outcome.status, stdout: outcome.stdout ?? '', stderr: outcome.stderr ?? ''}
      }
      const repo = defaultPublishRepo(run)
      expect(repo.isTracked({cwd: root, file: 'linked.md'})).toBe(false)
      expect(repo.read({cwd: root, file: 'linked.md'})).toBeNull()
      expect(reads).toBe(0)

      let publishes = 0
      const error = caught(() => runPublish({...baseInput, cwd: root, sourceFile: 'linked.md'}, repo, {
        publish: () => { publishes++; return {id: 'never', action: 'create', adoptedLegacy: false} },
      }))
      expect(error?.code).toBe(ErrorCodes.Publish.notVersioned)
      expect(error?.message).not.toContain('CONTENUTO_DA_NON_LEGGERE')
      expect(reads).toBe(0)
      expect(publishes).toBe(0)
    } finally {
      fs.rmSync(root, {recursive: true, force: true})
      fs.rmSync(outside, {recursive: true, force: true})
    }
  })

  it('a tracked symlink pointing to an internal .env is rejected before read and publish', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-publish-sensitive-link-'))
    try {
      fs.writeFileSync(path.join(root, '.env'), 'SEGRETO_INTERNO_DA_NON_LEGGERE')
      fs.writeFileSync(path.join(root, '.gitignore'), '.env\n')
      fs.symlinkSync('.env', path.join(root, 'docs-link.md'))
      expect(spawnSync('git', ['init', '-q'], {cwd: root}).status).toBe(0)
      expect(spawnSync('git', ['add', '.gitignore', 'docs-link.md'], {cwd: root}).status).toBe(0)
      commitIndex(root)

      let reads = 0
      let publishes = 0
      const repo = defaultPublishRepo((cmd, args) => {
        if (args.includes('cat-file')) reads++
        const outcome = spawnSync(cmd, args, {encoding: 'utf8'})
        return {status: outcome.status, stdout: outcome.stdout ?? '', stderr: outcome.stderr ?? ''}
      })
      expect(repo.isTracked({cwd: root, file: 'docs-link.md'})).toBe(false)
      const error = caught(() => runPublish({...baseInput, cwd: root, sourceFile: 'docs-link.md'}, repo, {
        publish: () => { publishes++; return {id: 'never', action: 'create', adoptedLegacy: false} },
      }))
      expect(error?.code).toBe(ErrorCodes.Publish.notVersioned)
      expect(error?.message).not.toContain('SEGRETO_INTERNO_DA_NON_LEGGERE')
      expect(reads).toBe(0)
      expect(publishes).toBe(0)
    } finally {
      fs.rmSync(root, {recursive: true, force: true})
    }
  })

  it('a TOCTOU replacement of an intermediate directory does not divert the published Git blob', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-publish-toctou-'))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-publish-toctou-outside-'))
    try {
      const docs = path.join(root, 'docs')
      const source = path.join(docs, 'doc.md')
      const secret = path.join(outside, 'doc.md')
      fs.mkdirSync(docs)
      fs.writeFileSync(source, '# documento sicuro')
      fs.writeFileSync(secret, 'SEGRETO_TOCTOU_DA_NON_LEGGERE')
      expect(spawnSync('git', ['init', '-q'], {cwd: root}).status).toBe(0)
      expect(spawnSync('git', ['add', 'docs/doc.md'], {cwd: root}).status).toBe(0)
      commitIndex(root)

      let blobReads = 0
      let swapped = false
      let publishes = 0
      let publishedBody = ''
      const repo = defaultPublishRepo((cmd, args) => {
        if (args.includes('cat-file')) {
          blobReads++
          if (!swapped) {
            fs.renameSync(docs, `${docs}-original`)
            fs.symlinkSync(outside, docs)
            swapped = true
          }
        }
        const outcome = spawnSync(cmd, args, {encoding: 'utf8'})
        return {status: outcome.status, stdout: outcome.stdout ?? '', stderr: outcome.stderr ?? ''}
      })
      const result = runPublish({...baseInput, cwd: root, sourceFile: 'docs/doc.md'}, repo, {
        publish: ({body}) => {
          publishes++
          publishedBody = body
          return {id: 'safe', action: 'create', adoptedLegacy: false}
        },
      })
      expect(result.pageId).toBe('safe')
      expect(publishedBody).toContain('# documento sicuro')
      expect(publishedBody).not.toContain('SEGRETO_TOCTOU_DA_NON_LEGGERE')
      expect(blobReads).toBe(1)
      expect(publishes).toBe(1)
    } finally {
      fs.rmSync(root, {recursive: true, force: true})
      fs.rmSync(outside, {recursive: true, force: true})
    }
  })

  it('with a real runner a non-git directory does not show as tracked', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-publish-git-'))
    try {
      const repo = defaultPublishRepo()
      expect(repo.isTracked({cwd: root, file: 'x.md'})).toBe(false)
      expect(repo.headCommit(root)).toBeNull()
    } finally {
      fs.rmSync(root, {recursive: true, force: true})
    }
  })
})
