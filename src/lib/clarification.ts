import {z} from 'zod'
import {type RunPhase} from './state-machine'
import {type CommandRunner, defaultRunner} from './publish'
import {AutomatorError, ErrorCodes} from '../errors/error-codes'

// Handling clarifications without blocking the queue (CYAU-22). An ambiguous ticket must be able to WAIT for an answer
// while the machine goes on with other work: when an indispensable functional decision is missing, the agent
// posts a simple question, RELEASES the slot and the queue continues; a later answer makes the ticket
// workable again; after TWO cycles without a useful answer it escalates (human intervention needed, a third
// round is not opened).
//
// PURE and DETERMINISTIC module in the deciding part (no randomness): same state → same decision, so
// the gate is repeatable and auditable. It runs nothing — posting the comment, removing the worktree and releasing
// the lease belong to the orchestrator (as `cycle` does not run implementation/review): here live
//  1. the READ — `readClarificationState` asks the SYSTEM for the state (`cyi tickets clarifications`) and
//     `parseSystemClarificationState` judges it with the `agent-clarification/v1` contract;
//  2. the GATE — `decideClarification` decides the action (proceed/resume/ask/wait/escalate) from the state + whether
//     a decision is missing + the number of cycles, making explicit whether the ticket is workable NOW and whether the slot must be released.

/**
 * CYRA-628 — the state asked of the SYSTEM, the only one that really knows it.
 *
 * Reading it from the comments meant guessing it: it was enough for the system itself to write any
 * line — "report updated to version 2" — for it to be read as an answer and
 * the ticket to restart without anyone having answered. The archive, meanwhile, kept saying
 * "waiting": two parts of the same product told different stories, and the one that
 * knew less decided.
 *
 * CYAU-189 — the fallback to comments is gone. It was the third copy of the same rule (server, skill,
 * automator): a regex copied by hand that a reformatted comment was enough to fool, and that diverged
 * on its own. Now the only source is the endpoint; a machine with the old CLI reads `unreadable` and WAITS,
 * which is the only honest answer when asking did not succeed.
 */
export function readClarificationState(
  ticket: string,
  project: string,
  run: CommandRunner = defaultRunner,
): ClarificationStatus {
  const outcome = run('cyi', ['tickets', 'clarifications', ticket, '-p', project, '--json'])
  if (outcome.status !== 0) return illeggibile()
  return parseSystemClarificationState(outcome.stdout) ?? illeggibile()
}

/** The state when reading it failed: it counts as waiting, never as "workable". */
function illeggibile(): ClarificationStatus {
  return {state: 'unreadable', cycles: 0, hasReply: false, source: 'unreadable'}
}

/** At most three questions per round (`agent-clarification/v1` contract: `rounds[].questions` is 1..3). */
export const MAX_QUESTIONS = 3

/**
 * The states the `agent-clarification/v1` contract allows on the wire. `unreadable` is NOT among them: it is the
 * local CYRA-628 signal "I could not ask", not something the server can declare.
 */
export const CLARIFICATION_WIRE_STATES = ['ready', 'waiting', 'escalated'] as const
export type ClarificationWireState = (typeof CLARIFICATION_WIRE_STATES)[number]

/**
 * The clarification state as the gate sees it: the contract's ones plus `unreadable` (CYRA-628), which is not
 * guessed — it counts as waiting, never as "workable".
 */
export const CLARIFICATION_STATES = [...CLARIFICATION_WIRE_STATES, 'unreadable'] as const
export type ClarificationState = (typeof CLARIFICATION_STATES)[number]

