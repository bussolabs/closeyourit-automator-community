import {type Action} from './schema'

// Runtime-agnostic command policy (CYAU-25): the deterministic safety net the automator applies in the
// PROCESS WRAPPER (executor.runAction), BEFORE the spawn, to EVERY action — regardless of the runtime
// (claude/codex/shell/future providers). It reproduces in TypeScript the critical protections that used to be tied
// to the claude bypass session alone (`--settings` hooks): production, destructive DB, protected branches,
// force-push. The claude hooks (assets/guardrails) and the codex sandbox remain an ADDITIONAL provider-specific
// defence for the agents' INTERNAL commands; this module is the SHARED control, so that «the same forbidden cases
// are blocked for Claude and Codex» (DoD). Pure and deterministic: same string → same decision. The heuristic is
// an INSPECTABLE keyword match (not an opaque model) — explainability is a requirement, as for the guardrails.

/** The critical protections covered (DoD: deploy, destructive DB, protected branches, force-push). */
export type PolicyViolation =
  | 'production'
  | 'destructive-db'
  | 'protected-branch'
  | 'force-push'
  | 'retired-provider'
  | 'managed-secret'

/** Outcome of the evaluation: allowed, or the first violation with its reason (audit + message to the agent). */
export interface PolicyDecision {
  allowed: boolean
  violation?: PolicyViolation
  reason?: string
}

interface Rule {
  violation: PolicyViolation
  re: RegExp
  why: string
}

// Deploy and production access (mirror of the patterns in assets/guardrails/hooks/block-production.mjs:
// a single definition of «what production is», so the wrapper and the claude hooks block the SAME cases). The IPs
// are the production/bastion hosts. Staging stays allowed; production is always forbidden.
const RETIRED_PROVIDER = new RegExp(`\\b${['dop', 'pler'].join('')}\\b`, 'i')
const PRODUCTION_RULES: Rule[] = [
  {violation: 'production', re: /\bkamal\b/i, why: 'deploy Kamal'},
  {violation: 'production', re: /RAILS_ENV\s*=\s*["']?production\b/i, why: 'RAILS_ENV production'},
  // The CloseYourIt CLI (the vault in use) is not here: a regex on the environment does not hold — see evaluateCloseYourItCli.
]

// The production of whoever installed the automator: ssh/scp/rsync towards these hosts and database URLs pointing
// at them are refused. AUTOMATOR_PRODUCTION_HOSTS (comma-separated) adds the hosts of this installation; the
// public copy ships this list empty (CYRA-918). Twin of DEFAULT_PRODUCTION_HOSTS in block-production.mjs.
const DEFAULT_PRODUCTION_HOSTS: string[] = []
const HOST_NAME = /^[A-Za-z0-9.-]+$/

/** The hosts AUTOMATOR_PRODUCTION_HOSTS adds. A malformed entry throws: dropping it would unprotect a host. */
export function extraProductionHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  const hosts = (env.AUTOMATOR_PRODUCTION_HOSTS ?? '').split(',').map((host) => host.trim()).filter((host) => host !== '')
  for (const host of hosts) {
    if (!HOST_NAME.test(host)) throw new Error(`AUTOMATOR_PRODUCTION_HOSTS: not a host name or address: ${host}`)
  }
  return hosts
}

export function productionHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  return [...DEFAULT_PRODUCTION_HOSTS, ...extraProductionHosts(env)]
}

function productionHostRules(hosts: string[]): Rule[] {
  if (hosts.length === 0) return []
  const names = hosts.map((host) => host.replaceAll('.', '\\.')).join('|')
  return [
    {violation: 'production', re: new RegExp(`\\b(?:ssh|scp|rsync)\\b[^\\n]*\\b(?:${names})\\b`, 'i'), why: 'SSH/copia verso host di produzione o bastion'},
    {violation: 'production', re: new RegExp(`(?:DATABASE_URL|QUEUE_DATABASE_URL)=\\S*(?:${names})\\b`, 'i'), why: 'DATABASE_URL verso il DB di produzione'},
  ]
}

