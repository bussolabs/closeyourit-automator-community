// CYAU-240 — the diff review received title, description, scenarios and DoD only. A choice settled by a
// clarification answer, or written in the approved plan, read as a choice the implementer took alone,
// and the review rejected it twice (LAB-154). The review requirements must carry both.
import {describe, expect, it} from 'vitest'

import {reviewRequirements} from '../src/lib/ticket-preflight'
import type {TicketDetail} from '../src/lib/ticket-coordinator'

const ticket = (extra: Partial<TicketDetail> = {}): TicketDetail => ({
  project: 'LAB', code: 'LAB-154', cwd: '/tmp', comments: [], title: 'Add maskEnd', description: 'Mask the end.', ...extra,
})

describe('reviewRequirements (CYAU-240)', () => {
  it('lists every answered question as a decision taken', () => {
    const text = reviewRequirements(ticket({
      answeredQuestions: [{question: 'Short text: mask it or keep it?', answer: 'Keep it as it is.'}],
    }))
    expect(text).toContain('Decisione presa: Short text: mask it or keep it? → Keep it as it is.')
  })

  it('carries the approved plan', () => {
    const text = reviewRequirements(ticket({approvedPlan: '# Piano approvato dal CTO\nReturn short text unchanged.'}))
    expect(text).toContain('Return short text unchanged.')
  })

  it('stays as before when there are no decisions and no plan', () => {
    expect(reviewRequirements(ticket())).toBe('Ticket LAB-154: Add maskEnd\nMask the end.')
  })
})