// The contract's `format: date-time`, i.e. RFC 3339 as the canonical validator judges it (ajv-formats in full
// mode): a real date — no 30 February — `T` or space separator, upper or lower case, mandatory offset (`Z`
// or ±hh:mm, even without the colon), leap second allowed only at the end of the UTC day.
//
// It is rebuilt here because ajv is a dev dependency and cannot enter the product. Being looser
// would mean accepting an answer the contract rejects; stricter, rejecting one the
// server considers valid. The parity in both directions is proven in `contract-agent-clarification.test.ts`, where
// the format probes are derived from the schema and ajv gives the expected verdict.
const DATA_DEL_CONTRATTO = /^(\d\d\d\d)-(\d\d)-(\d\d)$/
const ORA_DEL_CONTRATTO = /^(\d\d):(\d\d):(\d\d(?:\.\d+)?)(z|([+-])(\d\d)(?::?(\d\d))?)$/i
const SEPARATORE_DATA_ORA = /t|\s/i
const GIORNI_DEL_MESE = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

function annoBisestile(anno: number): boolean {
  return anno % 4 === 0 && (anno % 100 !== 0 || anno % 400 === 0)
}

function dataDelContratto(raw: string): boolean {
  const parti = DATA_DEL_CONTRATTO.exec(raw)
  if (!parti) return false
  const anno = Number(parti[1])
  const mese = Number(parti[2])
  const giorno = Number(parti[3])
  return (
    mese >= 1 && mese <= 12 && giorno >= 1 &&
    giorno <= (mese === 2 && annoBisestile(anno) ? 29 : GIORNI_DEL_MESE[mese])
  )
}

function oraDelContratto(raw: string): boolean {
  const parti = ORA_DEL_CONTRATTO.exec(raw)
  if (!parti) return false
  const ore = Number(parti[1])
  const minuti = Number(parti[2])
  const secondi = Number(parti[3])
  const segnoFuso = parti[5] === '-' ? -1 : 1
  const oreFuso = Number(parti[6] ?? 0)
  const minutiFuso = Number(parti[7] ?? 0)
  if (oreFuso > 23 || minutiFuso > 59) return false
  if (ore <= 23 && minuti <= 59 && secondi < 60) return true

  // Leap second: allowed only if in UTC that instant is the last minute of the day.
  const minutiUtc = minuti - minutiFuso * segnoFuso
  const oreUtc = ore - oreFuso * segnoFuso - (minutiUtc < 0 ? 1 : 0)
  return (oreUtc === 23 || oreUtc === -1) && (minutiUtc === 59 || minutiUtc === -1) && secondi < 61
}

function dataOraDelContratto(raw: string): boolean {
  const parti = raw.split(SEPARATORE_DATA_ORA)
  return parti.length === 2 && dataDelContratto(parti[0]) && oraDelContratto(parti[1])
}

/** An instant in the contract's `date-time` format. */
const IstanteSchema = z.string().refine(dataOraDelContratto, {
  message: 'atteso un istante date-time (RFC 3339) come da contratto agent-clarification/v1',
})

/**
 * A round of questions, as the contract describes it. The judge is hand-written on purpose (same choice as
 * CYAU-188): a generator would have nowhere to note why `MAX_QUESTIONS` is also the cap of the
 * questions comment, and the parity with the contract is proven on the official examples in `test/contract-agent-clarification`.
 */
const ClarificationRoundSchema = z
  .object({
    cycle: z.number().int().min(1),
    questions: z.array(z.string().min(1)).min(1).max(MAX_QUESTIONS),
    response: z.string().nullable(),
    answered_at: IstanteSchema.nullable(),
    created_at: IstanteSchema,
  })
  .strict()

/**
 * The payload of `GET /cli/v1/projects/:project/tickets/:ticket/clarifications` (contract
 * `agent-clarification/v1`). `.strict()`: a key that is not in the contract is an answer I cannot
 * read, and reading it halfway would mean letting the gate decide on information I did not understand.
 */
export const ClarificationWireSchema = z
  .object({
    state: z.enum(CLARIFICATION_WIRE_STATES),
    cycles: z.number().int().min(0),
    has_reply: z.boolean(),
    rounds: z.array(ClarificationRoundSchema),
  })
  .strict()
  // A `waiting` without even one round is a contract contradiction: there is a wait, but nothing that
  // explains it. The server does not produce it; if it arrives, the answer is not readable.
  .refine((stato) => stato.state !== 'waiting' || stato.rounds.length > 0, {
    path: ['rounds'],
    message: 'uno stato waiting deve portare almeno un giro di domande',
  })

