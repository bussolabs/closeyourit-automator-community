// CYAU-171 — the machine log writes what the SERVER decided, not what the network
// answered.
//
// Until now, on a successful delivery, the machine wrote "concluded" only because the connection had
// answered "received". The response already contained the server's decision and was thrown away without
// reading it. Today the two coincide — the server closes the attempt at the same instant it
// accepts — but by luck, not by check.
//
// They will stop coinciding the day the server answers "accepted, still looking":
// it is the answer it will need as soon as, before saying done, it goes to open the proposal, read the
// checks and wait to see the release up and running. That day the machine would keep
// writing the green line, and whoever opens the log to understand why a run is stuck would
// find written there that it went fine — and would look for the failure on the wrong side.
import {describe, expect, it} from 'vitest'
import {makeClient} from '../src/lib/client'
import {type SyncConfig} from '../src/lib/config'

const sync: SyncConfig = {orgToken: 'cyi_a_secret'}
const token = 'cyi_ah_host'
const payload = {
  runtime: 'claude' as const, reviewer_runtime: 'codex' as const,
  result: {outcome: 'workable'}, review: {status: 'accepted' as const, summary: 'Ok'},
}

function risposta(body: unknown, status = 200): Response {
  return {ok: status < 400, status, json: async () => body} as unknown as Response
}

describe('the delivery reads the server decision', () => {
  // CYAU-191 — the REAL shape of the response: `render_ok(AgentAttemptSerializer.new(...))` puts the
  // attempt flat under `data`, without an `attempt` key. As long as the tests stubbed only the nested
  // shape, the defect had nowhere to show up: in production every successful delivery ended up in the
  // log as "outcome not read".
  it('reports the status the server really sends (flat attempt under data)', async () => {
    const client = makeClient(sync, async () => risposta({data: {id: 'att-1', status: 'approved', phase: 'autopilot', review_status: 'accepted'}}), token)

    const esito = await client.deliverAttempt('att-1', payload)

    expect(esito).toMatchObject({
      outcome: 'ok',
      attempt: {status: 'approved', phase: 'autopilot', reviewStatus: 'accepted'},
    })
  })

  it('reports the status the server declared (nested shape, still accepted)', async () => {
    const client = makeClient(sync, async () => risposta({data: {attempt: {status: 'approved', phase: 'autopilot', review_status: 'accepted'}}}), token)

    const esito = await client.deliverAttempt('att-1', payload)

    expect(esito).toMatchObject({
      outcome: 'ok',
      attempt: {status: 'approved', phase: 'autopilot', reviewStatus: 'accepted'},
    })
  })

  // The response that does not exist yet today, and that is the reason this ticket exists.
  it('reports a NEW status without interpreting it', async () => {
    const client = makeClient(sync, async () => risposta({data: {status: 'awaiting_review'}}), token)

    const esito = await client.deliverAttempt('att-1', payload)

    expect((esito as {attempt?: {status?: string}}).attempt?.status).toBe('awaiting_review')
  })

  // An unreadable body must not turn a successful delivery into an error: the detail is lost,
  // not the delivery.
  it('an unreadable response leaves the delivery successful, without status', async () => {
    const client = makeClient(sync, async () => ({ok: true, status: 200, json: async () => { throw new Error('non è json') }} as unknown as Response), token)

    const esito = await client.deliverAttempt('att-1', payload)

    expect(esito).toEqual({outcome: 'ok', status: 200, attempt: undefined})
  })

  it('a body without the attempt leaves the delivery successful, without status', async () => {
    const client = makeClient(sync, async () => risposta({data: {}}), token)

    expect(await client.deliverAttempt('att-1', payload)).toEqual({outcome: 'ok', status: 200, attempt: undefined})
  })

  // The other branches do not change: they have opposite remedies and must not be confused with this one.
  it('a rejection stays a rejection, and carries no status', async () => {
    const client = makeClient(sync, async () => risposta({error: {code: 'R409-ATTEMPT-003'}}, 409), token)

    const esito = await client.deliverAttempt('att-1', payload)

    expect(esito).toMatchObject({outcome: 'rejected', status: 409, code: 'R409-ATTEMPT-003'})
    expect((esito as {attempt?: unknown}).attempt).toBeUndefined()
  })

  it('a 5xx stays undetermined: the server did not decide on the merits', async () => {
    const client = makeClient(sync, async () => risposta({}, 503), token)

    expect(await client.deliverAttempt('att-1', payload)).toEqual({outcome: 'unavailable', status: 503})
  })
})
