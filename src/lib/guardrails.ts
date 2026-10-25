import * as fs from 'node:fs'
import * as path from 'node:path'
import {createHash, randomUUID} from 'node:crypto'
import {extraProductionHosts} from './command-policy'
import {codexGuardrailsRulesPath, guardrailsDir, guardrailsHooksDir, guardrailsSettingsPath, skillsPluginDir, worktreesDir} from './paths'

// Guardrail subsystem: deterministic Claude hooks and Codex `.rules` policy installed outside the target repos.
// Every agent session requires its provider's guardrail; absence or corruption causes a rejection before
// the spawn. Claude receives settings isolated from mutable sources, Codex uses rules loaded from the active CODEX_HOME.

export const GUARDRAIL_HOOKS = [
  'block-production.mjs',
  'block-destructive-db.mjs',
  'require-worktree.mjs',
  'guard-branch-push.mjs',
  'block-indirect-exec.mjs',
  'block-secret-leak.mjs',
] as const
const CODEX_RULES_ASSET = 'codex/automator.rules'
const DEFAULT_ASSETS_DIR = path.resolve(__dirname, '..', '..', 'assets', 'guardrails')

// The runner lives inline in the settings loaded by Claude. At every PreToolUse it reads the content only once,
// checks regular file/non-symlink + canonical SHA-256 and imports EXACTLY those bytes from a data URL: even if
// the agent replaces the asset after the gate, it cannot get the altered content executed nor exploit a TOCTOU.
const INLINE_HOOK_RUNNER = [
  "import{createHash}from'node:crypto'",
  "import{lstatSync,readFileSync}from'node:fs'",
  "const[expected,file,...args]=process.argv.slice(1)",
  "try{const stat=lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink())throw 0;const body=readFileSync(file);if(createHash('sha256').update(body).digest('hex')!==expected)throw 0;const module=await import('data:text/javascript;base64,'+body.toString('base64'));if(typeof module.main!=='function')throw 0;await module.main(args)}catch{process.stderr.write('guardrail integrity: asset non valido; operazione bloccata.\\n');process.exit(2)}",
].join(';')

export interface GuardrailPaths {
  hooksDir?: string
  settingsPath?: string
  codexRulesPath?: string
  assetsDir?: string
  worktreesRoot?: string
  /** Pinned skill bundle passed to `block-indirect-exec` to exempt its entrypoints (default `skillsPluginDir()`). */
  skillsPluginRoot?: string
  generationPath?: string
  nodePath?: string
}

interface GuardrailGeneration {
  version: 1
  generation: string
  status: 'installing' | 'committed'
}

