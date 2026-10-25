// PreToolUse/Bash guardrail — blocks the commands that connect to or mutate production.
// Staging is allowed: the service account is authorized for the staging secrets server-side (CYAU-103).
// Installed by closeyourit-automator (outside the repos) and injected into the claude session via --settings
// Hook contract: reads the tool input JSON on stdin; exit 2 = block, exit 0 = allow.
import {fileURLToPath} from 'node:url'

const PATTERNS = [
  {re: new RegExp(`\\b${['dop', 'pler'].join('')}\\b`, 'i'), why: 'provider di secret ritirato'},
  {re: /\bkamal\b/i, why: 'deploy Kamal'},
  {re: /RAILS_ENV\s*=\s*["']?production\b/i, why: 'RAILS_ENV production'},
  // The CloseYourIt CLI is not here: no regex on the environment holds — see evaluateCloseYourItCli (CYAU-112).
]

// The production of whoever installed the automator: ssh/scp/rsync towards these hosts and database URLs
// pointing at them are refused. The installer appends AUTOMATOR_PRODUCTION_HOSTS through `--production-hosts`;
// the public copy ships this list empty (CYRA-918). Twin of DEFAULT_PRODUCTION_HOSTS in src/lib/command-policy.ts.
const DEFAULT_PRODUCTION_HOSTS = []
const HOST_NAME = /^[A-Za-z0-9.-]+$/

/** Extra production hosts from `--production-hosts a,b`. A malformed entry throws: dropping it would unprotect a host. */
export function productionHostsFromArgs(args) {
  const index = args.indexOf('--production-hosts')
  if (index === -1) return []
  const hosts = String(args[index + 1] ?? '').split(',').map((host) => host.trim()).filter((host) => host !== '')
  for (const host of hosts) {
    if (!HOST_NAME.test(host)) throw new Error(`--production-hosts: not a host name or address: ${host}`)
  }
  return hosts
}

function hostPatterns(hosts) {
  if (hosts.length === 0) return []
  const names = hosts.map((host) => host.replace(/\./g, '\\.')).join('|')
  return [
    {re: new RegExp(`\\b(?:ssh|scp|rsync)\\b[^\\n]*\\b(?:${names})\\b`, 'i'), why: 'SSH/copia verso host di produzione o bastion'},
    {re: new RegExp(`(?:DATABASE_URL|QUEUE_DATABASE_URL)=\\S*(?:${names})\\b`, 'i'), why: 'DATABASE_URL verso il DB di produzione'},
  ]
}

// CYAU-112 — CloseYourIt CLI (the vault in use), structural mirror of src/lib/command-policy.ts. An environment
// denylist does not hold: `production` is also spelled `prod`/`prd`, it can be the environment's opaque UUID or
// come from an expansion (`-e "$E"`). The check is therefore an ALLOWLIST, and whatever cannot be read is denied.
// `secrets sync` and `secrets assets download` do not even have an environment flag: they touch production
// without naming it, so of the `secrets` family only the list of names stays allowed.
const CYI_RUN = /(?:^|[\s/])(?:cyi|closeyourit)\s+run(?=\s|$)/i
const CYI_SECRETS = /(?:^|[\s/])(?:cyi|closeyourit)\s+secrets(?=\s|$)/i
const CYI_SECRETS_READ_ONLY = /(?:^|[\s/])(?:cyi|closeyourit)\s+secrets\s+(?:assets\s+)?list(?=\s|$)/i
const CYI_ENVIRONMENT_FLAG = /(?:^|\s)(?:-e|--environment)[=\s]*(["']?)([^\s"']*)\1(?=\s|$)/i
// CYAU-174 — a ticket's status is decided by ONE place only, the server, when it registers the delivery.
// The agent does not move it and does not approve its own work: there were three hands on the same lever,
// and none knew about the others. What it must be able to do stays allowed: reading the list of statuses
// (`statuses`), reading the ticket (`show`, `list`) and writing a comment on it.
const CYI_TICKETS_VIETATI = /(?:^|[\s/])(?:cyi|closeyourit)\s+tickets\s+(?:status|update|approve)(?=\s|$)/i
const CYI_ALLOWED_ENVIRONMENTS = new Set(['development', 'dev', 'test', 'staging'])

/** Environment of a `cyi run` invocation: read only between the verb and the `--` that hands over to the hosted command. */
function cyiRunEnvironment(segment) {
  const invocation = CYI_RUN.exec(segment)
  if (invocation === null) return null
  const ownFlags = segment.slice(invocation.index + invocation[0].length).split(/\s--(?=\s|$)/)[0]
  const environment = CYI_ENVIRONMENT_FLAG.exec(ownFlags)
  return environment === null ? null : environment[2].toLowerCase()
}

/** @param {string} segment A simple command, already normalized. @returns {{blocked: boolean, why?: string}} */
function evaluateCloseYourItCli(segment) {
  if (CYI_TICKETS_VIETATI.test(segment)) {
    return {blocked: true, why: 'lo stato del ticket lo decide il server quando registra la consegna, non l agente'}
  }
  if (CYI_SECRETS.test(segment) && !CYI_SECRETS_READ_ONLY.test(segment)) {
    return {blocked: true, why: 'cyi secrets espone o modifica valori: all agente resta il solo elenco dei nomi'}
  }
  if (CYI_RUN.test(segment)) {
    const environment = cyiRunEnvironment(segment)
    if (environment === null || !CYI_ALLOWED_ENVIRONMENTS.has(environment)) {
      return {blocked: true, why: 'cyi run inietta i segreti di un ambiente non autorizzato al service account'}
    }
  }
  return {blocked: false}
}

/** Splits on command separators: the vault is evaluated per invocation, not on the whole line. */
function commandSegments(command) {
  return command.split(/;|\n|&&|\|\||[&|]/).filter((segment) => segment.trim() !== '')
}

/** @param {unknown} command The proposed Bash command. @returns {{blocked: boolean, reason?: string}} */
export function evaluate(command, productionHosts = DEFAULT_PRODUCTION_HOSTS) {
  if (typeof command !== 'string') return {blocked: false}
  command = normalizeShell(command)
  const reason = (why) =>
    `guardrail no-produzione: comando bloccato (${why}). L'agente ticket-worker non può connettersi alla produzione; gli altri ambienti restano consentiti.`

  for (const p of [...PATTERNS, ...hostPatterns(productionHosts)]) {
    if (p.re.test(command)) return {blocked: true, reason: reason(p.why)}
  }

  for (const segment of commandSegments(command)) {
    const vault = evaluateCloseYourItCli(segment)
    if (vault.blocked) return {blocked: true, reason: reason(vault.why)}
  }

  return {blocked: false}
}

// Reassembles shell words concatenated through quotes/backslashes (`ka''mal`, `db:dro\"p`). It is deliberately
// conservative: it serves to recognise forbidden semantics, not to execute or expand the command.
function normalizeShell(command) {
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

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

export async function main(args = process.argv.slice(2)) {
  let productionHosts
  try {
    productionHosts = [...DEFAULT_PRODUCTION_HOSTS, ...productionHostsFromArgs(args)]
  } catch (error) {
    process.stderr.write(`guardrail no-produzione: ${error.message}; operazione bloccata.\n`)
    return process.exit(2)
  }
  let payload
  try {
    payload = JSON.parse(await readStdin())
  } catch {
    return blockInvalidPayload()
  }

  if (payload?.tool_name !== 'Bash' || typeof payload?.tool_input?.command !== 'string' || payload.tool_input.command.trim() === '') {
    return blockInvalidPayload()
  }

  const {blocked, reason} = evaluate(payload?.tool_input?.command, productionHosts)
  if (blocked) {
    process.stderr.write(`${reason}\n`)
    return process.exit(2)
  }

  return process.exit(0)
}

function blockInvalidPayload() {
  process.stderr.write('guardrail no-produzione: payload PreToolUse non valido; operazione bloccata.\n')
  return process.exit(2)
}

if (import.meta.url.startsWith('file:') && process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void main()
