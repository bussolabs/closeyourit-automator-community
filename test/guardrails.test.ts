import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {spawnSync} from 'node:child_process'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {
  claudeGuardrailsInstalled,
  codexGuardrailsInstalled,
  GUARDRAIL_HOOKS,
  guardrailsInstalled,
  installGuardrails,
  SANDBOX_ALLOWED_DOMAINS,
  sandboxAllowedDomains,
} from '../src/lib/guardrails'

// real assets/guardrails of the package (committed in the repo/worktree).
const ASSETS = path.resolve(__dirname, '..', 'assets', 'guardrails')

let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-guardrails-'))
})
afterEach(() => {
  fs.rmSync(tmp, {recursive: true, force: true})
  delete process.env.AUTOMATOR_CONFIG_DIR
})

describe('installGuardrails', () => {
  it('copies the 6 hooks and renders the settings.json with verified commands and absolute paths', () => {
    const hooksDir = path.join(tmp, 'guardrails', 'hooks')
    const settingsPath = path.join(tmp, 'guardrails', 'settings.json')
    const codexRulesPath = path.join(tmp, 'codex', 'rules', 'automator.rules')
    const res = installGuardrails(ASSETS, {hooksDir, settingsPath, codexRulesPath})

    expect(res.hooks).toEqual([...GUARDRAIL_HOOKS])
    for (const hook of GUARDRAIL_HOOKS) expect(fs.existsSync(path.join(hooksDir, hook))).toBe(true)

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as {
      disableAllHooks: boolean
      hooks: {PreToolUse: Array<{matcher: string; hooks: Array<{command: string}>}>}
    }
    const commands = settings.hooks.PreToolUse.flatMap((g) => g.hooks.map((h) => h.command)).join(' ')
    expect(commands).toContain(hooksDir)
    expect(commands).toContain('--eval')
    expect(commands).toContain('--worktrees-root')
    expect(commands).toContain('--plugin-dir')
    expect(settings.hooks.PreToolUse.some((g) => g.matcher === 'Bash')).toBe(true)
    expect(settings.hooks.PreToolUse.some((g) => g.matcher.includes('Edit'))).toBe(true)
    // CYAU-131: the Bash matcher wires ALL four command hooks, including block-indirect-exec which closes the
    // indirect-exec bypass — so the applied guarantee matches the one declared in CLAUDE.md.
    const bashCommands = settings.hooks.PreToolUse.find((g) => g.matcher === 'Bash')!.hooks.map((h) => h.command).join(' ')
    for (const hook of ['block-production.mjs', 'block-destructive-db.mjs', 'guard-branch-push.mjs', 'block-indirect-exec.mjs', 'block-secret-leak.mjs']) {
      expect(bashCommands).toContain(hook)
    }
    expect(settings.disableAllHooks).toBe(false)
    expect(res.codexRulesPath).toBe(codexRulesPath)
    expect(fs.readFileSync(codexRulesPath, 'utf8')).toContain('decision = "forbidden"')
  })

  it('is idempotent (second run does not throw and stays valid)', () => {
    const hooksDir = path.join(tmp, 'hooks')
    const settingsPath = path.join(tmp, 'settings.json')
    const codexRulesPath = path.join(tmp, 'codex', 'rules', 'automator.rules')
    installGuardrails(ASSETS, {hooksDir, settingsPath, codexRulesPath})
    expect(() => installGuardrails(ASSETS, {hooksDir, settingsPath, codexRulesPath})).not.toThrow()
    expect(guardrailsInstalled({hooksDir, settingsPath, codexRulesPath})).toBe(true)
  })

  it('renders and validates the settings with the Node persisted by the unit, not with the updater shell one', () => {
    const hooksDir = path.join(tmp, 'hooks')
    const settingsPath = path.join(tmp, 'settings.json')
    const codexRulesPath = path.join(tmp, 'codex', 'rules', 'automator.rules')
    const serviceNode = path.join(tmp, 'service-node')

    installGuardrails(ASSETS, {hooksDir, settingsPath, codexRulesPath, nodePath: serviceNode})

    expect(fs.readFileSync(settingsPath, 'utf8')).toContain(serviceNode)
    expect(guardrailsInstalled({hooksDir, settingsPath, codexRulesPath, nodePath: serviceNode})).toBe(true)
    expect(guardrailsInstalled({hooksDir, settingsPath, codexRulesPath, nodePath: path.join(tmp, 'shell-node')})).toBe(false)
  })

  it('a crash/failure before the commit leaves the generation fail-closed and the retry reconciles it', () => {
    const hooksDir = path.join(tmp, 'guardrails', 'hooks')
    const settingsPath = path.join(tmp, 'guardrails', 'settings.json')
    const codexRulesPath = path.join(tmp, 'codex', 'rules', 'automator.rules')
    fs.mkdirSync(codexRulesPath, {recursive: true}) // forces the failure of the final policy rename

    expect(() => installGuardrails(ASSETS, {hooksDir, settingsPath, codexRulesPath})).toThrow()
    expect(claudeGuardrailsInstalled({hooksDir, settingsPath, codexRulesPath})).toBe(false)
    expect(codexGuardrailsInstalled({hooksDir, settingsPath, codexRulesPath})).toBe(false)
    expect(JSON.parse(fs.readFileSync(path.join(path.dirname(settingsPath), 'generation.json'), 'utf8'))).toMatchObject({
      version: 1,
      status: 'installing',
    })

    fs.rmSync(codexRulesPath, {recursive: true})
    installGuardrails(ASSETS, {hooksDir, settingsPath, codexRulesPath})
    expect(guardrailsInstalled({hooksDir, settingsPath, codexRulesPath})).toBe(true)
    expect(JSON.parse(fs.readFileSync(path.join(path.dirname(settingsPath), 'generation.json'), 'utf8'))).toMatchObject({
      version: 1,
      status: 'committed',
    })
  })

  it('uses the default paths (configDir) without opts', () => {
    process.env.AUTOMATOR_CONFIG_DIR = tmp
    process.env.CODEX_HOME = path.join(tmp, 'codex-home')
    installGuardrails(ASSETS)
    expect(guardrailsInstalled()).toBe(true)
  })
})