export interface PlannedGuardrailFile {
  path: string
  /** Final bytes of the committed generation. */
  content: Buffer
  /** Transient bytes the rollback can recognise as its own after a crash. */
  transitionalContents: Buffer[]
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

function shellArg(value: string): string {
  return JSON.stringify(value)
}

function canonicalAssets(assetsDir: string): {hooks: Map<string, Buffer>; codexRules: Buffer} {
  const hooks = new Map<string, Buffer>()
  for (const hook of GUARDRAIL_HOOKS) {
    const source = path.join(assetsDir, 'hooks', hook)
    const stat = fs.lstatSync(source)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Asset guardrail non regolare: ${source}`)
    hooks.set(hook, fs.readFileSync(source))
  }
  const rulesPath = path.join(assetsDir, CODEX_RULES_ASSET)
  const rulesStat = fs.lstatSync(rulesPath)
  if (!rulesStat.isFile() || rulesStat.isSymbolicLink()) throw new Error(`Asset guardrail non regolare: ${rulesPath}`)
  return {hooks, codexRules: fs.readFileSync(rulesPath)}
}

function hookCommand(nodePath: string, hookPath: string, content: Buffer, extraArgs: string[] = []): string {
  return [nodePath, '--input-type=module', '--eval', INLINE_HOOK_RUNNER, sha256(content), hookPath, ...extraArgs]
    .map(shellArg)
    .join(' ')
}

/**
 * Network domains the OS-level sandbox (CYAU-67) allows to Bash subprocesses. With `sandbox.enabled` the network is
 * DENIED by default and in headless `-p` there is no interactive approver: the hosts the skill scripts
 * contact must be listed here, otherwise `cyi`/`git`/`gh` would break in skill-mode. The Anthropic
 * domains are NOT needed: the Claude session's connection to the API lives in the unsandboxed PARENT process (only the
 * Bash subprocesses are confined).
 *
 * It must stay STATIC and deterministic: `renderSettings` feeds both the `generationId` pin and the byte-for-byte
 * comparison of `claudeFilesInstalled`/`committedGenerationInstalled`, also invoked by the pre-spawn gate
 * (`runtime.ts`) and by the daemon boot — call sites without access to secrets → the domain CANNOT depend
 * on the `apiUrl` configured at runtime (it would break the check). For CloseYourIt (`cyi`, default
 * `https://app.closeyour.it`) apex + subdomains (app/www/staging/custom) are covered; an `apiUrl` with a host other than
 * `closeyour.it` must be added here (documented limit).
 */
export const SANDBOX_ALLOWED_DOMAINS = [
  // CloseYourIt API (`cyi`): default app (www still proxies the API), plus any staging/custom subdomains and the apex.
  'closeyour.it',
  '*.closeyour.it',
  // GitHub (`git` fetch/push, `gh` pr/api): apex + api/codeload/uploads (*.github.com) + release/raw assets.
  'github.com',
  '*.github.com',
  '*.githubusercontent.com',
  // npm/pnpm registry: the target repos' quality-gate/verify run the package install.
  'registry.npmjs.org',
  // RubyGems registry (CYAU-134): the Ruby twin of the previous one. Without it, in a Rails repo `bundle install`
  // does not start, so neither `rspec` nor `rubocop` run and the quality gate cannot produce any evidence —
  // the session stops without having verified anything, on EVERY Rails project of the fleet.
  'rubygems.org',
  '*.rubygems.org',
] as const

const DOMAIN_NAME = /^(?:\*\.)?[A-Za-z0-9.-]+$/

/**
 * SANDBOX_ALLOWED_DOMAINS plus AUTOMATOR_SANDBOX_DOMAINS (comma-separated): a self-hosted CloseYourIt lives on its
 * own domain, which the skills must reach (CYRA-918). The variable belongs to the host, like AUTOMATOR_WORK_ENGINE,
 * so the settings stay deterministic. A malformed entry throws: silently dropping it would break delivery later.
 */
export function sandboxAllowedDomains(env: NodeJS.ProcessEnv = process.env): string[] {
  const extra = (env.AUTOMATOR_SANDBOX_DOMAINS ?? '').split(',').map((domain) => domain.trim()).filter((domain) => domain !== '')
  for (const domain of extra) {
    if (!DOMAIN_NAME.test(domain)) throw new Error(`AUTOMATOR_SANDBOX_DOMAINS: not a domain: ${domain}`)
  }
  return [...SANDBOX_ALLOWED_DOMAINS, ...extra]
}

/** Credential directories the sandboxed Bash must not read (CYAU-242). `~` is the session user's home. */
const SANDBOX_DENIED_READ_PATHS = [
  '~/.config/gh',
  '~/.config/closeyourit-automator',
  '~/.claude',
  '~/.codex',
  '~/.local/share/keyrings',
] as const

function productionHostArgs(): string[] {
  const hosts = extraProductionHosts()
  return hosts.length === 0 ? [] : ['--production-hosts', hosts.join(',')]
}

function renderSettings(hooksDir: string, worktreesRoot: string, skillsPluginRoot: string, hooks: Map<string, Buffer>, nodePath: string): string {
  const command = (name: typeof GUARDRAIL_HOOKS[number], extraArgs: string[] = []): {type: 'command'; command: string} => ({
    type: 'command',
    command: hookCommand(nodePath, path.join(hooksDir, name), hooks.get(name)!, extraArgs),
  })
  return `${JSON.stringify({
    disableAllHooks: false,
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          // block-indirect-exec closes the bypass of the three textual hooks (forbidden command written to a file and then
          // launched): it exempts only the entrypoints of the pinned skill bundle (`--plugin-dir`, not writable by the agent).
          hooks: [
            // Hosts of this installation on top of the hook's built-in list; omitted when there are none, so an
            // installation without the variable keeps byte-identical settings.
            command('block-production.mjs', productionHostArgs()),
            command('block-destructive-db.mjs'),
            command('guard-branch-push.mjs'),
            command('block-indirect-exec.mjs', ['--plugin-dir', skillsPluginRoot]),
            // CYAU-242: a push or a cyi/gh/curl command line that carries a credential never leaves the machine.
            command('block-secret-leak.mjs'),
          ],
        },
        {
          matcher: 'Edit|Write|MultiEdit|NotebookEdit',
          hooks: [command('require-worktree.mjs', ['--worktrees-root', worktreesRoot, '--authorized-cwd', '.'])],
        },
      ],
    },
    // OS-level sandbox (CYAU-67): bubblewrap on Linux. It is the real boundary of
    // skill-mode, where the skills run their own scripts via Bash: it confines WRITES to the default writable
    // paths (cwd/worktree + $TMPDIR; $HOME and the rest of the filesystem denied) and DENIES network egress except
    // `allowedDomains`. Fail-closed: `failIfUnavailable` rejects the session if the sandbox does not start (never unconfined
    // Bash) and `allowUnsandboxedCommands:false` neutralizes the `dangerouslyDisableSandbox` escape. It lives in the
    // SHARED settings: in prompt-mode Bash is not among the tools → harmless no-op; in skill-mode it is the boundary.
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      network: {allowedDomains: sandboxAllowedDomains()},
      // CYAU-242: the operator's GitHub token (`gh auth token`), the automator config, the Claude/Codex homes and
      // the keyring are not readable from the sandboxed Bash. The hooks and the settings are read by the parent
      // Claude process, outside the sandbox, so denying them here costs nothing to the session.
      filesystem: {denyRead: SANDBOX_DENIED_READ_PATHS},
    },
  }, null, 2)}\n`
}

function generationPath(opts: GuardrailPaths, settingsPath: string): string {
  if (opts.generationPath) return opts.generationPath
  return opts.settingsPath ? path.join(path.dirname(settingsPath), 'generation.json') : path.join(guardrailsDir(), 'generation.json')
}

function generationId(settings: string, canonical: {hooks: Map<string, Buffer>; codexRules: Buffer}): string {
  const hash = createHash('sha256')
  for (const hook of GUARDRAIL_HOOKS) hash.update(hook).update('\0').update(canonical.hooks.get(hook)!).update('\0')
  return hash.update(settings).update('\0').update(canonical.codexRules).digest('hex')
}

/** Deterministic plan of only the files installGuardrails can mutate, including the transient marker. */
export function planGuardrailFiles(assetsDir: string, opts: GuardrailPaths = {}): PlannedGuardrailFile[] {
  const hooksDir = opts.hooksDir ?? guardrailsHooksDir()
  const settingsPath = opts.settingsPath ?? guardrailsSettingsPath()
  const codexRulesPath = opts.codexRulesPath ?? codexGuardrailsRulesPath()
  const worktreesRoot = opts.worktreesRoot ?? worktreesDir()
  const nodePath = opts.nodePath ?? process.execPath
  const skillsPluginRoot = opts.skillsPluginRoot ?? skillsPluginDir()
  const canonical = canonicalAssets(assetsDir)
  const settings = renderSettings(hooksDir, worktreesRoot, skillsPluginRoot, canonical.hooks, nodePath)
  const markerPath = generationPath(opts, settingsPath)
  const generation = generationId(settings, canonical)
  const installing = Buffer.from(`${JSON.stringify({version: 1, generation, status: 'installing'} satisfies GuardrailGeneration)}\n`)
  const committed = Buffer.from(`${JSON.stringify({version: 1, generation, status: 'committed'} satisfies GuardrailGeneration)}\n`)
  return [
    {path: markerPath, content: committed, transitionalContents: [installing]},
    ...GUARDRAIL_HOOKS.map((hook) => ({
      path: path.join(hooksDir, hook), content: canonical.hooks.get(hook)!, transitionalContents: [],
    })),
    {path: settingsPath, content: Buffer.from(settings), transitionalContents: []},
    {path: codexRulesPath, content: canonical.codexRules, transitionalContents: []},
  ]
}

function readCommittedGeneration(file: string, expected: string): boolean {
  try {
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink()) return false
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<GuardrailGeneration>
    return parsed.version === 1 && parsed.status === 'committed' && parsed.generation === expected
  } catch {
    return false
  }
}

function atomicWriteFile(destination: string, content: Buffer | string): void {
  const directory = path.dirname(destination)
  fs.mkdirSync(directory, {recursive: true})
  const temporary = path.join(directory, `.${path.basename(destination)}.${process.pid}.${randomUUID()}.tmp`)
  let descriptor: number | undefined
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600)
    fs.writeFileSync(descriptor, content)
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    fs.renameSync(temporary, destination)
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
    fs.rmSync(temporary, {force: true})
  }
}

