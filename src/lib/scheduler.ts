import {type Action, type Playbook} from './schema'
import {nextFire, type Parsed, parseSchedule} from './schedule'
import {type ActionState, type State} from './state'
import {AutomatorError} from '../errors/error-codes'

export interface DueDecision {
  due: boolean // run now
  seed: boolean // write last_run=now WITHOUT running (baseline on first encounter)
  reason: string
}

/**
 * Pure decision (no real clock/IO): is the action "due"?
 * - interval: due if `now - last_run >= ms`.
 * - cron: due if the next fire after last_run is ≤ now (`nextFire(last_run) ≤ now`).
 * First run: catch_up ? run immediately (bootstrap) : seed the baseline (last_run=now, no exec).
 * Runs missed while the daemon was down → coalesce into ONE fire (after the exec last_run=now).
 */
export function computeDue(parsed: Parsed, st: ActionState | undefined, now: Date, catchUp: boolean): DueDecision {
  const lastRun = st?.last_run ? new Date(st.last_run) : null

  if (!lastRun) {
    return catchUp
      ? {due: true, seed: false, reason: 'primo run (catch_up)'}
      : {due: false, seed: true, reason: 'baseline seminato'}
  }

  if (parsed.kind === 'interval') {
    const elapsed = now.getTime() - lastRun.getTime()
    return elapsed >= parsed.ms
      ? {due: true, seed: false, reason: `intervallo scaduto (${elapsed}ms ≥ ${parsed.ms}ms)`}
      : {due: false, seed: false, reason: `intervallo non ancora scaduto (${elapsed}ms < ${parsed.ms}ms)`}
  }

  const next = nextFire(parsed, lastRun, null)
  return next && next.getTime() <= now.getTime()
    ? {due: true, seed: false, reason: `fire ${next.toISOString()} ≤ now`}
    : {due: false, seed: false, reason: 'nessun fire dopo last_run entro now'}
}

export interface SelectedAction {
  name: string
  action: Action
  decision: DueDecision
}

export interface SelectResult {
  due: SelectedAction[] // actions to run now
  seed: SelectedAction[] // actions to seed (baseline, without running)
  errors: Array<{name: string; message: string}> // unparsable schedules → excluded
}

/** Selects due/seed actions from the playbook, skipping disabled ones and those with an invalid schedule. */
export function selectDue(playbook: Playbook, state: State, now: Date): SelectResult {
  const result: SelectResult = {due: [], seed: [], errors: []}

  for (const [name, action] of Object.entries(playbook.actions)) {
    if (!action.enabled) continue

    let parsed: Parsed
    try {
      parsed = parseSchedule(action.schedule)
    } catch (error) {
      const message = error instanceof AutomatorError ? error.message : String(error)
      result.errors.push({name, message})
      continue
    }

    const decision = computeDue(parsed, state.actions[name], now, action.catch_up)
    if (decision.due) result.due.push({name, action, decision})
    else if (decision.seed) result.seed.push({name, action, decision})
  }

  return result
}
