import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {describe, expect, it} from 'vitest'
import {type AgentRunResult} from '../src/lib/agent-result'
import {
  assertDeliverableBranch,
  assertDeliverableTicket,
  assertGatePassed,
  composePrBody,
  composePrTitle,
  DEFAULT_BASE_BRANCH,
  DEFAULT_REMOTE,
  defaultDeliveryProbe,
  defaultOperationalDeliveryProbe,
  type DeliveryProbe,
  isDeliverableBranch,
  planDelivery,
  type PrContent,
  prContentFromResult,
  runDelivery,
} from '../src/lib/deliver'
import {AutomatorError, ErrorCodes} from '../src/errors/error-codes'
import {RetryableDeliveryError} from '../src/lib/delivery-errors'

// Uniform delivery of the run for human review (CYAU-24): when the automatic gates are green the
// workflow pushes the allowed branch (only ticket/*), opens the PR (non-interactive gh), links ticket ↔ PR and
// reconfirms the ticket as In Review (idempotent CYI transition), NEVER an automatic merge. The core is pure
// (guards, PR composition, plan); the execution lives behind an injectable probe. Idempotence for robustness:
// link and CYI transition are ALWAYS re-run (never skipped on a local state that could diverge).

describe('isDeliverableBranch / assertDeliverableBranch — push only on ticket/*', () => {
  it('accepts a ticket/<ticket> branch with a safe segment', () => {
    expect(isDeliverableBranch('ticket/CYAU-24')).toBe(true)
    expect(isDeliverableBranch('ticket/CYAU-1')).toBe(true)
  })

  it('rejects the protected branches and everything that is not ticket/*', () => {
    for (const b of ['main', 'master', 'develop', 'staging', 'production', 'release/1.2', 'hotfix/x', 'feature/x']) {
      expect(isDeliverableBranch(b)).toBe(false)
    }
  })

  it('rejects ticket/ without name or with an unsafe segment (traversal)', () => {
    expect(isDeliverableBranch('ticket/')).toBe(false)
    expect(isDeliverableBranch('ticket/..')).toBe(false)
    expect(isDeliverableBranch('ticket/a/b')).toBe(false)
  })

  it('assertDeliverableBranch throws C400-DELIVER-001 (exit 2) on a non-deliverable branch', () => {
    const err = (() => {
      try {
        assertDeliverableBranch('main')
      } catch (e) {
        return e as AutomatorError
      }
    })()
    expect(err).toBeInstanceOf(AutomatorError)
    expect(err?.code).toBe(ErrorCodes.Deliver.invalidBranch)
    expect(err?.exitCode).toBe(2)
    expect(() => assertDeliverableBranch('ticket/CYAU-24')).not.toThrow()
  })
})

describe('assertDeliverableTicket — the ticket code ends up in the cyi argv', () => {
  it('accepts a safe ticket', () => {
    expect(() => assertDeliverableTicket('CYAU-24')).not.toThrow()
  })

  it('rejects empty ticket, with separators or hostile keys → C400-DELIVER-004 (exit 2)', () => {
    for (const bad of ['', 'a/b', '..', '__proto__']) {
      const err = (() => {
        try {
          assertDeliverableTicket(bad)
        } catch (e) {
          return e as AutomatorError
        }
      })()
      expect(err?.code).toBe(ErrorCodes.Deliver.invalidInput)
      expect(err?.exitCode).toBe(2)
    }
  })
})

describe('assertGatePassed — do not deliver if the gates are not green', () => {
  it('green gates → does not throw', () => {
    expect(() => assertGatePassed(true)).not.toThrow()
  })

  it('non-green gates → C409-DELIVER-002 (exit 3)', () => {
    const err = (() => {
      try {
        assertGatePassed(false)
      } catch (e) {
        return e as AutomatorError
      }
    })()
    expect(err?.code).toBe(ErrorCodes.Deliver.gateNotPassed)
    expect(err?.exitCode).toBe(3)
  })
})