function sameRegularFile(file: string, expected: Buffer | string): boolean {
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink()) return false
  const actual = fs.readFileSync(file)
  const wanted = typeof expected === 'string' ? Buffer.from(expected) : expected
  return actual.equals(wanted)
}

/**
 * Installs (idempotently) Claude hooks/settings and the Codex policy.
 * `assetsDir` = the package's `assets/guardrails` folder (the command passes it from `this.config.root`,
 * so it works both in dev and from the installed checkout, without depending on __dirname/dist).
 */
export function installGuardrails(
  assetsDir: string,
  opts: GuardrailPaths = {},
): {hooksDir: string; settingsPath: string; codexRulesPath: string; hooks: readonly string[]} {
  const hooksDir = opts.hooksDir ?? guardrailsHooksDir()
  const settingsPath = opts.settingsPath ?? guardrailsSettingsPath()
  const codexRulesPath = opts.codexRulesPath ?? codexGuardrailsRulesPath()
  const worktreesRoot = opts.worktreesRoot ?? worktreesDir()
  const nodePath = opts.nodePath ?? process.execPath
  const skillsPluginRoot = opts.skillsPluginRoot ?? skillsPluginDir()
  const canonical = canonicalAssets(assetsDir)
  const settings = renderSettings(hooksDir, worktreesRoot, skillsPluginRoot, canonical.hooks, nodePath)
  const markerPath = generationPath(opts, settingsPath)
  const generation = generationId(settings, canonical)

  // The "installing" marker is published before any file: a crash exposes an uncommitted generation
  // that both runtimes reject. The journaled update then knows which release to reinstall on recovery/rollback.
  atomicWriteFile(markerPath, `${JSON.stringify({version: 1, generation, status: 'installing'} satisfies GuardrailGeneration)}\n`)

  for (const hook of GUARDRAIL_HOOKS) {
    atomicWriteFile(path.join(hooksDir, hook), canonical.hooks.get(hook)!)
  }

  atomicWriteFile(settingsPath, settings)
  atomicWriteFile(codexRulesPath, canonical.codexRules)

  const installed = {assetsDir, hooksDir, settingsPath, codexRulesPath, worktreesRoot, generationPath: markerPath, nodePath}
  if (!claudeFilesInstalled(installed) || !codexFileInstalled(installed)) {
    throw new Error('Installazione guardrail incompleta o corrotta')
  }
  // A single logical commit makes the complete generation visible to both runtimes.
  atomicWriteFile(markerPath, `${JSON.stringify({version: 1, generation, status: 'committed'} satisfies GuardrailGeneration)}\n`)
  if (!guardrailsInstalled(installed)) throw new Error('Commit generazione guardrail non verificabile')

  return {hooksDir, settingsPath, codexRulesPath, hooks: GUARDRAIL_HOOKS}
}

