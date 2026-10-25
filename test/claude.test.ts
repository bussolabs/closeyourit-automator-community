import {afterAll, describe, expect, it} from 'vitest'
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {
  buildClaudeArgv,
  claudeIsError,
  claudeSessionCostUsd,
  CLAUDE_BIN,
  composeRetryRun,
  extractRetryFindings,
  RETRY_FINDINGS_SEPARATOR,
  skillTools,
} from '../src/lib/claude'
import {EXECUTION_PHASES, phaseProfile} from '../src/lib/phase-profile'
import {type ClaudeActionT, PlaybookSchema} from '../src/lib/schema'

const directory = mkdtempSync(join(tmpdir(), 'claude-settings-'))
const guardrails = join(directory, 'settings.json')
const baseSettings = {hooks: {PreToolUse: []}, sandbox: {enabled: true}}
writeFileSync(guardrails, JSON.stringify(baseSettings))
afterAll(() => rmSync(directory, {recursive: true, force: true}))

/** Builds a typed claude Action with defaults applied (via zod). */
function claudeAction(partial: Record<string, unknown>): ClaudeActionT {
  const parsed = PlaybookSchema.parse({
    version: 1,
    actions: {a: {schedule: 'every 1m', type: 'claude', ...(partial.skill ? {containment: 'strong'} : {}), ...partial}},
  }).actions.a
  if (parsed.type !== 'claude') throw new Error('atteso claude')
  return parsed
}

describe('buildClaudeArgv', () => {
  it('every mode → guardrail settings and only authoritative setting sources', () => {
    expect(buildClaudeArgv(claudeAction({run: '/audit'}), guardrails)).toEqual([
      '-p',
      '/audit',
      '--output-format',
      'json',
      '--tools',
      'Read,Glob,Grep,Edit,Write,MultiEdit,NotebookEdit',
      '--model',
      'claude-opus-5-5',
      '--settings',
      guardrails,
      '--setting-sources',
      '',
    ])
  })

  it('includes permission-mode, allowed-tools and model when present', () => {
    expect(
      buildClaudeArgv(
        claudeAction({run: '/audit', permission_mode: 'plan', allowed_tools: ['Read', 'Bash(cyi:*)'], model: 'sonnet'}),
        guardrails,
      ),
    ).toEqual([
      '-p',
      '/audit',
      '--output-format',
      'json',
      '--tools',
      'Read,Glob,Grep,Edit,Write,MultiEdit,NotebookEdit',
      '--permission-mode',
      'plan',
      '--allowed-tools',
      'Read',
      '--model',
      'sonnet',
      '--settings',
      guardrails,
      '--setting-sources',
      '',
    ])
  })

  it('without model → uses the pinned Claude model, also in skill mode', () => {
    const prompt = buildClaudeArgv(claudeAction({run: '/x'}), guardrails)
    expect(prompt.at(prompt.indexOf('--model') + 1)).toBe('claude-opus-5-5')
    const skill = buildClaudeArgv(
      claudeAction({run: 'x', skill: {command: '/closeyourit-skills:triage', args: 'CYRA-1', plugin_dir: '/d'}}),
      guardrails,
    )
    expect(skill.at(skill.indexOf('--model') + 1)).toBe('claude-opus-5-5')
  })

  it('structurally denies Bash even if requested in allowed_tools', () => {
    const args = buildClaudeArgv(claudeAction({run: '/x', allowed_tools: ['Bash', 'Bash(node:*)', 'Read']}), guardrails)
    expect(args.join(' ')).not.toContain('Bash')
    expect(args).toContain('Read,Glob,Grep,Edit,Write,MultiEdit,NotebookEdit')
  })

  it('bypassPermissions → injects --settings <guardrail>', () => {
    const args = buildClaudeArgv(claudeAction({run: '/x', permission_mode: 'bypassPermissions'}), guardrails)
    expect(args).toContain('--settings')
    expect(args[args.indexOf('--settings') + 1]).toBe(guardrails)
  })

  it('non-bypass → still keeps --settings (permission mode cannot disable the policy)', () => {
    expect(buildClaudeArgv(claudeAction({run: '/x', permission_mode: 'plan'}), guardrails)).toContain('--settings')
  })

  it('CLAUDE_BIN is the claude binary', () => {
    expect(CLAUDE_BIN).toBe('claude')
  })
})