describe('composePrTitle', () => {
  it('composes <ticket>: <first line of the summary>', () => {
    expect(composePrTitle({ticket: 'CYAU-24', summary: 'Apre la PR e porta in review\ndettagli'})).toBe(
      'CYAU-24: Apre la PR e porta in review',
    )
  })

  it('without summary uses a default title with the ticket', () => {
    expect(composePrTitle({ticket: 'CYAU-24', summary: null})).toBe('CYAU-24: consegna per la review')
  })

  it('an explicit override takes precedence', () => {
    expect(composePrTitle({ticket: 'CYAU-24', summary: 'x'}, 'Titolo scelto')).toBe('Titolo scelto')
  })
})

describe('composePrBody — the PR contains summary, tests and risks (DoD)', () => {
  const full: PrContent = {
    ticket: 'CYAU-24',
    summary: 'Consegna uniforme: push, PR, In Review.',
    tests: {passed: 12, failed: 0, summary: 'deliver.test.ts verde'},
    risks: ['Dipende da gh/cyi configurati sull’host'],
    changedFiles: ['src/lib/deliver.ts', 'src/commands/deliver.ts'],
  }

  it('includes the three mandatory sections with the provided contents', () => {
    const body = composePrBody(full)
    expect(body).toContain('## Riepilogo')
    expect(body).toContain('Consegna uniforme: push, PR, In Review.')
    expect(body).toContain('## Test')
    expect(body).toContain('12 passati, 0 falliti — deliver.test.ts verde')
    expect(body).toContain('## Rischi')
    expect(body).toContain('- Dipende da gh/cyi configurati sull’host')
  })

  it('mentions the ticket → PR side of the bidirectional ticket ↔ PR link', () => {
    expect(composePrBody(full)).toContain('CYAU-24')
    expect(composePrBody(full)).toMatch(/Ticket:\s*CYAU-24/)
  })

  it('lists the modified files when present', () => {
    expect(composePrBody(full)).toContain('`src/lib/deliver.ts`')
  })

  it('the three sections are ALWAYS there, with placeholders for missing data (DoD even without report)', () => {
    const body = composePrBody({ticket: 'CYAU-24', summary: null, tests: null, risks: []})
    expect(body).toContain('## Riepilogo')
    expect(body).toContain('Nessun riepilogo fornito.')
    expect(body).toContain('## Test')
    expect(body).toContain('Nessun esito di test riportato.')
    expect(body).toContain('## Rischi')
    expect(body).toContain('Nessun rischio segnalato.')
  })

  it('tests with only the summary (without counts) stay readable', () => {
    const body = composePrBody({ticket: 'CYAU-24', summary: 'x', tests: {passed: null, failed: null, summary: 'suite di area verde'}, risks: []})
    expect(body).toContain('suite di area verde')
  })
})

function makeResult(over: Partial<AgentRunResult> = {}): AgentRunResult {
  return {
    outcome: 'success',
    summary: 'Riepilogo agente',
    changedFiles: ['src/lib/deliver.ts'],
    tests: {passed: 3, failed: 0, summary: 'ok'},
    risks: ['rischio A'],
    commit: 'abc123',
    confidence: 0.9,
    metadata: {
      runtime: 'claude',
      action: 'impl',
      exitCode: 0,
      errorCode: null,
      durationMs: 10,
      logPath: '/tmp/x.log',
      reportParsed: true,
    },
    ...over,
  }
}

describe('prContentFromResult — bridge from the uniform agent outcome', () => {
  it('extracts summary, tests, risks and modified files from an AgentRunResult', () => {
    const content = prContentFromResult('CYAU-24', makeResult())
    expect(content).toEqual({
      ticket: 'CYAU-24',
      summary: 'Riepilogo agente',
      tests: {passed: 3, failed: 0, summary: 'ok'},
      risks: ['rischio A'],
      changedFiles: ['src/lib/deliver.ts'],
    })
  })

  it('redacts secrets in the report before they reach commit/PR', () => {
    const token = `ghp_${'a'.repeat(36)}`
    const source = makeResult()
    const content = prContentFromResult('CYAU-24', {
      ...source,
      summary: `summary ${token}`,
      tests: {...source.tests, summary: `tests ${token}`},
      risks: [`risk ${token}`],
      changedFiles: [`docs/${token}.md`],
    })
    expect(JSON.stringify(content)).not.toContain(token)
    expect(JSON.stringify(content)).toContain('[REDACTED]')
  })
})

