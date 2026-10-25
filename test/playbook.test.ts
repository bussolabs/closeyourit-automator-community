import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterAll, describe, expect, it} from 'vitest'
import {loadPlaybook, validatePlaybook} from '../src/lib/playbook'
import {AutomatorError} from '../src/errors/error-codes'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-pb-'))
let counter = 0

function write(yaml: string): string {
  const file = path.join(dir, `pb-${counter++}.yml`)
  fs.writeFileSync(file, yaml)
  return file
}

afterAll(() => fs.rmSync(dir, {recursive: true, force: true}))

describe('validatePlaybook — casi validi', () => {
  it('validates a minimal playbook and applies the defaults (enabled=true, catch_up=false)', () => {
    const result = validatePlaybook(write('version: 1\nactions:\n  a:\n    schedule: "every 1m"\n    type: shell\n    run: "echo x"\n'))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.playbook.actions.a.enabled).toBe(true)
      expect(result.playbook.actions.a.catch_up).toBe(false)
    }
  })

  it('validates a codex action with sandbox and model', () => {
    const result = validatePlaybook(
      write('version: 1\nactions:\n  a:\n    schedule: "every 1m"\n    type: codex\n    run: "analizza"\n    sandbox: workspace-write\n    model: gpt-5-codex\n'),
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      const a = result.playbook.actions.a
      expect(a.type).toBe('codex')
      if (a.type === 'codex') {
        expect(a.sandbox).toBe('workspace-write')
        expect(a.model).toBe('gpt-5-codex')
      }
    }
  })

  it('codex action without sandbox → read-only default (confinement always explicit)', () => {
    const result = validatePlaybook(
      write('version: 1\nactions:\n  a:\n    schedule: "every 1m"\n    type: codex\n    run: "analizza"\n'),
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      const a = result.playbook.actions.a
      if (a.type === 'codex') expect(a.sandbox).toBe('read-only')
    }
  })

  it('uses process-group as compatible containment and accepts explicit strong', () => {
    const compatible = validatePlaybook(write('version: 1\nactions:\n  a:\n    schedule: "every 1m"\n    type: shell\n    run: "echo x"\n'))
    expect(compatible.ok).toBe(true)
    if (compatible.ok) expect(compatible.playbook.actions.a.containment).toBe('process-group')

    const strong = validatePlaybook(write('version: 1\nactions:\n  a:\n    schedule: "every 1m"\n    type: shell\n    run: "echo x"\n    containment: strong\n'))
    expect(strong.ok).toBe(true)
    if (strong.ok) expect(strong.playbook.actions.a.containment).toBe('strong')
  })

  it('applies the defaults, with the action winning on merge', () => {
    const file = write(
      'version: 1\ndefaults:\n  cwd: /base\n  timeout: 100\n  containment: strong\nactions:\n  a:\n    schedule: "every 1m"\n    type: shell\n    run: "echo x"\n    timeout: 5\n',
    )
    const result = validatePlaybook(file)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.playbook.actions.a.cwd).toBe('/base') // from the default
      expect(result.playbook.actions.a.timeout).toBe(5) // override dell’azione
      expect(result.playbook.actions.a.containment).toBe('strong')
    }
  })

  it('a valid ticket-scoped action keeps the target and requires a cwd', () => {
    const result = validatePlaybook(write(
      'version: 1\nactions:\n  a:\n    schedule: "every 1m"\n    type: codex\n    run: "Implementa"\n    cwd: /repo\n    containment: strong\n    ticket:\n      project: CYAU\n      code: CYAU-34\n      repository: closeyourit/closeyourit-automator\n      estimated_cost: 0.5\n',
    ))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.playbook.actions.a.ticket).toMatchObject({project: 'CYAU', code: 'CYAU-34'})
  })
})

