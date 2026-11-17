import {describe, expect, it} from 'vitest'
import {acceptanceLines, reviewRequirements} from '../src/lib/ticket-preflight'

// CYRA-1318 — the ticket's acceptance items reach the agent and the reviewer as ONE list with their codes.
describe('acceptanceLines', () => {
  it('turns the items into one line each, with the code and a case\'s clauses', () => {
    expect(acceptanceLines([
      {code: 'AC-1', format: 'text', text: 'Templates inspected'},
      {code: 'AC-2', format: 'scenario', title: 'Link present', step_given: 'a client', step_expected: 'sees the link'},
    ])).toEqual([
      'AC-1: Templates inspected',
      'AC-2: Link present — Given a client / Expected sees the link',
    ])
  })

  it('says it has nothing to tell when the server does not send the items', () => {
    expect(acceptanceLines(undefined)).toBeUndefined()
  })

  it('gives the reviewer one list of criteria, never a second Definition of Done', () => {
    const requirements = reviewRequirements({
      code: 'CYRA-1', title: 'Link', scenarios: [], conditions: acceptanceLines([{code: 'AC-1', format: 'text', text: 'A'}]),
    } as unknown as Parameters<typeof reviewRequirements>[0])
    expect(requirements).toContain('Criterio di accettazione: AC-1: A')
    expect(requirements).not.toContain('Definition of Done')
  })
})
