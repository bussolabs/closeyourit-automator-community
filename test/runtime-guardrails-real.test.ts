import {spawnSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'

const ROOT = path.resolve(__dirname, '..')
const HOOKS = path.join(ROOT, 'assets', 'guardrails', 'hooks')
const CODEX_RULES = path.join(ROOT, 'assets', 'guardrails', 'codex', 'automator.rules')

function claudeHook(name: string, command: string, extraArgs: string[] = []): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [path.join(HOOKS, name), ...extraArgs], {
    encoding: 'utf8',
    input: JSON.stringify({tool_name: 'Bash', tool_input: {command}}),
  })
}

function claudeHookRaw(name: string, input: string): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [path.join(HOOKS, name)], {encoding: 'utf8', input})
}

describe('real Claude guardrail · PreToolUse contract', () => {
  const cases = [
    ['deploy', 'block-production.mjs', 'kamal deploy'],
    ['destructive DB', 'block-destructive-db.mjs', 'bin/rails db:drop'],
    ['protected branch', 'guard-branch-push.mjs', 'git push origin main'],
    ['force push', 'guard-branch-push.mjs', 'git push --force origin ticket/CYAU-55'],
    ['indirect exec via bash', 'block-indirect-exec.mjs', 'bash ./deploy.sh'],
    ['indirect exec via file', 'block-indirect-exec.mjs', './deploy.sh'],
    ['indirect exec via make', 'block-indirect-exec.mjs', 'make deploy'],
    ['indirect exec via npm', 'block-indirect-exec.mjs', 'npm run deploy'],
    ['token in a ticket comment', 'block-secret-leak.mjs', `cyi tickets comment CYAU-1 -p CYAU --body "ghp_${'a'.repeat(36)}"`],
  ] as const

  it.each(cases)('%s is blocked before execution with exit 2', (_label, hook, command) => {
    const result = claudeHook(hook, command)
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('guardrail')
  })

  it.each(['{', '{}', JSON.stringify({tool_name: 'Bash', tool_input: {}})])(
    'malformed or incomplete payload is fail-closed: %s',
    (input) => {
      for (const hook of ['block-production.mjs', 'block-destructive-db.mjs', 'guard-branch-push.mjs', 'block-indirect-exec.mjs', 'block-secret-leak.mjs']) {
        expect(claudeHookRaw(hook, input).status).toBe(2)
      }
    },
  )

  describe('block-indirect-exec · exemption of the pinned skill bundle', () => {
    const tempDirs: string[] = []
    afterEach(() => {
      for (const dir of tempDirs.splice(0)) fs.rmSync(dir, {recursive: true, force: true})
    })

    it('runs the bundle entrypoint and blocks a script outside the bundle', () => {
      const pluginDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'automator-plugin-real-')))
      tempDirs.push(pluginDir)
      fs.mkdirSync(path.join(pluginDir, 'scripts'), {recursive: true})
      const entry = path.join(pluginDir, 'scripts', 'gate.mjs')
      fs.writeFileSync(entry, 'export const main = () => {}\n')

      expect(claudeHook('block-indirect-exec.mjs', `node ${entry} CYAU-115`, ['--plugin-dir', pluginDir]).status).toBe(0)
      expect(claudeHook('block-indirect-exec.mjs', 'node /tmp/outside.mjs', ['--plugin-dir', pluginDir]).status).toBe(2)
    })
  })

  it('an Edit payload without path is fail-closed in the worktree guard', () => {
    expect(claudeHookRaw('require-worktree.mjs', JSON.stringify({tool_name: 'Write', tool_input: {}})).status).toBe(2)
  })

  it.each([
    ["g''it push origin main", 'guard-branch-push.mjs'],
    ["ka''mal deploy", 'block-production.mjs'],
    ["bin/rails db:dro''p", 'block-destructive-db.mjs'],
    ["echo ticket/foo; git push origin m''ain", 'guard-branch-push.mjs'],
  ])('blocks the adversarial shell form %s', (command, hook) => {
    expect(claudeHook(hook, command).status).toBe(2)
  })

  it.each([
    "FOO='a b' bash ./deploy.sh",
    'true & ./deploy.sh',
    '(bash x.sh)',
    'echo "$(./deploy.sh)"',
    'timeout 60 bash x.sh',
  ])('block-indirect-exec blocks the advanced indirect form %s with exit 2', (command) => {
    expect(claudeHook('block-indirect-exec.mjs', command).status).toBe(2)
  })
})

const codexAvailable = spawnSync('codex', ['--version'], {encoding: 'utf8'}).status === 0

describe.runIf(codexAvailable)('real Codex guardrail · codex execpolicy check', () => {
  const cases = [
    ['deploy', ['kamal', 'deploy']],
    ['destructive DB', ['bin/rails', 'db:drop']],
    ['protected branch', ['git', 'push', 'origin', 'main']],
    ['force push', ['git', 'push', '--force', 'origin', 'ticket/CYAU-55']],
    ['git with config', ['git', '-c', 'protocol.version=2', 'push', 'origin', 'main']],
    ['absolute git', ['/usr/bin/git', 'push', 'origin', 'main']],
    ['git via env', ['env', 'git', 'push', 'origin', 'main']],
    ['git via shell', ['sh', '-c', 'git push origin main']],
    ['DB via mise', ['mise', 'exec', '--', 'bin/rails', 'db:drop']],
    ['DB via shell', ['bash', '-lc', 'sqlite3 app.db "DROP TABLE users"']],
    ['ticket status', ['cyi', 'tickets', 'status', 'CYAU-1', '-p', 'CYAU', '--status-id', '7857bea5']],
    ['ticket update', ['cyi', 'tickets', 'update', 'CYAU-1', '-p', 'CYAU']],
    ['ticket approval', ['closeyourit', 'tickets', 'approve', 'CYAU-1', '-p', 'CYAU']],
  ] as const

  it.each(cases)('%s is forbidden by the official policy', (_label, command) => {
    const result = spawnSync('codex', ['execpolicy', 'check', '--rules', CODEX_RULES, '--', ...command], {encoding: 'utf8'})
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({decision: 'forbidden'})
  })

  // CYAU-174 — the boundary is one character: without these lines a rule that also denied `statuses`
  // would pass the cases above and take away from the agent the read it needs.
  const allowed = [
    ['status list', ['cyi', 'tickets', 'statuses', '-p', 'CYAU']],
    ['ticket read', ['cyi', 'tickets', 'show', 'CYAU-1', '-p', 'CYAU']],
    ['ticket list', ['cyi', 'tickets', 'list', '-p', 'CYAU']],
    ['comment', ['cyi', 'tickets', 'comment', 'CYAU-1', '-p', 'CYAU', '-m', 'fatto']],
  ] as const

  it.each(allowed)('%s is not forbidden: the agent keeps reading and commenting', (_label, command) => {
    const result = spawnSync('codex', ['execpolicy', 'check', '--rules', CODEX_RULES, '--', ...command], {encoding: 'utf8'})
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout).decision).not.toBe('forbidden')
  })
})
