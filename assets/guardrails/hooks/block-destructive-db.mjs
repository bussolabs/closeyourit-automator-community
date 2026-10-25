// Guardrail PreToolUse/Bash — blocca operazioni DB distruttive prima dell'esecuzione.
// Installato da closeyourit-automator e iniettato in OGNI sessione Claude via --settings.
import {fileURLToPath} from 'node:url'

const PATTERNS = [
  {re: /\bDROP\s+(?:TABLE|DATABASE|SCHEMA)\b/i, why: 'DROP TABLE/DATABASE/SCHEMA'},
  {re: /\bTRUNCATE\s+(?:TABLE\s+)?["'`]?\w/i, why: 'TRUNCATE di una tabella'},
  {re: /\bDELETE\s+FROM\b(?![^;&|]*\bWHERE\b)/i, why: 'DELETE FROM senza WHERE'},
  {re: /\bdb:(?:drop|reset|purge|schema:load)\b/i, why: 'task Rails distruttivo'},
]

/** @param {unknown} command Il comando Bash proposto. @returns {{blocked: boolean, reason?: string}} */
export function evaluate(command) {
  if (typeof command !== 'string') return {blocked: false}
  command = normalizeShell(command)
  for (const pattern of PATTERNS) {
    if (pattern.re.test(command)) {
      return {
        blocked: true,
        reason: `guardrail database: comando bloccato (${pattern.why}). Le operazioni distruttive richiedono esecuzione umana esplicita.`,
      }
    }
  }

  return {blocked: false}
}

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

export async function main() {
  let payload
  try {
    payload = JSON.parse(await readStdin())
  } catch {
    return blockInvalidPayload()
  }

  if (payload?.tool_name !== 'Bash' || typeof payload?.tool_input?.command !== 'string' || payload.tool_input.command.trim() === '') {
    return blockInvalidPayload()
  }

  const {blocked, reason} = evaluate(payload?.tool_input?.command)
  if (blocked) {
    process.stderr.write(`${reason}\n`)
    return process.exit(2)
  }

  return process.exit(0)
}

function blockInvalidPayload() {
  process.stderr.write('guardrail database: payload PreToolUse non valido; operazione bloccata per sicurezza.\n')
  return process.exit(2)
}

if (import.meta.url.startsWith('file:') && process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void main()
