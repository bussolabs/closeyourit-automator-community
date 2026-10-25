import * as fs from 'node:fs'
import * as path from 'node:path'
import {stateDir} from './paths'
import {redactSecrets} from './secret-redaction'

// CYAU-202 — "a failed update is visible on CloseYourIt".
//
// Since the update starts by itself, nobody reads its outcome any more: it stays in the host journal,
// which one reaches only by logging into the server. The command therefore leaves it written here and the beat carries it to the
// panel, together with the other reasons why a machine is stopped.
//
// A successful update clears the warning: a no longer current reason is worse than no reason.

const OUTCOME_FILE = 'update-outcome.json'

/** Outcome the beat attaches as `last_stops`. `state` stays a value already known to the server. */
export interface UpdateFailureStop {
  action: 'update'
  state: 'blocked'
  reason: string
}

interface OutcomeRecord {
  version: 1
  outcome: string
  reason: string
  at: string
}

export function updateOutcomePath(): string {
  return path.join(stateDir(), OUTCOME_FILE)
}

/** Outcomes that leave the machine NOT updated and that someone must look at. */
const FAILURE_OUTCOMES = new Set(['failed', 'rolled-back', 'incompatible'])

/** Outcomes that say "the machine is on the right version": any previous warning is no longer needed. */
const HEALTHY_OUTCOMES = new Set(['updated', 'up-to-date'])

function describe(outcome: string, reason: string, fromVersion: string | null, toVersion: string | null): string {
  const target = toVersion === null ? 'una versione nuova' : `la versione ${toVersion}`
  if (outcome === 'rolled-back') {
    const previous = fromVersion === null ? 'quella di prima' : `la ${fromVersion}`
    return `aggiornamento a ${target} non riuscito: la macchina è tornata a ${previous} (${reason})`
  }
  if (outcome === 'incompatible') return `aggiornamento non applicabile: ${reason}`
  return `aggiornamento a ${target} non riuscito: ${reason}`
}

/**
 * Records the outcome of the last update. A healthy outcome clears the warning; `busy` touches nothing — it is not
 * a failed attempt, and clearing there would switch off a still valid warning.
 */
export function recordUpdateOutcome(result: {
  outcome: string
  reason: string
  fromVersion: string | null
  toVersion: string | null
}, now: Date = new Date()): void {
  const file = updateOutcomePath()
  if (HEALTHY_OUTCOMES.has(result.outcome)) {
    fs.rmSync(file, {force: true})
    return
  }
  if (!FAILURE_OUTCOMES.has(result.outcome)) return

  const record: OutcomeRecord = {
    version: 1,
    outcome: result.outcome,
    // The reason carries command and network messages: it is redacted BEFORE touching the disk, not only before
    // sending.
    reason: redactSecrets(describe(result.outcome, result.reason, result.fromVersion, result.toVersion)),
    at: now.toISOString(),
  }
  fs.mkdirSync(path.dirname(file), {recursive: true})
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`)
}

/**
 * The warning to attach to the beat, or `null` if the last update went well. An unreadable file counts
 * as missing: the beat must go out anyway, otherwise a corrupt warning would switch off the rest too.
 */
export function readUpdateFailure(): UpdateFailureStop | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(updateOutcomePath(), 'utf8')) as Partial<OutcomeRecord>
    if (typeof parsed?.reason !== 'string' || parsed.reason === '') return null
    return {action: 'update', state: 'blocked', reason: parsed.reason}
  } catch {
    return null
  }
}
