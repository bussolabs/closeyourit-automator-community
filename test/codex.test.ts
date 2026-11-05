import {describe, expect, it} from 'vitest'
import {buildCodexArgv, CODEX_BIN, readCodexEvent} from '../src/lib/codex'
import {composeRetryRun} from '../src/lib/claude'
import {CONVERSATION_RESUME_PROMPT} from '../src/lib/agent-conversation'
import {type CodexActionT, PlaybookSchema} from '../src/lib/schema'

/** Builds a typed codex Action with the defaults applied (via zod). */
function codexAction(partial: Record<string, unknown>): CodexActionT {
  const parsed = PlaybookSchema.parse({version: 1, actions: {a: {schedule: 'every 1m', type: 'codex', ...partial}}}).actions.a
  if (parsed.type !== 'codex') throw new Error('atteso codex')
  return parsed
}

describe('buildCodexArgv', () => {
  it('minimal → non-interactive policy, user config ignored, authoritative sandbox and network', () => {
    expect(buildCodexArgv(codexAction({run: 'analizza il repo'}))).toEqual([
      '--ask-for-approval',
      'never',
      '--dangerously-bypass-hook-trust',
      'exec',
      '--ignore-user-config',
      '--sandbox',
      'read-only',
      '-c',
      'sandbox_workspace_write.network_access=false',
      '-c', 'features.hooks=true',
      '-c', 'hooks.PreToolUse=[{matcher="^(Bash|Shell|shell|shell_command|exec_command)$", hooks=[{type="command", command="/bin/sh -c \'exit 2\'", timeout=5}]}]',
      '-c', 'shell_environment_policy.inherit="none"',
      '--model',
      'gpt-6-astra',
      '--',
      'analizza il repo',
    ])
  })

  it('includes --sandbox and --model when present', () => {
    expect(buildCodexArgv(codexAction({run: 'sistema i test', sandbox: 'workspace-write', model: 'gpt-5-codex'}))).toEqual([
      '--ask-for-approval',
      'never',
      '--dangerously-bypass-hook-trust',
      'exec',
      '--ignore-user-config',
      '--sandbox',
      'workspace-write',
      '-c',
      'sandbox_workspace_write.network_access=false',
      '-c', 'features.hooks=true',
      '-c', 'hooks.PreToolUse=[{matcher="^(Bash|Shell|shell|shell_command|exec_command)$", hooks=[{type="command", command="/bin/sh -c \'exit 2\'", timeout=5}]}]',
      '-c', 'shell_environment_policy.inherit="none"',
      '--model',
      'gpt-5-codex',
      '--',
      'sistema i test',
    ])
  })

  it('without model → uses the pinned Codex model', () => {
    const args = buildCodexArgv(codexAction({run: 'x'}))
    expect(args.at(args.indexOf('--model') + 1)).toBe('gpt-6-astra')
  })

  it('sandbox ALWAYS present with the read-only default even without explicit configuration (authoritative on confinement)', () => {
    const args = buildCodexArgv(codexAction({run: 'x'}))
    expect(args).toContain('read-only')
    expect(args).not.toContain('danger-full-access')
  })

  // Review CYAU-25: `workspace-write` confines the FILESYSTEM but the network is a separate axis (network_access,
  // disabled by default but OVERRIDABLE in the local config). The automator forces no-network so it stays
  // authoritative on confinement (mirror of the "--sandbox always explicit" philosophy): without it, a Codex agent
  // could git push/deploy to the network during its turn, bypassing the command policy.
  it('workspace-write → forces network_access=false (authoritative network confinement, not only filesystem)', () => {
    expect(buildCodexArgv(codexAction({run: 'x', sandbox: 'workspace-write'}))).toEqual([
      '--ask-for-approval',
      'never',
      '--dangerously-bypass-hook-trust',
      'exec',
      '--ignore-user-config',
      '--sandbox',
      'workspace-write',
      '-c',
      'sandbox_workspace_write.network_access=false',
      '-c', 'features.hooks=true',
      '-c', 'hooks.PreToolUse=[{matcher="^(Bash|Shell|shell|shell_command|exec_command)$", hooks=[{type="command", command="/bin/sh -c \'exit 2\'", timeout=5}]}]',
      '-c', 'shell_environment_policy.inherit="none"',
      '--model',
      'gpt-6-astra',
      '--',
      'x',
    ])
  })

  it('denies Bash with an authoritative CLI hook and a non-inherited shell environment', () => {
    const args = buildCodexArgv(codexAction({run: 'usa node, ruby, mise o sh'}))
    expect(args).toContain('--dangerously-bypass-hook-trust')
    expect(args).toContain('features.hooks=true')
    expect(args.some((arg) => arg.includes('shell_command|exec_command') && arg.includes("/bin/sh -c 'exit 2'"))).toBe(true)
    expect(args).toContain('shell_environment_policy.inherit="none"')
  })

  it('read-only → still forces network_access=false and ignores the user config', () => {
    const args = buildCodexArgv(codexAction({run: 'x'}))
    expect(args).toContain('--ignore-user-config')
    expect(args).toContain('sandbox_workspace_write.network_access=false')
  })

  it('the prompt is preceded by `--` (end of options): a run starting with `-` is not interpreted as a flag', () => {
    const args = buildCodexArgv(codexAction({run: '-c pericoloso=1'}))
    const sep = args.indexOf('--')
    expect(sep).toBeGreaterThan(-1)
    expect(args[sep + 1]).toBe('-c pericoloso=1')
    expect(args[args.length - 1]).toBe('-c pericoloso=1')
  })

  it('CODEX_BIN is the codex binary', () => {
    expect(CODEX_BIN).toBe('codex')
  })
})