describe('buildClaudeArgv skill mode', () => {
  it('invokes the plugin slash-command with --plugin-dir and the ticket as argument', () => {
    expect(
      buildClaudeArgv(
        claudeAction({
          run: 'non usato in skill mode',
          skill: {command: '/closeyourit-skills:triage', args: 'CYRA-132', plugin_dir: '/data/skills/v1/closeyourit-skills'},
        }),
        guardrails,
      ),
    ).toEqual([
      '-p',
      '/closeyourit-skills:triage CYRA-132',
      '--output-format',
      'json',
      '--plugin-dir',
      '/data/skills/v1/closeyourit-skills',
      '--tools',
      'Read,Glob,Grep,Edit,Write,MultiEdit,NotebookEdit,Bash',
      '--model',
      'claude-opus-5-5',
      '--settings',
      JSON.stringify(baseSettings),
      '--setting-sources',
      '',
    ])
  })

  it('without args: only the slash-command in -p', () => {
    const args = buildClaudeArgv(
      claudeAction({run: 'x', skill: {command: '/closeyourit-skills:autopilot', plugin_dir: '/d'}}),
      guardrails,
    )
    expect(args.slice(0, 2)).toEqual(['-p', '/closeyourit-skills:autopilot'])
  })

  it('skills have Bash enabled (they run scripts) — covered by the guardrail hooks, not by the file-tools alone', () => {
    const args = buildClaudeArgv(
      claudeAction({run: 'x', skill: {command: '/closeyourit-skills:autopilot', args: 'CYRA-1', plugin_dir: '/d'}}),
      guardrails,
    )
    expect(args[args.indexOf('--tools') + 1].split(',')).toContain('Bash')
  })

  it('read phase (restricted allowed_tools): --tools = only those file-tools + Bash, never Edit/Write (CYAU-119)', () => {
    const args = buildClaudeArgv(
      claudeAction({
        run: 'x',
        allowed_tools: ['Read', 'Glob', 'Grep'],
        skill: {command: '/closeyourit-skills:triage', args: 'CYAU-119', plugin_dir: '/d'},
      }),
      guardrails,
    )
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Glob,Grep,Bash')
    expect(JSON.parse(args[args.indexOf('--settings') + 1]).sandbox.filesystem.denyWrite).toContain(process.cwd())
    const tools = args[args.indexOf('--tools') + 1].split(',')
    // Read phases cannot modify files: no write file-tool exists in the session.
    expect(tools).not.toContain('Edit')
    expect(tools).not.toContain('Write')
    expect(tools).not.toContain('MultiEdit')
    expect(tools).not.toContain('NotebookEdit')
    // Bash stays: skills run their own scripts (cyi/git/node); the boundary is the sandbox + the guardrail hooks.
    expect(tools).toContain('Bash')
  })

  it('write phase (allowed_tools missing): --tools = full file-tool list + Bash (unchanged, CYAU-119)', () => {
    const args = buildClaudeArgv(
      claudeAction({run: 'x', skill: {command: '/closeyourit-skills:autopilot', args: 'CYAU-1', plugin_dir: '/d'}}),
      guardrails,
    )
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Glob,Grep,Edit,Write,MultiEdit,NotebookEdit,Bash')
  })

  it('allowed_tools without any valid file-tool (only Bash/unknown): --tools = only Bash, fail-closed (CYAU-119)', () => {
    const args = buildClaudeArgv(
      claudeAction({run: 'x', allowed_tools: ['Bash'], skill: {command: '/closeyourit-skills:triage', plugin_dir: '/d'}}),
      guardrails,
    )
    // An explicit allowed_tools that names no file-tool never falls back to the full list with Edit/Write.
    expect(args[args.indexOf('--tools') + 1]).toBe('Bash')
  })

  it('keeps the guardrails (--settings + empty setting-sources) and propagates permission_mode/model', () => {
    const args = buildClaudeArgv(
      claudeAction({
        run: 'x',
        permission_mode: 'bypassPermissions',
        model: 'sonnet',
        skill: {command: '/closeyourit-skills:triage', args: 'CYRA-1', plugin_dir: '/d'},
      }),
      guardrails,
    )
    expect(JSON.parse(args[args.indexOf('--settings') + 1])).toMatchObject(baseSettings)
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('')
    expect(args).toContain('--permission-mode')
    expect(args).toContain('bypassPermissions')
    expect(args).toContain('--model')
    expect(args).toContain('sonnet')
  })

  it('retry: the findings (part before the separator in run) are appended to the skill prompt (Finding 2)', () => {
    const args = buildClaudeArgv(
      claudeAction({
        run: composeRetryRun('# Finding\nManca il test di restart', 'Istruzione base schedulata'),
        skill: {command: '/closeyourit-skills:autopilot', args: 'CYRA-7', plugin_dir: '/d'},
      }),
      guardrails,
    )
    expect(args[0]).toBe('-p')
    expect(args[1]).toBe('/closeyourit-skills:autopilot CYRA-7\n\n# Finding\nManca il test di restart')
    // The authoritative base instruction (after the separator) does NOT enter: in skill-mode the instruction IS the slash-command.
    expect(args[1]).not.toContain('Istruzione base schedulata')
    expect(args[1]).not.toContain('# Istruzione originale autoritativa')
  })

  // The approved plan travels on the same channel as the findings (`composeSkillRun` in ticket-preflight): this is
  // the proof that it REALLY reaches the skill prompt, and that with a retry in progress the two coexist instead of
  // cancelling each other — the extraction stops at the first separator, so the order is the contract.
  it('the approved plan reaches the skill prompt, and coexists with the findings of a retry', () => {
    const plan = '# Piano approvato dal CTO (v3)\n## Analisi tecnica\nEstrarre il composable'
    const args = buildClaudeArgv(
      claudeAction({
        run: composeRetryRun(`${plan}\n\n# Finding\nManca il test`, 'Istruzione base schedulata'),
        skill: {command: '/closeyourit-skills:autopilot', args: 'CYRA-7', plugin_dir: '/d'},
      }),
      guardrails,
    )
    expect(args[1]).toContain('/closeyourit-skills:autopilot CYRA-7')
    expect(args[1]).toContain('# Piano approvato dal CTO (v3)')
    expect(args[1]).toContain('Estrarre il composable')
    expect(args[1]).toContain('# Finding\nManca il test')
    expect(args[1]).not.toContain('Istruzione base schedulata')
  })

  it('retry without args: the findings are still appended to the bare slash-command', () => {
    const args = buildClaudeArgv(
      claudeAction({
        run: composeRetryRun('# Correggi\nGate rosso', 'base'),
        skill: {command: '/closeyourit-skills:autopilot', plugin_dir: '/d'},
      }),
      guardrails,
    )
    expect(args[1]).toBe('/closeyourit-skills:autopilot\n\n# Correggi\nGate rosso')
  })

  it('non-retry run (no separator): prompt = invocation only, no finding propagated', () => {
    const args = buildClaudeArgv(
      claudeAction({run: 'testo qualunque non-retry', skill: {command: '/closeyourit-skills:triage', args: 'CYRA-1', plugin_dir: '/d'}}),
      guardrails,
    )
    expect(args[1]).toBe('/closeyourit-skills:triage CYRA-1')
  })
})