describe('planDelivery — pure plan, never automatic merge', () => {
  const content: PrContent = {ticket: 'CYAU-24', summary: 's', tests: null, risks: []}

  it('composes branch/base/title/body and plans no merge', () => {
    const plan = planDelivery({content, branch: 'ticket/CYAU-24'})
    expect(plan.branch).toBe('ticket/CYAU-24')
    expect(plan.base).toBe(DEFAULT_BASE_BRANCH)
    expect(plan.title).toBe('CYAU-24: s')
    expect(plan.body).toContain('## Riepilogo')
    expect(plan.autoMerge).toBe(false)
  })

  it('respects an explicit base', () => {
    expect(planDelivery({content, branch: 'ticket/CYAU-24', base: 'develop'}).base).toBe('develop')
    expect(planDelivery({content, branch: 'ticket/CYAU-24', base: 'release/next'}).base).toBe('release/next')
    expect(() => planDelivery({content, branch: 'ticket/CYAU-24', base: '--upload-pack=evil'})).toThrow(/base/i)
  })

  it('non-deliverable branch → throws (guard before any action)', () => {
    expect(() => planDelivery({content, branch: 'main'})).toThrow(AutomatorError)
  })

  it('unsafe ticket → throws (guard before any action)', () => {
    expect(() => planDelivery({content: {...content, ticket: 'a/b'}, branch: 'ticket/CYAU-24'})).toThrow(AutomatorError)
  })
})

// Fake probe recording every call: isolates the orchestration from the real git/gh/cyi.
interface Calls {
  push: Array<{cwd: string; branch: string; remote: string}>
  findPr: Array<{cwd: string; branch: string; base: string}>
  createPr: Array<{cwd: string; branch: string; base: string; title: string; body: string}>
  linkTicket: Array<{ticket: string; prUrl: string}>
}

function fakeProbe(existingPr: string | null = null): {probe: DeliveryProbe; calls: Calls} {
  const calls: Calls = {push: [], findPr: [], createPr: [], linkTicket: []}
  return {
    calls,
    probe: {
      push: (a) => calls.push.push(a),
      findPr: (a) => {
        calls.findPr.push(a)
        return existingPr
      },
      createPr: (a) => {
        calls.createPr.push(a)
        return 'https://github.com/acme/widget/pull/7'
      },
      linkTicket: (a) => calls.linkTicket.push(a),
    },
  }
}

const runInput = (over: Record<string, unknown> = {}): Parameters<typeof runDelivery>[0] => ({
  content: {ticket: 'CYAU-24', summary: 'Consegna', tests: {passed: 5, failed: 0, summary: 'ok'}, risks: ['r']},
  branch: 'ticket/CYAU-24',
  cwd: '/wt',
  gatePassed: true,
  ...over,
})