/** The system's answer, or `undefined` if it does not honour the contract (which counts as "not readable"). */
export function parseSystemClarificationState(raw: string): ClarificationStatus | undefined {
  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    return undefined
  }

  // The CLI wraps in `data`; the contract describes the content. Both shapes are accepted.
  const dati = (payload as {data?: unknown} | null)?.data ?? payload
  const letto = ClarificationWireSchema.safeParse(dati)
  if (!letto.success) return undefined

  return {
    state: letto.data.state,
    cycles: letto.data.cycles,
    hasReply: letto.data.has_reply,
    source: 'system',
  }
}

/** The actions the gate can decide. `proceed`/`resume` are workable; `ask`/`wait`/`escalate` are not. */
export const CLARIFICATION_ACTIONS = ['proceed', 'resume', 'ask', 'wait', 'escalate'] as const
export type ClarificationAction = (typeof CLARIFICATION_ACTIONS)[number]

/** The default budget: TWO clarification cycles, then escalation (Technical analysis). */
export const DEFAULT_CLARIFICATION_LIMIT = 2

/** The state machine phases (CYAU-16) the gate can bring the run to (waiting/intervention). */
const CLARIFICATION_PHASES = ['waiting', 'blocked'] as const satisfies readonly RunPhase[]

/** The clarification state the gate decides on. */
export interface ClarificationStatus {
  /** `ready` (workable), `waiting` (pending question without answer), `escalated` or `unreadable`. */
  state: ClarificationState
  /** The number of question rounds already asked on this run. */
  cycles: number
  /** true if the LAST round received an answer (an old answer to an old round does not count). */
  hasReply: boolean
  /** Where this state comes from: the system, or nobody (asking did not succeed). */
  source?: 'system' | 'unreadable'
}

/** The clarification gate decision (auditable zod schema). `.strict()`: stable contract. */
export const ClarificationDecisionSchema = z
  .object({
    action: z.enum(CLARIFICATION_ACTIONS),
    state: z.enum(CLARIFICATION_STATES),
    /** The reference cycle: for `ask` it is the NEW question's (cycles+1), otherwise the consumed cycles. */
    cycle: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    /** true if the ticket is automatically workable NOW (`proceed`/`resume`). */
    workable: z.boolean(),
    /** true if human intervention is needed (escalation: do not open a third round). */
    requiresHuman: z.boolean(),
    /** The state machine phase (CYAU-16): `waiting`/`blocked` if not workable, otherwise `null`. */
    phase: z.enum(CLARIFICATION_PHASES).nullable(),
    reasons: z.array(z.string()),
  })
  .strict()
export type ClarificationDecision = z.infer<typeof ClarificationDecisionSchema>

/** The gate input: the clarification state, whether a decision is missing, and (optionally) the budget. */
export interface ClarificationInput {
  status: ClarificationStatus
  /** true if the agent determined that an indispensable functional decision is missing (it cannot proceed). */
  needsDecision: boolean
  /** The clarification cycle budget (default `DEFAULT_CLARIFICATION_LIMIT`). */
  limit?: number
}

/**
 * Decides the action from the state + whether a decision is missing. Pure and deterministic. Precedence:
 *  1. ticket already `escalated` → `escalate` (the team is needed, regardless: it is not reopened);
 *  2. pending question without answer (`waiting`) → `wait` (do not duplicate the question; the slot is already free);
 *  3. a decision is needed (`needsDecision`) → `ask` under the budget (releases the slot, cycle cycles+1) or
 *     `escalate` at the budget (DoD: at most two cycles);
 *  4. otherwise: `resume` if an answer arrived (DoD: it becomes workable again), or `proceed` (nothing pending).
 * A non-workable ticket (`ask`/`wait`/`escalate`) does NOT hold the slot: the caller releases it and continues.
 */