// CYRA-921 — Codex runs the phase skills with the same guardrails as Claude: the hook commands come from the installed
// Claude settings, the network is limited to the same domains, writes to the session's workspace.
describe('buildCodexArgv in skill-mode', () => {
  const fs = require('node:fs') as typeof import('node:fs')
  const os = require('node:os') as typeof import('node:os')
  const path = require('node:path') as typeof import('node:path')

  function settingsFile(preToolUse: unknown): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-skill-settings-'))
    const file = path.join(dir, 'settings.json')
    fs.writeFileSync(file, JSON.stringify({hooks: {PreToolUse: preToolUse}}))
    return file
  }

  const guardrails = [
    {matcher: 'Bash', hooks: [{type: 'command', command: '"/usr/bin/node" "--eval" "x" "hash" "/h/block-production.mjs"'}]},
    {matcher: 'Edit|Write|MultiEdit|NotebookEdit', hooks: [{type: 'command', command: '"/usr/bin/node" "/h/require-worktree.mjs"'}]},
  ]
  const skill = {command: '/closeyourit-skills:autopilot', args: 'CYRA-7', plugin_dir: '/opt/skills/current'}

  it('invokes the skill by path with the ticket, under the hooks, the domain allowlist and a read-only workspace by default', () => {
    const argv = buildCodexArgv(codexAction({run: 'placeholder', skill}), settingsFile(guardrails))

    expect(argv.slice(0, 6)).toEqual(['--ask-for-approval', 'never', '--dangerously-bypass-hook-trust', 'exec', '--ignore-user-config', '--ignore-rules'])
    expect(argv).toContain('features.hooks=true')
    expect(argv).toContain('features.network_proxy=true')
    expect(argv).toContain('default_permissions="automator"')
    expect(argv).toContain('permissions.automator.filesystem={":root"="read", ":workspace_roots"="read", ' +
      '"/run/user"="none", "/run/dbus"="none", "/run/systemd"="none", "/var/run/docker.sock"="none", ' +
      '"/run/docker.sock"="none", "/var/lib/incus"="none", "/run/incus"="none"}')
    expect(argv).toContain('permissions.automator.network.enabled=true')
    // The local database is a Unix socket: Codex opens them only all together, with the escape sockets hidden above.
    expect(argv).toContain('permissions.automator.network.dangerously_allow_all_unix_sockets=true')
    expect(argv.find((a) => a.startsWith('permissions.automator.network.domains='))).toBe(
      'permissions.automator.network.domains={"closeyour.it"="allow", "*.closeyour.it"="allow", "github.com"="allow", ' +
      '"*.github.com"="allow", "*.githubusercontent.com"="allow", "registry.npmjs.org"="allow", "rubygems.org"="allow", "*.rubygems.org"="allow"}')
    expect(argv.find((a) => a.startsWith('hooks.PreToolUse='))).toBe(
      'hooks.PreToolUse=[{matcher="^Bash$", hooks=[{type="command", command="\\"/usr/bin/node\\" \\"--eval\\" \\"x\\" \\"hash\\" \\"/h/block-production.mjs\\"", timeout=60}]}, ' +
      '{matcher="^apply_patch$", hooks=[{type="command", command="\\"/usr/bin/node\\" \\"/h/require-worktree.mjs\\"", timeout=60}]}]')
    expect(argv).not.toContain('--sandbox')
    expect(argv.slice(-2)).toEqual(['--', 'Use $autopilot at /opt/skills/current/skills/autopilot/SKILL.md with this input: CYRA-7'])
  })

  it('a write phase may also write the Git data its ticket worktree commits to, and nothing else of the repository', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-skill-git-')))
    const repo = path.join(root, 'repo')
    const worktree = path.join(root, 'worktrees', 'CYRA-7')
    const git = (cwd: string, ...args: string[]) =>
      require('node:child_process').spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', ...args], {cwd})
    fs.mkdirSync(repo, {recursive: true})
    git(repo, 'init', '-q', '-b', 'main')
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n')
    git(repo, 'add', 'a.txt')
    git(repo, 'commit', '-qm', 'base')
    git(repo, 'worktree', 'add', '-q', '-b', 'ticket/CYRA-7', worktree)

    const argv = buildCodexArgv(codexAction({run: 'x', sandbox: 'workspace-write', skill}), settingsFile(guardrails), worktree)

    const common = path.join(repo, '.git')
    expect(argv).toContain(
      `permissions.automator.filesystem={":root"="read", ":workspace_roots"="write", ` +
      `${JSON.stringify(path.join(common, 'worktrees', 'CYRA-7'))}="write", ${JSON.stringify(path.join(common, 'objects'))}="write", ` +
      `${JSON.stringify(path.join(common, 'refs', 'heads', 'ticket'))}="write", ${JSON.stringify(path.join(common, 'logs', 'refs', 'heads', 'ticket'))}="write", ` +
      `${JSON.stringify(path.join(common, 'refs', 'remotes', 'origin'))}="write", ${JSON.stringify(path.join(common, 'logs', 'refs', 'remotes', 'origin'))}="write", ` +
      '"/run/user"="none", "/run/dbus"="none", "/run/systemd"="none", "/var/run/docker.sock"="none", ' +
      '"/run/docker.sock"="none", "/var/lib/incus"="none", "/run/incus"="none"}')
    // The directories a first commit or push writes to exist before the session starts.
    expect(fs.existsSync(path.join(common, 'logs', 'refs', 'remotes', 'origin'))).toBe(true)
  })

  // CYRA-1193 — sync-main.sh runs `git fetch origin main`, which moves refs/remotes/origin/main: with only the
  // ticket remote refs writable, every conflict-resolution round on Codex died on a read-only ref.
  it('a write phase may move the remote-tracking main a fetch updates, never the local main', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-skill-fetch-')))
    const repo = path.join(root, 'repo')
    const worktree = path.join(root, 'worktrees', 'CYRA-8')
    const git = (cwd: string, ...args: string[]) =>
      require('node:child_process').spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', ...args], {cwd})
    fs.mkdirSync(repo, {recursive: true})
    git(repo, 'init', '-q', '-b', 'main')
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n')
    git(repo, 'add', 'a.txt')
    git(repo, 'commit', '-qm', 'base')
    git(repo, 'worktree', 'add', '-q', '-b', 'ticket/CYRA-8', worktree)

    const argv = buildCodexArgv(codexAction({run: 'x', sandbox: 'workspace-write', skill}), settingsFile(guardrails), worktree)
    const filesystem = argv.find((arg) => arg.startsWith('permissions.automator.filesystem='))!
    const common = path.join(repo, '.git')

    expect(filesystem).toContain(`${JSON.stringify(path.join(common, 'refs', 'remotes', 'origin'))}="write"`)
    expect(filesystem).not.toContain(`${JSON.stringify(path.join(common, 'refs', 'heads'))}="write"`)
    expect(filesystem).not.toContain(`${JSON.stringify(path.join(common, 'refs'))}="write"`)
  })

  it('a write phase outside a linked Git worktree does not start', () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-skill-plain-'))
    expect(() => buildCodexArgv(codexAction({run: 'x', sandbox: 'workspace-write', skill}), settingsFile(guardrails), plain)).toThrow()
    expect(() => buildCodexArgv(codexAction({run: 'x', sandbox: 'workspace-write', skill}), settingsFile(guardrails))).toThrow()
  })

  it('appends the plan and the retry findings after the invocation, as Claude does', () => {
    const run = composeRetryRun('Fix the failing spec', 'placeholder')
    const argv = buildCodexArgv(codexAction({run, skill}), settingsFile(guardrails))
    expect(argv.at(-1)).toBe('Use $autopilot at /opt/skills/current/skills/autopilot/SKILL.md with this input: CYRA-7\n\nFix the failing spec')
  })

  it('fails closed without the installed guardrail hooks or with a matcher it does not know', () => {
    const action = codexAction({run: 'x', skill})
    expect(() => buildCodexArgv(action, '/missing/settings.json')).toThrow()
    expect(() => buildCodexArgv(action, settingsFile([]))).toThrow()
    expect(() => buildCodexArgv(action, settingsFile([{matcher: 'Read', hooks: []}]))).toThrow()
  })

  // CYAU-285 — the conversation name arrives in the first event, so the result moves to a file.
  const id = '0192f0c4-5d8a-7f7e-9a3c-2f1e8c3b9d10'

  it('a new conversation emits events and writes its result to the given file', () => {
    const argv = buildCodexArgv(codexAction({run: 'placeholder', skill}), settingsFile(guardrails), undefined,
      {conversation: {mode: 'new'}, lastMessageFile: '/repo/.git/result.txt'})
    expect(argv.slice(0, 8)).toEqual([
      '--ask-for-approval', 'never', '--dangerously-bypass-hook-trust', 'exec',
      '--json', '--output-last-message', '/repo/.git/result.txt', '--ignore-user-config',
    ])
    expect(argv).not.toContain('resume')
    expect(argv.slice(-2)).toEqual(['--', 'Use $autopilot at /opt/skills/current/skills/autopilot/SKILL.md with this input: CYRA-7'])
  })

  it('a resumed conversation continues by name and is asked to carry on, not to start over', () => {
    const argv = buildCodexArgv(codexAction({run: 'placeholder', skill}), settingsFile(guardrails), undefined,
      {conversation: {mode: 'resume', id}, lastMessageFile: '/repo/.git/result.txt'})
    expect(argv.slice(0, 8)).toEqual([
      '--ask-for-approval', 'never', '--dangerously-bypass-hook-trust', 'exec', 'resume',
      '--json', '--output-last-message', '/repo/.git/result.txt',
    ])
    expect(argv.slice(-3)).toEqual(['--', id, CONVERSATION_RESUME_PROMPT])
    expect(argv).toContain('features.hooks=true')
    expect(argv).toContain('default_permissions="automator"')
  })

  it('without a result file the session runs as before, and a malformed name is never resumed', () => {
    const plain = buildCodexArgv(codexAction({run: 'placeholder', skill}), settingsFile(guardrails))
    expect(buildCodexArgv(codexAction({run: 'placeholder', skill}), settingsFile(guardrails), undefined,
      {conversation: {mode: 'resume', id}})).toEqual(plain)
    const forged = buildCodexArgv(codexAction({run: 'placeholder', skill}), settingsFile(guardrails), undefined,
      {conversation: {mode: 'resume', id: '--last'}, lastMessageFile: '/r.txt'})
    expect(forged).not.toContain('resume')
    expect(forged).not.toContain('--last')
  })

  it('a playbook action ignores the conversation: only phase skills have one', () => {
    const action = codexAction({run: 'analizza'})
    expect(buildCodexArgv(action, undefined, undefined, {conversation: {mode: 'new'}, lastMessageFile: '/r.txt'}))
      .toEqual(buildCodexArgv(action))
  })

  it('refuses a skill command that is not a step of the CloseYourIt plugin', () => {
    for (const command of ['/other-plugin:triage', '/closeyourit-skills:deploy', '/closeyourit-skills']) {
      const action = codexAction({run: 'x', skill: {...skill, command}})
      expect(() => buildCodexArgv(action, settingsFile(guardrails))).toThrow()
    }
  })
})