describe('validatePlaybook — casi invalidi', () => {
  const bad: Array<[string, string]> = [
    ['missing schedule', 'version: 1\nactions:\n  a:\n    type: shell\n    run: "x"\n'],
    ['missing run', 'version: 1\nactions:\n  a:\n    schedule: "every 1m"\n    type: shell\n'],
    ['missing type', 'version: 1\nactions:\n  a:\n    schedule: "every 1m"\n    run: "x"\n'],
    ['empty run', 'version: 1\nactions:\n  a:\n    schedule: "every 1m"\n    type: shell\n    run: ""\n'],
    ['unknown containment','version: 1\nactions:\n  a:\n    schedule: "every 1m"\n    type: shell\n    run: "x"\n    containment: best-effort\n'],
    ['empty actions', 'version: 1\nactions: {}\n'],
    ['non-word action name','version: 1\nactions:\n  my-action:\n    schedule: "every 1m"\n    type: shell\n    run: "x"\n'],
    [
      'permission_mode on a shell action',
      'version: 1\nactions:\n  a:\n    schedule: "every 1m"\n    type: shell\n    run: "x"\n    permission_mode: plan\n',
    ],
    [
      'sandbox danger-full-access on codex (mode not exposed: sandbox mandatory)',
      'version: 1\nactions:\n  a:\n    schedule: "every 1m"\n    type: codex\n    run: "x"\n    sandbox: danger-full-access\n',
    ],
    [
      'invalid sandbox on codex',
      'version: 1\nactions:\n  a:\n    schedule: "every 1m"\n    type: codex\n    run: "x"\n    sandbox: yolo\n',
    ],
    [
      'permission_mode (claude field) on a codex action',
      'version: 1\nactions:\n  a:\n    schedule: "every 1m"\n    type: codex\n    run: "x"\n    permission_mode: bypassPermissions\n',
    ],
    [
      'Claude token put in env.vars instead of provided by the runtime capability',
      'version: 1\nactions:\n  a:\n    schedule: "every 1m"\n    type: claude\n    run: "x"\n    env:\n      vars:\n        CLAUDE_CODE_OAUTH_TOKEN: embedded\n',
    ],
    ['wrong version','version: 2\nactions:\n  a:\n    schedule: "every 1m"\n    type: shell\n    run: "x"\n'],
    [
      'ticket action without cwd',
      'version: 1\nactions:\n  a:\n    schedule: "every 1m"\n    type: codex\n    run: "x"\n    ticket:\n      project: CYAU\n      code: CYAU-34\n',
    ],
    [
      'ticket action with shell runtime (cannot receive the Guidance)',
      'version: 1\nactions:\n  a:\n    schedule: "every 1m"\n    type: shell\n    run: "x"\n    cwd: /repo\n    ticket:\n      project: CYAU\n      code: CYAU-34\n',
    ],
    [
      'ticket action without strong containment',
      'version: 1\nactions:\n  a:\n    schedule: "every 1m"\n    type: codex\n    run: "x"\n    cwd: /repo\n    containment: process-group\n    ticket:\n      project: CYAU\n      code: CYAU-34\n      repository: closeyourit/closeyourit-automator\n',
    ],
    [
      'skill without strong containment',
      'version: 1\nactions:\n  a:\n    schedule: "every 1m"\n    type: claude\n    run: "x"\n    cwd: /repo\n    containment: process-group\n    skill:\n      command: /closeyourit:implementa\n      args: CYAU-34\n      plugin_dir: /plugin\n',
    ],
  ]

  for (const [label, yaml] of bad) {
    it(`rejects: ${label}`, () => {
      const result = validatePlaybook(write(yaml))
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.issues.length).toBeGreaterThan(0)
    })
  }

  it('rejects the retired provider token in env.vars, even with alternate case', () => {
    const tokenName = ['DOP', 'PLER_TOKEN'].join('')
    for (const name of [tokenName, tokenName.toLowerCase()]) {
      const yaml = `version: 1\nactions:\n  a:\n    schedule: "every 1m"\n    type: shell\n    run: "x"\n    env:\n      vars:\n        ${name}: embedded\n`
      expect(validatePlaybook(write(yaml)).ok).toBe(false)
    }
  })

  it('file inesistente → notFound', () => {
    const result = validatePlaybook(path.join(dir, 'non-esiste.yml'))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('C404-PLAYBOOK-001')
  })

  it('YAML malformato → parse error', () => {
    const result = validatePlaybook(write('version: 1\nactions: : : :\n'))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('C422-PLAYBOOK-002')
  })

  it('non-object document (just a string) → invalid without crash', () => {
    expect(validatePlaybook(write('solo una stringa\n')).ok).toBe(false)
  })

  it('non-object actions → invalid without crash', () => {
    expect(validatePlaybook(write('version: 1\nactions: "nope"\n')).ok).toBe(false)
  })
})