// CYAU-112 — CloseYourIt CLI (the vault in use; the retired provider stays forbidden entirely). An environment
// denylist does NOT work here: `production` is also spelled `prod`/`prd`, it can be the environment's opaque UUID
// or come from an expansion (`-e "$E"`) — forms no list of forbidden words catches. The check is therefore a
// structured ALLOWLIST, and whatever cannot be read is denied.
const CYI_RUN = /(?:^|[\s/])(?:cyi|closeyourit)\s+run(?=\s|$)/i
const CYI_SECRETS = /(?:^|[\s/])(?:cyi|closeyourit)\s+secrets(?=\s|$)/i
/** The only forms of `cyi secrets` that do not expose a value: names (`list`) and file metadata (`assets list`). */
const CYI_SECRETS_READ_ONLY = /(?:^|[\s/])(?:cyi|closeyourit)\s+secrets\s+(?:assets\s+)?list(?=\s|$)/i
// CYAU-174 — twin of the rule in assets/guardrails/hooks/block-production.mjs. A ticket's status is
// decided by ONE place only, the server, when it registers the delivery: there were three hands on the
// same lever and none knew about the others. `statuses` (the list), `show`, `list` and `comment` stay.
const CYI_TICKETS_VIETATI = /(?:^|[\s/])(?:cyi|closeyourit)\s+tickets\s+(?:status|update|approve)(?=\s|$)/i
/** The environment flag and its literal value; the left anchor keeps `-e` from reading `--environment`. */
const CYI_ENVIRONMENT_FLAG = /(?:^|\s)(?:-e|--environment)[=\s]*(["']?)([^\s"']*)\1(?=\s|$)/i
/** Environments whose secrets the service account is authorized for; any other value — ids included — is denied. */
const CYI_ALLOWED_ENVIRONMENTS = new Set(['development', 'dev', 'test', 'staging'])

// Intrinsically destructive SQL/DB tasks (DoD «destructive DB»): a ticket-worker must NEVER wipe schemas or data
// in bulk. For the claude session the destructive DB is already covered by the global backstop
// ~/.claude/hooks/block-destructive.py; here it is brought into the wrapper so it ALSO applies to shell and codex.
// Every rule requires an SQL CONTEXT (table keyword/FROM/identifier), not the bare word: `truncate` is also the
// UNIX coreutils command (`truncate -s 0 log`) and the Ruby method `String#truncate`, `drop`/`delete` are common
// words → avoid false positives on legitimate commands. The WHERE lookahead is anchored to the same statement
// (`[^;&|]*`, it stops at command separators): a WHERE in a later chained command must NOT neutralize the block
// of a DELETE FROM that is genuinely unrestricted.
const DESTRUCTIVE_DB_RULES: Rule[] = [
  {violation: 'destructive-db', re: /\bDROP\s+(?:TABLE|DATABASE|SCHEMA)\b/i, why: 'DROP TABLE/DATABASE/SCHEMA'},
  {violation: 'destructive-db', re: /\bTRUNCATE\s+(?:TABLE\s+)?["'`]?\w/i, why: 'TRUNCATE di una tabella'},
  {violation: 'destructive-db', re: /\bDELETE\s+FROM\b(?![^;&|]*\bWHERE\b)/i, why: 'DELETE FROM senza WHERE (cancellazione in blocco)'},
  {violation: 'destructive-db', re: /\bdb:(?:drop|reset|purge|schema:load)\b/i, why: 'db:drop|reset|purge|schema:load (cancella/sovrascrive il DB)'},
]

// git push: fail-closed allowlist shared with the Claude guardrail. Every segment that runs a push must use the
// literal token `git` and a single ticket/… refspec; force, mappings, wrappers, paths and expansions stay forbidden.
const IS_PUSH = /(?:^|[\s/])git\b[\s\S]*\bpush\b/i
const IS_GIT_OR_PUSH = /(?:^|[\s/])git\b|\bpush\b/i
const FORCE = /(?:^|\s)(?:-f|--force|--force-with-lease)(?:\s|=|$)/i
const FORCE_REFSPEC = /(?:^|\s)\+\S+/
const PROTECTED_BRANCH = /(?:^|[\s:/@])(?:main|master|develop|development|staging|production|prod)(?:$|[\s:^~])/i
const RELEASE_BRANCH = /(?:^|[\s:/])(?:release|hotfix)\//i
const SAFE_PUSH = /^git\s+push(?:\s+(?:-u|--set-upstream))?\s+origin\s+ticket\/[A-Za-z0-9][A-Za-z0-9._\/-]*\s*$/i
// Git reads (CYAU-134). Before, only `git status` and `git rev-parse HEAD|--show-toplevel` passed, so an agent
// could not even read its own history: `git log`, `git diff` and `git rev-parse <ref>` were denied, and with them
// the chance to understand what it had already done. They are all subcommands that do NOT write to refs, the
// index or the worktree; `branch`/`tag`/`remote` get in only in their listing form (never `-d`/`-D`/`add`), and
// `--output`/`-o` stays out because it would make `diff`/`format-patch` write a file.
const READ_ONLY_GIT_SUBCOMMAND =
  /^git\s+(?:status|log|diff|show|blame|describe|shortlog|whatchanged|ls-files|ls-tree|cat-file|rev-list|rev-parse|merge-base|symbolic-ref|check-ignore|count-objects|(?:branch|tag)(?=\s+(?:-l\b|--list\b|-a\b|-r\b|-v\b|--verbose\b|--contains\b|--show-current\b)|\s*$)|remote(?=\s+(?:-v\b|--verbose\b|show\b)|\s*$)|config\s+--get)\b/i
const GIT_WRITES_A_FILE = /(?:^|\s)(?:--output(?:=|\s)|-o\s)/i
const SAFE_GIT_READ = (segment: string): boolean =>
  READ_ONLY_GIT_SUBCOMMAND.test(segment) && !GIT_WRITES_A_FILE.test(segment)
// Read-only filesystem commands: their first token is literal (cannot be built by an expansion) and none of them
// runs anything else. Only inside these are PATH metacharacters allowed — see PATH_GLOB.
const READ_ONLY_FS_COMMAND = /^(?:ls|find|grep|egrep|fgrep|rg|cat|head|tail|wc|file|stat|tree|du|basename|dirname|realpath)\b/i
// Expansions that can BUILD a token (`$g $p` → `git push`, `{git,push}`) stay forbidden everywhere: they are the
// reason this gate exists. Path metacharacters (`* ? [] ~`) instead only expand into existing file names —
// separating them is what gives `find -name "*.ts"` back to an agent that needs to find its way around.
const DYNAMIC_SHELL_SYNTAX = /[$`{}]/u
const PATH_GLOB = /[*?\[\]~]/u
const OBFUSCATING_SHELL_SYNTAX = /[\\'"]/u
const GIT_OR_PUSH = /\b(?:git|push)\b/i

function shellSegments(command: string): string[] {
  const segments: string[] = []
  let current = ''
  let quote: string | null = null
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]
    if (char === '\\' && i + 1 < command.length) {
      current += char + command[++i]
    } else if (quote) {
      current += char
      if (char === quote) quote = null
    } else if (char === "'" || char === '"') {
      quote = char
      current += char
    } else if (char === ';' || char === '\n' || (char === '&' && command[i + 1] === '&') || (char === '|' && command[i + 1] === '|')) {
      if (current.trim()) segments.push(current)
      current = ''
      if ((char === '&' || char === '|') && command[i + 1] === char) i += 1
    } else current += char
  }
  if (current.trim()) segments.push(current)
  return segments
}

function normalizeShell(command: string): string {
  let normalized = ''
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]
    if (char === '\\' && i + 1 < command.length) normalized += command[++i]
    else if (char === "'" || char === '"') {
      const quote = char
      while (++i < command.length && command[i] !== quote) {
        if (quote === '"' && command[i] === '\\' && i + 1 < command.length) normalized += command[++i]
        else normalized += command[i]
      }
    } else normalized += char
  }
  return normalized
}

function deny(violation: PolicyViolation, why: string): PolicyDecision {
  return {
    allowed: false,
    violation,
    reason:
      `command policy [${violation}]: comando bloccato (${why}). L'agente ticket-worker resta su development/test ` +
      'e sul branch ticket/… — mai produzione, dati o push non consentiti.',
  }
}

/**
 * Environment declared to a `cyi run` invocation inside an already normalized SEGMENT. Only the span between the
 * verb and the `--` that hands over to the hosted command is read: past that boundary the arguments belong to the
 * other command, and reading them would confuse `cyi run -e development -- grep -e production note.txt` with a
 * request for production secrets. `null` = no readable environment (flag missing, value from an expansion): denied.
 */
function cyiRunEnvironment(segment: string): string | null {
  const invocation = CYI_RUN.exec(segment)
  if (invocation === null) return null
  const afterVerb = segment.slice(invocation.index + invocation[0].length)
  const ownFlags = afterVerb.split(/\s--(?=\s|$)/)[0]
  const environment = CYI_ENVIRONMENT_FLAG.exec(ownFlags)
  return environment === null ? null : environment[2].toLowerCase()
}

/**
 * Secrets of the vault in use, evaluated per segment. Two prohibitions:
 * - `cyi run` outside the authorized environments: it injects the values into the process environment;
 * - the whole `cyi secrets` family except `list`/`assets list`: `get`/`download` print or write the values,
 *   `set`/`delete`/`import` mutate them, and `sync`/`assets download` do not even have an environment flag — that
 *   is, they touch production without ever naming it, which is exactly what a rule on the environment cannot see.
 * Known limit: if an authorized environment were renamed like a production one, the string would no longer be
 * enough to tell them apart. The defence that remains is server-side — the service account is not authorized for
 * production secrets — and this module is the deterministic net in front of it, not a replacement.
 */
function evaluateCloseYourItCli(segment: string): PolicyDecision {
  if (CYI_TICKETS_VIETATI.test(segment)) {
    return deny('managed-secret', 'lo stato del ticket lo decide il server quando registra la consegna, non l agente')
  }

  if (CYI_SECRETS.test(segment) && !CYI_SECRETS_READ_ONLY.test(segment)) {
    return deny('managed-secret', 'cyi secrets espone o modifica valori: all agente resta il solo elenco dei nomi')
  }

  if (CYI_RUN.test(segment)) {
    const environment = cyiRunEnvironment(segment)
    if (environment === null || !CYI_ALLOWED_ENVIRONMENTS.has(environment)) {
      return deny('production', 'cyi run inietta i segreti di un ambiente non autorizzato al service account')
    }
  }

  return {allowed: true}
}

/**
 * Evaluates a shell COMMAND against the critical protections. Order: production → destructive DB → force-push →
 * protected branch (the first violation wins; force-push takes precedence over protected branch). Fail-open on an
 * empty/whitespace-only string (no command to evaluate). Pure: no I/O, no dependency on the runtime.
 */
export function evaluateCommand(command: string): PolicyDecision {
  if (command.trim() === '') return {allowed: true}

  // The production and DB rules are ALSO evaluated on the form reassembled from quotes/backslashes: the claude
  // hook has always normalized, this module did not — and `cy'i' run -e production` passed the wrapper while
  // being blocked in the session. «The same forbidden cases» requires the same view of the command (CYAU-112).
  const normalized = normalizeShell(command)
  const forms = normalized === command ? [command] : [command, normalized]

  if (forms.some((form) => RETIRED_PROVIDER.test(form))) return deny('retired-provider', 'provider di secret ritirato')

  for (const rule of [...PRODUCTION_RULES, ...productionHostRules(productionHosts()), ...DESTRUCTIVE_DB_RULES]) {
    if (forms.some((form) => rule.re.test(form))) return deny(rule.violation, rule.why)
  }

  const segments = shellSegments(command)
    .map((raw) => ({original: raw.trim(), normalized: normalizeShell(raw).trim()}))
  // Vault in use: evaluated per SEGMENT and on the normalized form, before the expansion gate — so a
  // `cyi run -e "$E"` is denied for what it is (secrets of an unreadable environment) and not as a Git command.
  for (const {normalized: segment} of segments) {
    const vault = evaluateCloseYourItCli(segment)
    if (!vault.allowed) return vault
  }
  // Expansions and substitutions can build the launcher and the verb across several segments (`$g $p`):
  // they are therefore always forbidden, fail-closed. Quoting/escaping is forbidden when it obfuscates a git/push marker.
  if (segments.some(({original}) => DYNAMIC_SHELL_SYNTAX.test(original)) ||
      segments.some(({original, normalized}) => OBFUSCATING_SHELL_SYNTAX.test(original) && GIT_OR_PUSH.test(normalized))) {
    return deny('protected-branch', 'comando Git dinamico o offuscato non consentito')
  }
  // A path glob expands into existing file names, not into a verb: it is allowed only inside read-only
  // filesystem commands, where the first token is literal and nothing gets executed.
  if (segments.some(({original, normalized}) => PATH_GLOB.test(original) && !READ_ONLY_FS_COMMAND.test(normalized))) {
    return deny('protected-branch', 'espansione di path ammessa solo nei comandi di sola lettura del filesystem')
  }
  const pushes = segments
    .filter(({normalized}) => IS_PUSH.test(normalized))
  const gitLike = segments.filter(({normalized}) => IS_GIT_OR_PUSH.test(normalized))
  for (const push of pushes) {
    if (FORCE.test(push.normalized) || FORCE_REFSPEC.test(push.normalized)) return deny('force-push', 'force-push vietato')
    if (PROTECTED_BRANCH.test(push.normalized) || RELEASE_BRANCH.test(push.normalized)) {
      return deny('protected-branch', 'push su branch protetto (main/master/develop/staging/production/release/hotfix)')
    }
    // Detection uses the normalized form so as not to miss obfuscated pushes, but the allowlist
    // uses the original segment: only the literal token `git` can run a push.
    if (!SAFE_PUSH.test(push.original)) {
      return deny('protected-branch', 'push non riconducibile a un singolo refspec ticket/… sicuro')
    }
  }
  // A push stays the ENTIRE authorized action (never chained). Reads, which do not touch refs/index/worktree,
  // may instead sit next to other commands: `git status && git log` is exactly what it takes to understand how
  // far a piece of work has got, and denying it protects nothing.
  if (pushes.length > 0) {
    if (segments.length !== 1 || !SAFE_PUSH.test(segments[0].original)) {
      return deny('protected-branch', 'il push deve coincidere con l intera azione autorizzata')
    }
  } else if (gitLike.some(({original}) => !SAFE_GIT_READ(original))) {
    return deny('protected-branch', 'il comando Git deve essere una lettura consentita o il push autorizzato')
  }
  return {allowed: true}
}

/**
 * Evaluates a playbook ACTION by applying the policy to its INSPECTABLE commands:
 * - the `run` of a **shell** action (command executed directly by Automator);
 * - any `on_failure.run` (always shell) of ANY action;
 * The `run` of a claude/codex action is a PROMPT, not a command: it is NOT evaluated (a prompt that mentions
 * «deploy» or «push» is legitimate). The INTERNAL commands of those agents are confined by the claude hooks / the
 * codex sandbox (additional provider-specific defence).
 */
export function evaluateAction(action: Action): PolicyDecision {
  if (action.type === 'shell') {
    const decision = evaluateCommand(action.run)
    if (!decision.allowed) return decision
  }

  if (action.on_failure) {
    const decision = evaluateCommand(action.on_failure.run)
    if (!decision.allowed) return decision
  }

  return {allowed: true}
}