// CYAU-285 — what the automator reads from a Codex `--json` session.
describe('readCodexEvent', () => {
  it('reads the conversation name from thread.started, only when it is a UUID', () => {
    expect(readCodexEvent({type: 'thread.started', thread_id: '0192f0c4-5d8a-7f7e-9a3c-2f1e8c3b9d10'}))
      .toEqual({threadId: '0192f0c4-5d8a-7f7e-9a3c-2f1e8c3b9d10'})
    expect(readCodexEvent({type: 'thread.started', thread_id: '../../etc'})).toEqual({})
    expect(readCodexEvent({type: 'thread.started'})).toEqual({})
  })

  it('reads the text of a completed agent message, and nothing from the other items', () => {
    expect(readCodexEvent({type: 'item.completed', item: {type: 'agent_message', text: '{"state":"delivered"}'}}))
      .toEqual({lastMessage: '{"state":"delivered"}'})
    expect(readCodexEvent({type: 'item.completed', item: {type: 'command_execution', text: 'ls'}})).toEqual({})
    expect(readCodexEvent({type: 'item.completed', item: {type: 'agent_message', text: 3}})).toEqual({})
    expect(readCodexEvent({type: 'item.completed', item: ['x']})).toEqual({})
    expect(readCodexEvent({type: 'item.completed', item: null})).toEqual({})
    expect(readCodexEvent({type: 'turn.completed'})).toEqual({})
  })
})
