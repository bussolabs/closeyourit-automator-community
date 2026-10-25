import {z} from 'zod'
import {isManagedSecretEnv} from './env-capabilities'

// Playbook schema (zod validation). Union discriminated on `type` (claude|shell|codex): a field valid
// for `claude` (e.g. permission_mode) on a `shell`/`codex` action is rejected with a precise path → useful
// messages in `validate`.

/** Real permission modes of `claude -p` (build 2.1.x). NB: the literal "default" does not exist. */
export const PermissionMode = z.enum(['plan', 'acceptEdits', 'auto', 'manual', 'dontAsk', 'bypassPermissions'])

/**
 * Real sandbox modes of `codex exec` (build 0.144.x). ONLY the two that confine the agent are exposed:
 * `read-only` (safe default) and `workspace-write` (writes limited to the authorized working directory).
 * `danger-full-access` (disables the sandbox) is deliberately OMITTED: no action can configure a
 * Codex session outside the sandbox → it is the security control equivalent to the claude guardrails, native in Codex.
 * The default is `read-only` and it is ALWAYS passed to `--sandbox` (executor): the automator is thus authoritative on
 * confinement regardless of Codex's local config (`~/.codex/config.toml`), which without the flag could
 * impose a more permissive level.
 */
export const SandboxMode = z.enum(['read-only', 'workspace-write'])

/**
 * `process-group` stays available for generic scheduler actions. Ticket/skill actions instead require
 * `strong`, attested by systemd/cgroup v2 on Linux, and are rejected by the schema before the spawn if
 * they try to degrade to the PGID alone.
 */
export const ContainmentMode = z.enum(['process-group', 'strong'])

const EnvVars = z.record(z.string()).superRefine((vars, ctx) => {
  for (const key of Object.keys(vars)) {
    if (isManagedSecretEnv(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `${key} è gestito dalle capability runtime e non può essere dichiarato in env.vars`,
      })
    }
  }
})

const EnvSpec = z
  .object({
    vars: EnvVars.optional(),
  })
  .strict()

const OnFailure = z
  .object({
    type: z.literal('shell').default('shell'),
    run: z.string().min(1),
  })
  .strict()

/** Explicit configuration of an action that works ONE ticket: the other actions stay generic scheduler ones. */
const TicketTarget = z
  .object({
    project: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
    code: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'repository deve essere owner/repo'),
    needs_decision: z.boolean().default(false),
    estimated_cost: z.number().nonnegative().default(0),
    require_guidance: z.boolean().default(true),
  })
  .strict()

const baseShape = {
  description: z.string().optional(),
  schedule: z.string().min(1),
  cwd: z.string().min(1).optional(),
  timeout: z.number().int().positive().max(3600).optional(),
  containment: ContainmentMode.default('process-group'),
  enabled: z.boolean().default(true),
  env: EnvSpec.optional(),
  on_failure: OnFailure.optional(),
  catch_up: z.boolean().default(false),
  ticket: TicketTarget.optional(),
}

/**
 * Invocation of a versioned SKILL of the `closeyourit-skills` plugin (C.2): instead of an inline prompt,
 * the claude action runs a slash-command of the plugin loaded from `plugin_dir` (`claude -p /plugin:skill`).
 * `args` is ONLY the ticket code (controlled data, validated as a safe segment) — the ticket CONTENT
 * stays untrusted and is read by the skill via `cyi`, not passed in the prompt. `command` is the slash-command.
 */
const SkillInvocation = z
  .object({
    command: z.string().regex(/^\/[a-z0-9][a-z0-9:_-]*$/i, 'skill deve essere uno slash-command tipo /plugin:skill'),
    args: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'args deve essere un codice ticket sicuro').optional(),
    plugin_dir: z.string().min(1),
  })
  .strict()

const ClaudeAction = z
  .object({
    ...baseShape,
    type: z.literal('claude'),
    run: z.string().min(1),
    permission_mode: PermissionMode.optional(),
    allowed_tools: z.array(z.string().min(1)).optional(),
    model: z.string().min(1).optional(),
    /** When present, the action runs a plugin skill (skill-mode, C.2) instead of the inline `run` prompt. */
    skill: SkillInvocation.optional(),
  })
  .strict()

const ShellAction = z
  .object({
    ...baseShape,
    type: z.literal('shell'),
    run: z.string().min(1),
  })
  .strict()

const CodexAction = z
  .object({
    ...baseShape,
    type: z.literal('codex'),
    run: z.string().min(1),
    sandbox: SandboxMode.default('read-only'),
    model: z.string().min(1).optional(),
    /**
     * CYRA-921 — a machine set to work with Codex runs the phase skill with Codex, under the same guardrail
     * hooks, network allowlist and workspace-only writes as Claude (codex.ts `buildCodexSkillArgv`).
     */
    skill: SkillInvocation.optional(),
  })
  .strict()

export const ActionSchema = z.discriminatedUnion('type', [ClaudeAction, ShellAction, CodexAction])

export const PlaybookSchema = z
  .object({
    version: z.literal(1),
    actions: z
      .record(z.string().regex(/^[a-z0-9]+$/, 'il nome azione deve essere una parola [a-z0-9]'), ActionSchema)
      .refine((actions) => Object.keys(actions).length > 0, {message: "almeno un'azione richiesta"}),
  })
  .strict()
  .superRefine((playbook, context) => {
    for (const [name, action] of Object.entries(playbook.actions)) {
      if (action.ticket && !action.cwd) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['actions', name, 'cwd'],
          message: 'cwd è obbligatoria per un’azione ticket',
        })
      }
      if (action.ticket && action.type === 'shell') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['actions', name, 'type'],
          message: 'un’azione ticket deve usare un runtime agente (claude o codex) per ricevere la Guidance',
        })
      }
      const skillAction = action.type === 'claude' && action.skill !== undefined
      if ((action.ticket || skillAction) && action.containment !== 'strong') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['actions', name, 'containment'],
          message: 'containment strong è obbligatorio per azioni ticket e skill',
        })
      }
    }
  })

export type PermissionModeT = z.infer<typeof PermissionMode>
export type SandboxModeT = z.infer<typeof SandboxMode>
export type ContainmentModeT = z.infer<typeof ContainmentMode>
export type Action = z.infer<typeof ActionSchema>
export type TicketTargetT = z.infer<typeof TicketTarget>
/** `claude` branch of the union (carries permission_mode/allowed_tools/model): used by the ClaudeRuntime provider. */
export type ClaudeActionT = Extract<Action, {type: 'claude'}>
/** `codex` branch of the union (carries sandbox/model): used by the CodexRuntime provider. */
export type CodexActionT = Extract<Action, {type: 'codex'}>
export type Playbook = z.infer<typeof PlaybookSchema>
export type EnvSpecT = z.infer<typeof EnvSpec>