describe('composeRetryRun / extractRetryFindings', () => {
  it('round-trip: extracts only the findings (part before the separator)', () => {
    expect(extractRetryFindings(composeRetryRun('# Finding\nfix', 'istruzione base'))).toBe('# Finding\nfix')
  })

  it('run without separator → undefined (not a retry)', () => {
    expect(extractRetryFindings('prompt normale')).toBeUndefined()
  })

  it('leading separator (empty findings) → undefined (fail-safe)', () => {
    expect(extractRetryFindings(`${RETRY_FINDINGS_SEPARATOR}solo base`)).toBeUndefined()
  })
})

// CYAU-132: the FILE-TOOLS reaching the skill-mode session (`--tools`) are derived from the `allowedTools` the
// PhaseProfile DECLARES (digest twin, server twin). Invariant: the applied file-tools match EXACTLY
// the declared ones. Bash is separate — it is not a file-tool, not in the digest, always added by skill-mode to
// run the scripts (it can write files via shell; the OS-level sandbox confines it, CYAU-67, not the tool list).
// The write file-tool vector of read phases (Edit/Write) was already closed by CYAU-119; these tests lock the
// declared↔applied match ON FILE-TOOLS for ALL executable phases.
describe('CYAU-132: skill-mode session file-tools derive from the profile (declared == applied)', () => {
  const ALL_FILE_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']
  const WRITE_FILE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']

  it('read phases (restricted allowedTools): the applied file-tools match EXACTLY the declared ones, +Bash', () => {
    for (const phase of ['triage', 'planner'] as const) {
      const profile = phaseProfile(phase)!
      const applied = skillTools([...profile.allowedTools]).split(',')
      // Session file-tools == file-tools declared by the profile (no more, no less): no undeclared file-tool.
      expect(applied.filter((tool) => tool !== 'Bash')).toEqual([...profile.allowedTools])
      // No write file-tool (Edit/Write/...) exists in the read session: read-only is a PERMISSION, not
      // a mere instruction. (Bash can still write via shell: the OS-level sandbox confines that, CYAU-67.)
      for (const writeTool of WRITE_FILE_TOOLS) expect(applied).not.toContain(writeTool)
      // The only tool applied beyond the file-tool declaration is Bash: skills run their own scripts.
      expect(applied).toEqual([...profile.allowedTools, 'Bash'])
    }
  })

  it('write phases (empty allowedTools = no declared limit): all file-tools + Bash', () => {
    for (const phase of ['autopilot', 'closer_staging', 'closer_production'] as const) {
      const profile = phaseProfile(phase)!
      // The profile does NOT declare a limit (`[]`) → the session applies no limit: match by absence.
      expect([...profile.allowedTools]).toEqual([])
      expect(skillTools([...profile.allowedTools]).split(',')).toEqual([...ALL_FILE_TOOLS, 'Bash'])
    }
  })

  it('for EVERY executable phase every declared file-tool is applied and the only extra is Bash (never an undeclared tool)', () => {
    for (const phase of EXECUTION_PHASES) {
      const profile = phaseProfile(phase)!
      const applied = skillTools([...profile.allowedTools]).split(',')
      // Declared ⊆ applied: every file-tool declared by the profile really reaches the session.
      for (const declared of profile.allowedTools) expect(applied).toContain(declared)
      // The only difference between applied and file-tools is Bash: no other tool appears without being declared.
      expect(applied.filter((tool) => !ALL_FILE_TOOLS.includes(tool))).toEqual(['Bash'])
    }
  })
})