export function decideClarification(input: ClarificationInput): ClarificationDecision {
  const limit = input.limit ?? DEFAULT_CLARIFICATION_LIMIT
  if (!Number.isInteger(limit) || limit < 1) {
    throw invalidInput(`Limite non valido: "${String(limit)}" (atteso un intero ≥ 1)`)
  }

  const {status, needsDecision} = input
  const cycles = status.cycles

  // 0. CYRA-628 — reading the state failed. We do not guess and do not declare
  //    "all is well": the ticket stays where it is, the slot is freed and we retry later. Never
  //    `proceed`, which would send a machine to work a ticket that is waiting for an answer.
  if (status.state === 'unreadable') {
    return decide('wait', status.state, cycles, limit, [
      'Stato dei chiarimenti non leggibile: il ticket resta dov\'è e si riprova più tardi',
      'Uno stato illeggibile non è «nessuna domanda in corso»: non è un via libera',
    ])
  }

  // 1. Already escalated: the team is needed, a round is not reopened (regardless of needsDecision).
  if (status.state === 'escalated') {
    return decide('escalate', status.state, cycles, limit, [
      `Il ticket è già stato escalato al ciclo ${cycles}/${limit}: richiede l'intervento del team, non si riapre un giro automatico`,
    ])
  }

  // 2. Question already pending without answer: do not ask it again; the slot is already free, the queue continues.
  if (status.state === 'waiting') {
    return decide('wait', status.state, cycles, limit, [
      `Il ticket è in attesa di una risposta (ciclo ${cycles}/${limit}): non lavorabile ora`,
      'Lo slot resta libero e la coda continua con altri lavori — la domanda è già pubblicata',
    ])
  }

  // Here the state is `ready`: never asked, or an answer to a previous question arrived.
  // 3. A decision is missing: ask (under the budget) or escalate (at the budget).
  if (needsDecision) {
    if (cycles >= limit) {
      return decide('escalate', status.state, cycles, limit, [
        `Raggiunto il limite di ${limit} cicli di chiarimento senza una risposta utile (ciclo ${cycles}): serve l'intervento del team`,
        'Non si apre un terzo giro automatico (DoD: massimo due cicli, poi escalation)',
      ])
    }

    const nextCycle = cycles + 1
    return decide('ask', status.state, nextCycle, limit, [
      `Manca una decisione funzionale indispensabile: si pubblica una domanda al ciclo ${nextCycle}/${limit}`,
      'Si rilascia lo slot e la coda continua con altri lavori — il ticket attende la risposta',
    ])
  }

  // 4. No missing decision: an answer makes the ticket workable again; otherwise proceed.
  if (status.hasReply) {
    return decide('resume', status.state, cycles, limit, [
      `È arrivata una risposta alla domanda del ciclo ${cycles}/${limit}: il ticket è di nuovo lavorabile`,
    ])
  }

  return decide('proceed', status.state, cycles, limit, ['Nessun chiarimento in sospeso: il ticket è lavorabile'])
}

/** Composes the decision deriving workability/intervention/phase from the action, and guarantees its auditable schema. */
function decide(
  action: ClarificationAction,
  state: ClarificationState,
  cycle: number,
  limit: number,
  reasons: string[],
): ClarificationDecision {
  const workable = action === 'proceed' || action === 'resume'
  const requiresHuman = action === 'escalate'
  const phase: RunPhase | null = workable ? null : action === 'escalate' ? 'blocked' : 'waiting'
  return ClarificationDecisionSchema.parse({action, state, cycle, limit, workable, requiresHuman, phase, reasons})
}

// The questions are NOT composed here (CYRA-221). The server publishes them in the same transaction as the triage
// delivery: it is the only place that has the record where the questions live, and the line that ends up in the discussion must
// stay under the comment cap — a questions body with three 180-character questions broke that cap and
// the publication was rejected. What remains here is READ (from the contract) and DECISION (the round limit, which
// stays client policy: the contract does not duplicate it, two numbers in two repositories diverge one day).

function invalidInput(message: string): AutomatorError {
  return new AutomatorError(ErrorCodes.Clarify.invalidInput, message, 2)
}