describe('validatePlaybook — merge defaults resiliente', () => {
  it('non-object defaults are ignored', () => {
    const result = validatePlaybook(
      write('version: 1\ndefaults: "ignorami"\nactions:\n  a:\n    schedule: "every 1m"\n    type: shell\n    run: "x"\n'),
    )
    expect(result.ok).toBe(true)
  })
})

describe("action working on a ticket", () => {
  // Two conditions the playbook must declare by itself, because the preflight cannot guess them:
  // where the checkout is, and that the engine can read the Guidance. A `shell` does not receive it.
  const conTicket = (extra: string) =>
    `version: 1\nactions:\n  a:\n    schedule: "every 1m"\n    containment: strong\n${extra}    ticket:\n      project: CYAU\n      code: CYAU-1\n      repository: bussolabs/closeyourit-automator\n`

  it('without cwd the playbook is rejected, and says which field is missing', () => {
    const esito = validatePlaybook(write(conTicket('    type: claude\n    run: "Lavora"\n')))
    expect(esito.ok).toBe(false)
    expect(JSON.stringify(esito)).toContain('cwd')
  })

  it('with an engine that does not receive the Guidance it is rejected', () => {
    const esito = validatePlaybook(write(conTicket('    type: shell\n    run: "echo"\n    cwd: "/repo"\n')))
    expect(esito.ok).toBe(false)
    expect(JSON.stringify(esito)).toContain('runtime agente')
  })

  it('with cwd and an agent engine it passes', () => {
    const esito = validatePlaybook(write(conTicket('    type: claude\n    run: "Lavora"\n    cwd: "/repo"\n')))
    expect(esito.ok).toBe(true)
  })

  // CYAU-71 — `approved` said "I authorized this high-risk ticket myself": it granted the local risk
  // gate. That gate no longer exists, and a field promising a defence that is not there is
  // worse than a missing field. Whoever still carries it is told so, instead of believing it active.
  it('rejects the old consent to the risk gate, which no longer grants anything', () => {
    const esito = validatePlaybook(write(
      'version: 1\nactions:\n  a:\n    schedule: "every 1m"\n    type: claude\n    run: "Lavora"\n    cwd: "/repo"\n' +
      '    ticket:\n      project: CYAU\n      code: CYAU-1\n      repository: bussolabs/closeyourit-automator\n      approved: true\n',
    ))

    expect(esito.ok).toBe(false)
    expect(JSON.stringify(esito)).toContain('approved')
  })
})

describe('loadPlaybook', () => {
  it('returns the valid playbook', () => {
    const file = write('version: 1\nactions:\n  a:\n    schedule: "every 1m"\n    type: shell\n    run: "echo x"\n')
    expect(Object.keys(loadPlaybook(file).actions)).toEqual(['a'])
  })

  it('throws AutomatorError with exit 2 on an invalid playbook', () => {
    const file = write('version: 1\nactions: {}\n')
    expect(() => loadPlaybook(file)).toThrow(AutomatorError)
    try {
      loadPlaybook(file)
    } catch (error) {
      expect((error as AutomatorError).exitCode).toBe(2)
    }
  })
})