describe('claudeIsError', () => {
  it('JSON with is_error:true → true', () => {
    expect(claudeIsError('{"type":"result","is_error":true}')).toBe(true)
  })

  it('JSON with is_error:false → false', () => {
    expect(claudeIsError('{"type":"result","is_error":false}')).toBe(false)
  })

  it('non-JSON output with exit 0 → false (do not downgrade)', () => {
    expect(claudeIsError('ok, tutto fatto')).toBe(false)
  })

  it('JSON without is_error → false', () => {
    expect(claudeIsError('{"type":"result"}')).toBe(false)
  })
})

describe('claudeSessionCostUsd — CYAU-155', () => {
  it('result JSON: the real session spend, in dollars', () => {
    expect(claudeSessionCostUsd('{"type":"result","is_error":false,"total_cost_usd":0.42}')).toBe(0.42)
    expect(claudeSessionCostUsd('  {"total_cost_usd":0}  ')).toBe(0)
  })

  it('uninterpretable output or missing field → null, never an invented cost', () => {
    expect(claudeSessionCostUsd('ok, tutto fatto')).toBeNull()
    expect(claudeSessionCostUsd('{"type":"result"}')).toBeNull()
    expect(claudeSessionCostUsd('')).toBeNull()
    expect(claudeSessionCostUsd('[1,2]')).toBeNull()
  })

  it('absurd value (negative, non-numeric, infinite) → null: the spend cannot corrupt the tally', () => {
    expect(claudeSessionCostUsd('{"total_cost_usd":-1}')).toBeNull()
    expect(claudeSessionCostUsd('{"total_cost_usd":"cinque"}')).toBeNull()
    expect(claudeSessionCostUsd('{"total_cost_usd":1e400}')).toBeNull()
  })
})