describe('runDelivery — Scenario 1: green gates → push, PR opened, ticket In Review', () => {
  it('pushes the branch, opens the PR (with summary/tests/risks), links the ticket and brings it to review', () => {
    const {probe, calls} = fakeProbe(null)
    const res = runDelivery(runInput(), probe)

    expect(calls.push).toEqual([{cwd: '/wt', branch: 'ticket/CYAU-24', remote: DEFAULT_REMOTE}])
    // findPr filters on the branch AND on the base that would be opened.
    expect(calls.findPr).toEqual([{cwd: '/wt', branch: 'ticket/CYAU-24', base: DEFAULT_BASE_BRANCH}])
    expect(calls.createPr).toHaveLength(1)
    expect(calls.createPr[0].body).toContain('## Riepilogo')
    expect(calls.createPr[0].body).toContain('## Test')
    expect(calls.createPr[0].body).toContain('## Rischi')
    expect(calls.linkTicket).toEqual([{ticket: 'CYAU-24', prUrl: 'https://github.com/acme/widget/pull/7'}])

    expect(res.pushed).toBe(true)
    expect(res.prCreated).toBe(true)
    expect(res.prUrl).toBe('https://github.com/acme/widget/pull/7')
    expect(res.linked).toBe(true)
    expect(res.cyiStatus).toBe('in_review')
    expect(res.autoMerged).toBe(false)
  })

  it('NEVER runs an automatic merge (the probe exposes no merge)', () => {
    const {probe} = fakeProbe(null)
    const res = runDelivery(runInput(), probe)
    expect(res.autoMerged).toBe(false)
    expect('merge' in probe).toBe(false)
  })

  // CYAU-174 — before there were three hands on the same lever: here, the agent host and the server. Now only
  // the server moves the state when it records the delivery, so the probe does not even have the verb to move it.
  it('does not move the ticket state: the probe exposes no transition', () => {
    const {probe} = fakeProbe(null)
    const res = runDelivery(runInput(), probe)
    expect('setCyiStatus' in probe).toBe(false)
    // `cyiStatus` in the result stays: it says which state the server must apply, not which one was applied.
    expect(res.cyiStatus).toBe('in_review')
  })
})

describe('runDelivery — idempotence (the idempotent-safe actions are always re-run)', () => {
  it('PR already open → reuses the URL, does not recreate it but reconfirms link and state (never a missing link/state on retry)', () => {
    const {probe, calls} = fakeProbe('https://github.com/acme/widget/pull/3')
    const res = runDelivery(runInput(), probe)

    expect(calls.createPr).toHaveLength(0)
    // Link (re)run also on the reused PR: a previous partial failure would otherwise be
    // unrecoverable (the link would stay missing forever).
    expect(calls.linkTicket).toEqual([{ticket: 'CYAU-24', prUrl: 'https://github.com/acme/widget/pull/3'}])
    expect(res.prCreated).toBe(false)
    expect(res.linked).toBe(true)
    expect(res.prUrl).toBe('https://github.com/acme/widget/pull/3')
  })

  it('PR comment already present → does not duplicate it and checkpoints link/state', () => {
    const {probe, calls} = fakeProbe('https://github.com/acme/widget/pull/3')
    probe.ticketLinkExists = () => true
    const progress: unknown[] = []
    const res = runDelivery(runInput({onProgress: (value: unknown) => progress.push(value)}), probe)
    expect(calls.linkTicket).toHaveLength(0)
    expect(res.linked).toBe(true)
    expect(progress.at(-1)).toMatchObject({linked: true})
  })

  it('checkpoint already complete → repeats no effect nor remote discovery', () => {
    const {probe, calls} = fakeProbe(null)
    const res = runDelivery(runInput({progress: {
      pushed: true, prUrl: 'https://github.com/acme/widget/pull/3', prCreated: true, linked: true, cyiStatusSet: true,
    }}), probe)
    expect(calls).toEqual({push: [], findPr: [], createPr: [], linkTicket: []})
    expect(res.prCreated).toBe(true)
  })
})