describe('sandbox OS-level del skill-mode (CYAU-67)', () => {
  const paths = () => ({
    hooksDir: path.join(tmp, 'hooks'),
    settingsPath: path.join(tmp, 'settings.json'),
    codexRulesPath: path.join(tmp, 'codex', 'rules', 'automator.rules'),
  })

  it('the settings.json carries the fail-closed sandbox block with the populated network allowlist', () => {
    const {hooksDir, settingsPath, codexRulesPath} = paths()
    installGuardrails(ASSETS, {hooksDir, settingsPath, codexRulesPath})

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as {
      sandbox?: {
        enabled?: boolean
        failIfUnavailable?: boolean
        allowUnsandboxedCommands?: boolean
        network?: {allowedDomains?: string[]}
      }
    }
    // Fail-closed: sandbox active, rejects if unavailable, no unsandboxed escape.
    expect(settings.sandbox).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
    })

    const domains = settings.sandbox?.network?.allowedDomains ?? []
    expect(domains).toEqual(sandboxAllowedDomains())
    expect(domains.length).toBeGreaterThan(0)
    // The hosts the skill scripts really contact (cyi/git/gh/npm): with the network denied by default in
    // headless mode, omitting them would break delivery and Knowledge. Apex and wildcard are distinct entries.
    for (const host of ['closeyour.it', '*.closeyour.it', 'github.com', '*.github.com', '*.githubusercontent.com', 'registry.npmjs.org']) {
      expect(domains).toContain(host)
    }
  })

  // CYAU-242: the operator's GitHub token, the automator config, the Claude/Codex homes and the keyring must
  // not be readable by a Bash subprocess of the agent (`gh auth token`, `cat ~/.claude/...`).
  it('the settings.json denies the credential directories to the sandboxed Bash', () => {
    const {hooksDir, settingsPath, codexRulesPath} = paths()
    installGuardrails(ASSETS, {hooksDir, settingsPath, codexRulesPath})

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as {
      sandbox?: {filesystem?: {denyRead?: string[]}}
    }
    expect(settings.sandbox?.filesystem?.denyRead).toEqual([
      '~/.config/gh',
      '~/.config/closeyourit-automator',
      '~/.claude',
      '~/.codex',
      '~/.local/share/keyrings',
    ])
  })

  it('the sandbox block is included in the generationId pin (a drift is rejected)', () => {
    const {hooksDir, settingsPath, codexRulesPath} = paths()
    installGuardrails(ASSETS, {hooksDir, settingsPath, codexRulesPath})
    expect(claudeGuardrailsInstalled({hooksDir, settingsPath})).toBe(true)

    // installGuardrails writes the SAME `settings` string both on disk and in `generationId(settings, …)`:
    // so the sandbox block present in the settings.json is part of the pinned bytes. And since claudeFilesInstalled
    // compares the disk again with `renderSettings` (which now includes sandbox), removing the block is a detected
    // drift → the verification fails.
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as {sandbox?: unknown}
    expect(settings.sandbox).toBeDefined()
    delete settings.sandbox
    fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`)
    expect(claudeGuardrailsInstalled({hooksDir, settingsPath})).toBe(false)
  })
})

describe('guardrailsInstalled', () => {
  it('false if the settings.json is missing', () => {
    expect(claudeGuardrailsInstalled({hooksDir: tmp, settingsPath: path.join(tmp, 'nope.json')})).toBe(false)
  })

  it('false if even a single hook is missing', () => {
    const hooksDir = path.join(tmp, 'hooks')
    const settingsPath = path.join(tmp, 'settings.json')
    const codexRulesPath = path.join(tmp, 'codex', 'rules', 'automator.rules')
    installGuardrails(ASSETS, {hooksDir, settingsPath, codexRulesPath})
    fs.rmSync(path.join(hooksDir, GUARDRAIL_HOOKS[0]))
    expect(claudeGuardrailsInstalled({hooksDir, settingsPath})).toBe(false)
  })

  it('true when settings + all hooks are present', () => {
    const hooksDir = path.join(tmp, 'hooks')
    const settingsPath = path.join(tmp, 'settings.json')
    const codexRulesPath = path.join(tmp, 'codex', 'rules', 'automator.rules')
    installGuardrails(ASSETS, {hooksDir, settingsPath, codexRulesPath})
    expect(claudeGuardrailsInstalled({hooksDir, settingsPath})).toBe(true)
    expect(codexGuardrailsInstalled({hooksDir, settingsPath, codexRulesPath})).toBe(true)
    fs.rmSync(codexRulesPath)
    expect(codexGuardrailsInstalled({hooksDir, settingsPath, codexRulesPath})).toBe(false)
    expect(guardrailsInstalled({hooksDir, settingsPath, codexRulesPath})).toBe(false)
  })

  it('rejects no-op hooks, marker-only settings and partial Codex policy', () => {
    const hooksDir = path.join(tmp, 'hooks')
    const settingsPath = path.join(tmp, 'settings.json')
    const codexRulesPath = path.join(tmp, 'codex', 'rules', 'automator.rules')
    installGuardrails(ASSETS, {hooksDir, settingsPath, codexRulesPath})

    fs.writeFileSync(path.join(hooksDir, GUARDRAIL_HOOKS[0]), 'process.exit(0)\n')
    expect(claudeGuardrailsInstalled({assetsDir: ASSETS, hooksDir, settingsPath})).toBe(false)
    installGuardrails(ASSETS, {hooksDir, settingsPath, codexRulesPath})

    fs.writeFileSync(settingsPath, JSON.stringify({disableAllHooks: false, hooks: {PreToolUse: [{matcher: 'Bash', hooks: [{type: 'command', command: 'true # block-production.mjs'}]}]}}))
    expect(claudeGuardrailsInstalled({assetsDir: ASSETS, hooksDir, settingsPath})).toBe(false)

    fs.writeFileSync(codexRulesPath, '# closeyourit-automator:guardrails-v2\ndecision = "forbidden"\n')
    expect(codexGuardrailsInstalled({assetsDir: ASSETS, codexRulesPath})).toBe(false)
  })

  it('rejects symlinks even if they point to the correct content', () => {
    const hooksDir = path.join(tmp, 'hooks')
    const settingsPath = path.join(tmp, 'settings.json')
    const codexRulesPath = path.join(tmp, 'codex', 'rules', 'automator.rules')
    installGuardrails(ASSETS, {hooksDir, settingsPath, codexRulesPath})
    const hook = path.join(hooksDir, GUARDRAIL_HOOKS[0])
    const copy = `${hook}.copy`
    fs.copyFileSync(hook, copy)
    fs.rmSync(hook)
    fs.symlinkSync(copy, hook)
    expect(claudeGuardrailsInstalled({assetsDir: ASSETS, hooksDir, settingsPath})).toBe(false)
  })

  it('atomically replaces a symlink without modifying its target', () => {
    const hooksDir = path.join(tmp, 'hooks')
    const settingsPath = path.join(tmp, 'settings.json')
    const codexRulesPath = path.join(tmp, 'codex', 'rules', 'automator.rules')
    fs.mkdirSync(hooksDir, {recursive: true})
    const target = path.join(tmp, 'victim')
    fs.writeFileSync(target, 'preserve')
    fs.symlinkSync(target, path.join(hooksDir, GUARDRAIL_HOOKS[0]))

    installGuardrails(ASSETS, {hooksDir, settingsPath, codexRulesPath})

    expect(fs.readFileSync(target, 'utf8')).toBe('preserve')
    expect(fs.lstatSync(path.join(hooksDir, GUARDRAIL_HOOKS[0])).isSymbolicLink()).toBe(false)
    expect(guardrailsInstalled({assetsDir: ASSETS, hooksDir, settingsPath, codexRulesPath})).toBe(true)
  })

  it('the already loaded runner blocks a hook replaced after the gate', () => {
    const hooksDir = path.join(tmp, 'hooks')
    const settingsPath = path.join(tmp, 'settings.json')
    const codexRulesPath = path.join(tmp, 'codex', 'rules', 'automator.rules')
    installGuardrails(ASSETS, {hooksDir, settingsPath, codexRulesPath})
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as {
      hooks: {PreToolUse: Array<{matcher: string; hooks: Array<{command: string}>}>}
    }
    const loadedCommand = settings.hooks.PreToolUse.find((entry) => entry.matcher === 'Bash')!.hooks[0].command
    fs.writeFileSync(path.join(hooksDir, 'block-production.mjs'), 'export async function main(){process.exit(0)}\n')

    const result = spawnSync('sh', ['-c', loadedCommand], {
      encoding: 'utf8',
      input: JSON.stringify({tool_name: 'Bash', tool_input: {command: 'echo safe'}}),
    })

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('guardrail integrity')
  })

  it('the inline runner executes the verified bytes of the valid hook', () => {
    const hooksDir = path.join(tmp, 'hooks')
    const settingsPath = path.join(tmp, 'settings.json')
    const codexRulesPath = path.join(tmp, 'codex', 'rules', 'automator.rules')
    installGuardrails(ASSETS, {hooksDir, settingsPath, codexRulesPath})
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as {
      hooks: {PreToolUse: Array<{matcher: string; hooks: Array<{command: string}>}>}
    }
    const loadedCommand = settings.hooks.PreToolUse.find((entry) => entry.matcher === 'Bash')!.hooks[0].command

    const allowed = spawnSync('sh', ['-c', loadedCommand], {
      encoding: 'utf8',
      input: JSON.stringify({tool_name: 'Bash', tool_input: {command: 'echo safe'}}),
    })
    const blocked = spawnSync('sh', ['-c', loadedCommand], {
      encoding: 'utf8',
      input: JSON.stringify({tool_name: 'Bash', tool_input: {command: "ka''mal deploy"}}),
    })

    expect(allowed.status).toBe(0)
    expect(blocked.status).toBe(2)
    expect(blocked.stderr).toContain('guardrail no-produzione')
  })
})

// CYRA-918 — a self-hosted CloseYourIt lives on its own domain: the sandbox must reach it, and the operator's
// production hosts must reach the production hook, both from the host environment.
describe('installation-specific domains and hosts', () => {
  it('adds AUTOMATOR_SANDBOX_DOMAINS to the built-in allowlist', () => {
    expect(sandboxAllowedDomains({AUTOMATOR_SANDBOX_DOMAINS: 'tracker.example.com, *.example.org'}))
      .toEqual([...SANDBOX_ALLOWED_DOMAINS, 'tracker.example.com', '*.example.org'])
  })
  it('keeps the built-in allowlist when the variable is unset', () => {
    expect(sandboxAllowedDomains({})).toEqual([...SANDBOX_ALLOWED_DOMAINS])
  })
  // CYAU-238 — Codex reaches a private server only by its IPv4 address, which the allowlist accepts as it is.
  it('accepts an IPv4 address, and refuses an IPv6 one', () => {
    expect(sandboxAllowedDomains({AUTOMATOR_SANDBOX_DOMAINS: '192.168.1.20'})).toEqual([...SANDBOX_ALLOWED_DOMAINS, '192.168.1.20'])
    expect(() => sandboxAllowedDomains({AUTOMATOR_SANDBOX_DOMAINS: 'fd12::5'})).toThrow(/AUTOMATOR_SANDBOX_DOMAINS/)
  })
  it('refuses a malformed domain instead of dropping it', () => {
    expect(() => sandboxAllowedDomains({AUTOMATOR_SANDBOX_DOMAINS: 'ok.example.com,bad domain'})).toThrow(/AUTOMATOR_SANDBOX_DOMAINS/)
  })
})