function claudeFilesInstalled(opts: GuardrailPaths = {}): boolean {
  const hooksDir = opts.hooksDir ?? guardrailsHooksDir()
  const settingsPath = opts.settingsPath ?? guardrailsSettingsPath()
  const assetsDir = opts.assetsDir ?? DEFAULT_ASSETS_DIR
  const worktreesRoot = opts.worktreesRoot ?? worktreesDir()
  const nodePath = opts.nodePath ?? process.execPath
  const skillsPluginRoot = opts.skillsPluginRoot ?? skillsPluginDir()
  try {
    const canonical = canonicalAssets(assetsDir)
    if (!sameRegularFile(settingsPath, renderSettings(hooksDir, worktreesRoot, skillsPluginRoot, canonical.hooks, nodePath))) return false
    return GUARDRAIL_HOOKS.every((hook) => sameRegularFile(path.join(hooksDir, hook), canonical.hooks.get(hook)!))
  } catch {
    return false
  }
}

function codexFileInstalled(opts: GuardrailPaths = {}): boolean {
  const rulesPath = opts.codexRulesPath ?? codexGuardrailsRulesPath()
  const assetsDir = opts.assetsDir ?? DEFAULT_ASSETS_DIR
  try {
    return sameRegularFile(rulesPath, canonicalAssets(assetsDir).codexRules)
  } catch {
    return false
  }
}

function committedGenerationInstalled(opts: GuardrailPaths = {}): boolean {
  const hooksDir = opts.hooksDir ?? guardrailsHooksDir()
  const settingsPath = opts.settingsPath ?? guardrailsSettingsPath()
  const assetsDir = opts.assetsDir ?? DEFAULT_ASSETS_DIR
  const worktreesRoot = opts.worktreesRoot ?? worktreesDir()
  const nodePath = opts.nodePath ?? process.execPath
  const skillsPluginRoot = opts.skillsPluginRoot ?? skillsPluginDir()
  try {
    const canonical = canonicalAssets(assetsDir)
    const settings = renderSettings(hooksDir, worktreesRoot, skillsPluginRoot, canonical.hooks, nodePath)
    return readCommittedGeneration(generationPath(opts, settingsPath), generationId(settings, canonical))
  } catch {
    return false
  }
}

/** Validates Claude settings + hooks: a present but disabled/partial file never enables a session. */
export function claudeGuardrailsInstalled(opts: GuardrailPaths = {}): boolean {
  return committedGenerationInstalled(opts) && claudeFilesInstalled(opts)
}

/** Validates the installed Codex policy; absence/corruption makes the session be rejected before the spawn. */
export function codexGuardrailsInstalled(opts: GuardrailPaths = {}): boolean {
  return committedGenerationInstalled(opts) && codexFileInstalled(opts)
}

/** Enrollment: both runtimes must have their own enforcement installed. */
export function guardrailsInstalled(opts: GuardrailPaths = {}): boolean {
  return claudeGuardrailsInstalled(opts) && codexGuardrailsInstalled(opts)
}