describe('runDelivery — safe-by-default guards (do not deliver)', () => {
  it('non-green gates → pushes nothing and throws C409-DELIVER-002', () => {
    const {probe, calls} = fakeProbe(null)
    const err = (() => {
      try {
        runDelivery(runInput({gatePassed: false}), probe)
      } catch (e) {
        return e as AutomatorError
      }
    })()
    expect(err?.code).toBe(ErrorCodes.Deliver.gateNotPassed)
    expect(calls.push).toHaveLength(0)
    expect(calls.createPr).toHaveLength(0)
  })

  it('non-deliverable branch → pushes nothing and throws C400-DELIVER-001', () => {
    const {probe, calls} = fakeProbe(null)
    const err = (() => {
      try {
        runDelivery(runInput({branch: 'main'}), probe)
      } catch (e) {
        return e as AutomatorError
      }
    })()
    expect(err?.code).toBe(ErrorCodes.Deliver.invalidBranch)
    expect(calls.push).toHaveLength(0)
  })

  it('unsafe ticket → pushes nothing and throws C400-DELIVER-004', () => {
    const {probe, calls} = fakeProbe(null)
    const err = (() => {
      try {
        runDelivery(runInput({content: {ticket: 'a/b', summary: 's', tests: null, risks: []}}), probe)
      } catch (e) {
        return e as AutomatorError
      }
    })()
    expect(err?.code).toBe(ErrorCodes.Deliver.invalidInput)
    expect(calls.push).toHaveLength(0)
  })
})

// --- Real probe behind an injectable CommandRunner: verifies the exact argv without real processes. ---
interface Invocation {
  cmd: string
  args: string[]
  cwd?: string
}

function recordingRunner(responses: Record<string, {status: number; stdout?: string; stderr?: string}> = {}): {
  run: (cmd: string, args: string[], cwd?: string) => {status: number | null; stdout: string; stderr: string}
  invocations: Invocation[]
} {
  const invocations: Invocation[] = []
  return {
    invocations,
    run: (cmd, args, cwd) => {
      invocations.push({cmd, args, cwd})
      const key = cmd === 'gh' ? `gh ${args[0]} ${args[1] ?? ''}`.trim() : cmd === 'cyi' ? `cyi ${args[1]}` : cmd
      const r = responses[key] ?? {status: 0}
      return {status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? ''}
    },
  }
}

