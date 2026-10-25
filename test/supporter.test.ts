import {describe, expect, it, vi} from 'vitest'
import {type Secrets} from '../src/lib/config'
import {buildSupporterPrompt, makeSupporterPass, parseSupporterAnswers, type SupporterRound, type SupporterRun} from '../src/lib/supporter'

// CYAU-235 — the machine runs the supporter on one open round and sends the proposed answers; the server decides.
const secrets: Secrets = {
  sync: {apiUrl: 'https://cyi.test'},
  host: {id: 'host-1', token: 'cyi_ah_hosttoken'},
  hosts: {LAB: {cwd: '/repos/lab'}},
} as Secrets

const round: SupporterRound = {
  round_id: 'round-1',
  digest: 'sha256:abc',
  engine: 'codex',
  project_key: 'LAB',
  ticket: {code: 'LAB-7', title: 'Add clamp', description: 'Clamp a number.'},
  questions: [{id: 'q-1', position: 1, body: 'Swap or throw?', options: [{label: 'Swap'}, {label: 'Throw', recommended: true}]}],
  autonomous_max: 6,
}

const answer = {
  question_id: 'q-1', choice: 2, risk_score: 2, confidence: 'high', source_status: 'written', sources: ['README.md'],
  rationale: 'r', reasons_against: 'a', assumptions: 's', undo: 'u',
}

function server(roundBody: unknown, status = 200) {
  const calls: Array<{url: string; init?: RequestInit}> = []
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({url: String(url), init})
    if (String(url).endsWith('/supporter_round')) {
      return new Response(status === 204 ? null : JSON.stringify({data: roundBody}), {status})
    }
    return new Response(JSON.stringify({data: {outcome: 'answered'}}), {status: 200})
  })
  return {fetchFn: fetchFn as unknown as typeof globalThis.fetch, calls}
}

describe('buildSupporterPrompt', () => {
  it('states the critical rules and carries the questions with numbered options', () => {
    const prompt = buildSupporterPrompt(round)
    expect(prompt).toContain('Read only')
    expect(prompt).toContain('reasons the other answers could be right')
    expect(prompt).toContain('Above 6 a person decides')
    expect(prompt).toContain('"choice": 2')
    expect(prompt).toContain('Swap or throw?')
  })
})

describe('parseSupporterAnswers', () => {
  it('reads the answers object, even after prose', () => {
    expect(parseSupporterAnswers(`Here it is:\n${JSON.stringify({answers: [answer]})}`)).toEqual([answer])
  })

  it('returns null when there is no answers object', () => {
    expect(parseSupporterAnswers('I could not decide.')).toBeNull()
  })
})

describe('makeSupporterPass', () => {
  it('runs the engine the server names in the project checkout and sends the answers with the digest', async () => {
    const {fetchFn, calls} = server(round)
    const run = vi.fn<SupporterRun>(async () => ({ok: true, text: JSON.stringify({answers: [answer]})}))
    const log = vi.fn()

    await makeSupporterPass(secrets, {fetchFn, run, log})?.()

    expect(run).toHaveBeenCalledWith('codex', expect.objectContaining({cwd: '/repos/lab'}))
    const post = calls.find((call) => call.url.endsWith('/supporter_rounds/round-1/answer'))
    expect(post?.init?.headers).toMatchObject({Authorization: 'Bearer cyi_ah_hosttoken'})
    expect(JSON.parse(String(post?.init?.body))).toEqual({digest: 'sha256:abc', answers: [answer]})
    expect(log).toHaveBeenCalledWith('supporter: LAB-7 engine=codex outcome=answered')
  })

  it('does nothing when the server has no round', async () => {
    const {fetchFn, calls} = server(null, 204)
    const run = vi.fn<SupporterRun>()

    await makeSupporterPass(secrets, {fetchFn, run})?.()

    expect(run).not.toHaveBeenCalled()
    expect(calls).toHaveLength(1)
  })

  it('sends no answers when the session fails, so the round stays with a person', async () => {
    const {fetchFn, calls} = server(round)
    const run = vi.fn<SupporterRun>(async () => ({ok: false, detail: 'timed out'}))

    await makeSupporterPass(secrets, {fetchFn, run})?.()

    const post = calls.find((call) => call.url.endsWith('/answer'))
    expect(JSON.parse(String(post?.init?.body)).answers).toEqual([])
  })

  it('leaves a round of a project outside the host map to a person', async () => {
    const {fetchFn} = server({...round, project_key: 'OTHER'})
    const run = vi.fn<SupporterRun>()
    const log = vi.fn()

    await makeSupporterPass(secrets, {fetchFn, run, log})?.()

    expect(run).not.toHaveBeenCalled()
    expect(log.mock.calls[0][0]).toContain('is not in the host map')
  })

  it('is off without a host identity', () => {
    expect(makeSupporterPass({sync: {apiUrl: 'https://cyi.test'}} as Secrets)).toBeUndefined()
  })

  it('never throws, and never logs the host token', async () => {
    const fetchFn = vi.fn(async () => { throw new Error('network down') }) as unknown as typeof globalThis.fetch
    const log = vi.fn()

    await expect(makeSupporterPass(secrets, {fetchFn, log})?.()).resolves.toBeUndefined()
    expect(log.mock.calls.flat().join(' ')).not.toContain('cyi_ah_hosttoken')
  })
})