describe('defaultDeliveryProbe — real argv (non-interactive git/gh/cyi, never --force)', () => {
  const opts = (run: ReturnType<typeof recordingRunner>['run']) => ({project: 'CYAU', run})

  it('push: git push --set-upstream <remote> <branch>, without --force', () => {
    const r = recordingRunner()
    defaultDeliveryProbe(opts(r.run)).push({cwd: '/wt', branch: 'ticket/CYAU-24', remote: 'origin'})
    expect(r.invocations[0]).toEqual({cmd: 'git', args: ['-C', '/wt', 'push', '--set-upstream', 'origin', 'ticket/CYAU-24'], cwd: undefined})
    expect(r.invocations[0].args.some((a) => a.startsWith('--force'))).toBe(false)
  })

  it('findPr: gh pr list filtered on --head AND --base → the found URL, or null if empty', () => {
    const found = recordingRunner({'gh pr list': {status: 0, stdout: 'https://github.com/acme/widget/pull/9\n'}})
    expect(defaultDeliveryProbe(opts(found.run)).findPr({cwd: '/wt', branch: 'ticket/CYAU-24', base: 'main'})).toBe(
      'https://github.com/acme/widget/pull/9',
    )
    // The search is bound to the same base that would be opened → never reuse a PR towards another base.
    expect(found.invocations[0].args).toContain('--base')
    expect(found.invocations[0].args).toContain('main')
    const empty = recordingRunner({'gh pr list': {status: 0, stdout: '\n'}})
    expect(defaultDeliveryProbe(opts(empty.run)).findPr({cwd: '/wt', branch: 'ticket/CYAU-24', base: 'main'})).toBeNull()
  })

  it('createPr: non-interactive gh pr create (--base/--head/--title/--body) → URL on stdout', () => {
    const r = recordingRunner({'gh pr create': {status: 0, stdout: 'https://github.com/acme/widget/pull/10\n'}})
    const url = defaultDeliveryProbe(opts(r.run)).createPr({cwd: '/wt', branch: 'ticket/CYAU-24', base: 'main', title: 'T', body: 'B'})
    expect(url).toBe('https://github.com/acme/widget/pull/10')
    const create = r.invocations.find((i) => i.cmd === 'gh')!
    expect(create.args).toEqual(['pr', 'create', '--base', 'main', '--head', 'ticket/CYAU-24', '--title', 'T', '--body', 'B'])
    expect(create.cwd).toBe('/wt')
  })

  it('linkTicket: cyi tickets comment with the PR URL (ticket → PR link)', () => {
    const r = recordingRunner()
    defaultDeliveryProbe(opts(r.run)).linkTicket({ticket: 'CYAU-24', prUrl: 'https://github.com/acme/widget/pull/11'})
    const call = r.invocations[0]
    expect(call.cmd).toBe('cyi')
    expect(call.args.slice(0, 5)).toEqual(['tickets', 'comment', 'CYAU-24', '-p', 'CYAU'])
    expect(call.args.join(' ')).toContain('https://github.com/acme/widget/pull/11')
  })

  // CYAU-174 — the probe no longer has the verb to move the state: the server moves it when it records the
  // delivery. The field must be looked up on the real object, not on the type: TypeScript does not run when the service runs.
  it('the real probe exposes no state transition', () => {
    const r = recordingRunner()
    expect('setCyiStatus' in defaultDeliveryProbe(opts(r.run))).toBe(false)
    expect('setCyiStatus' in defaultOperationalDeliveryProbe('CYAU', r.run)).toBe(false)
  })

  // The second defect of the ticket: the old probe read the list of states and required ONE single review
  // state, so on an organization that had two or zero it died BEFORE pushing — session already paid,
  // code never reaching GitHub. Now the first command is the push, and there is no read that can fail.
  it('the first command of the lazy probe is the push: no state read can precede it anymore', () => {
    const r = recordingRunner()
    const probe = defaultOperationalDeliveryProbe('CYAU', r.run)
    expect(r.invocations).toHaveLength(0)
    probe.push({cwd: '/wt', branch: 'ticket/CYAU-24', remote: 'origin'})
    expect(r.invocations).toHaveLength(1)
    expect(r.invocations[0]).toMatchObject({cmd: 'git'})
    expect(r.invocations.some((i) => i.args.includes('statuses'))).toBe(false)
  })

  it('a failed command → C502-DELIVER-003 (exit 1)', () => {
    const r = recordingRunner({'gh pr create': {status: 1, stderr: 'boom'}})
    const err = (() => {
      try {
        defaultDeliveryProbe(opts(r.run)).createPr({cwd: '/wt', branch: 'ticket/CYAU-24', base: 'main', title: 'T', body: 'B'})
      } catch (e) {
        return e as AutomatorError
      }
    })()
    expect(err?.code).toBe(ErrorCodes.Deliver.commandFailed)
    expect(err?.exitCode).toBe(1)
  })

  it('failed findPr is an authoritative error, not a missing PR', () => {
    const r = recordingRunner({'gh pr list': {status: 1, stderr: 'offline'}})
    expect(() => defaultDeliveryProbe(opts(r.run)).findPr({cwd: '/wt', branch: 'ticket/CYAU-24', base: 'main'}))
      .toThrow(/gh pr list fallito/i)
  })

  it('ticketLinkExists reads the comments, handles foreign records and fails closed on JSON/outage', () => {
    const found = recordingRunner({'cyi comments': {status: 0, stdout: JSON.stringify({data: [null, {}, {body: 'PR https://x/pull/1'}]})}})
    expect(defaultDeliveryProbe(opts(found.run)).ticketLinkExists?.({ticket: 'CYAU-24', prUrl: 'https://x/pull/1'})).toBe(true)
    const invalidShape = recordingRunner({'cyi comments': {status: 0, stdout: JSON.stringify({data: {body: 'x'}})}})
    expect(() => defaultDeliveryProbe(opts(invalidShape.run)).ticketLinkExists?.({ticket: 'CYAU-24', prUrl: 'https://x'}))
      .toThrow(/risposta JSON non valida/i)
    const malformed = recordingRunner({'cyi comments': {status: 0, stdout: '{'}})
    expect(() => defaultDeliveryProbe(opts(malformed.run)).ticketLinkExists?.({ticket: 'CYAU-24', prUrl: 'https://x'}))
      .toThrow(/risposta JSON non valida/i)
    const outage = recordingRunner({'cyi comments': {status: 1, stderr: 'offline'}})
    expect(() => defaultDeliveryProbe(opts(outage.run)).ticketLinkExists?.({ticket: 'CYAU-24', prUrl: 'https://x'}))
      .toThrow(/comments fallito/i)
  })

  it('tells explicit outages apart from protocol, auth/policy and permanent push rejected', () => {
    for (const detail of [
      'connect ETIMEDOUT', 'getaddrinfo ENOTFOUND api.github.com', 'write EPIPE', 'socket hang up',
      'socket closed after commit', 'error connecting to api.github.com', 'rate limit exceeded',
    ]) {
      const r = recordingRunner({git: {status: null as unknown as number, stderr: detail}})
      expect(() => defaultDeliveryProbe(opts(r.run)).push({cwd: '/wt', branch: 'ticket/CYAU-24', remote: 'origin'}), detail)
        .toThrow(RetryableDeliveryError)
    }
    const malformato = recordingRunner({'cyi comments': {status: 0, stdout: '{'}})
    expect(() => defaultDeliveryProbe(opts(malformato.run)).ticketLinkExists?.({ticket: 'CYAU-24', prUrl: 'https://x'}))
      .not.toThrow(RetryableDeliveryError)

    const rejected = recordingRunner({git: {status: 1, stderr: 'rejected non-fast-forward'}})
    expect(() => defaultDeliveryProbe(opts(rejected.run)).push({cwd: '/wt', branch: 'ticket/CYAU-24', remote: 'origin'}))
      .not.toThrow(RetryableDeliveryError)
    const outage = recordingRunner({'gh pr list': {status: 1, stderr: 'HTTP 503 temporarily unavailable'}})
    expect(() => defaultDeliveryProbe(opts(outage.run)).findPr({cwd: '/wt', branch: 'ticket/CYAU-24', base: 'main'}))
      .toThrow(RetryableDeliveryError)
  })

  it('rejects non-HTTPS/non-canonical PR output before checkpoint or link', () => {
    const malformed = recordingRunner({'gh pr create': {status: 0, stdout: 'warning: created'}})
    expect(() => defaultDeliveryProbe(opts(malformed.run)).createPr({
      cwd: '/wt', branch: 'ticket/CYAU-24', base: 'main', title: 'T', body: 'B',
    })).toThrow(/URL PR GitHub non valido/i)
    const {probe} = fakeProbe('not-a-url')
    expect(() => runDelivery(runInput(), probe)).toThrow(/URL PR GitHub non valido/i)
  })

  it('createPr returning no URL on stdout → C502-DELIVER-003 (never a "ghost" PR)', () => {
    const r = recordingRunner({'gh pr create': {status: 0, stdout: '   \n'}})
    const err = (() => {
      try {
        defaultDeliveryProbe(opts(r.run)).createPr({cwd: '/wt', branch: 'ticket/CYAU-24', base: 'main', title: 'T', body: 'B'})
      } catch (e) {
        return e as AutomatorError
      }
    })()
    expect(err?.code).toBe(ErrorCodes.Deliver.commandFailed)
  })
})

describe('defaultDeliveryProbe — real runner (spawnSync)', () => {
  it('a failed git command (non-git dir) → C502-DELIVER-003, with diagnostic detail', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-deliver-probe-'))
    try {
      // No injected `run` → real runner. `git push` in a NON-git directory fails (status ≠ 0).
      const err = (() => {
        try {
          defaultDeliveryProbe({project: 'CYAU'}).push({cwd: dir, branch: 'ticket/CYAU-24', remote: 'origin'})
        } catch (e) {
          return e as AutomatorError
        }
      })()
      expect(err?.code).toBe(ErrorCodes.Deliver.commandFailed)
      expect(err?.exitCode).toBe(1)
      expect(err?.message).toContain('git push fallito')
    } finally {
      fs.rmSync(dir, {recursive: true, force: true})
    }
  })
})
