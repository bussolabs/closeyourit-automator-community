import * as fs from 'node:fs'
import * as path from 'node:path'

import {describe, expect, it} from 'vitest'

import {parseWorkflowResult} from '../src/lib/typed-workflow'

// CYRA-885 — optional agent-result/v2 additions: `decision_card` (planner, autopilot) and triage questions with options.
const VALID = path.join(import.meta.dirname, 'contracts', 'agent-result', 'v2', 'fixtures', 'valid')
const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(VALID, name), 'utf8')) as Record<string, unknown>

const card = {
  headline: 'The guide will explain how to get the weekly cost report.',
  points: [{label: 'What changes', text: 'Only the guide.'}],
  risk_level: 'low',
  risk: null,
}

describe('decision_card (CYRA-885)', () => {
  const planner = fixture('planner_decision_card.json')
  const autopilot = fixture('autopilot_decision_card.json')

  it('accepts a planner with a decision_card', () => {
    expect(parseWorkflowResult(JSON.stringify(planner), 'planner')).not.toBeNull()
    expect(parseWorkflowResult(JSON.stringify({...planner, decision_card: card}), 'planner')).not.toBeNull()
  })

  it('still accepts a planner without a decision_card', () => {
    const {decision_card: _omitted, ...withoutCard} = planner
    expect(parseWorkflowResult(JSON.stringify(withoutCard), 'planner')).not.toBeNull()
  })

  // CYRA-998 — on bugs the card opens with what happens today: four points, never five.
  it('accepts four points and rejects five', () => {
    expect(parseWorkflowResult(JSON.stringify(fixture('planner_decision_card_bug_today.json')), 'planner')).not.toBeNull()
    const point = {label: 'Point', text: 'Text.'}
    const decisionCard = {...card, points: [point, point, point, point, point]}
    expect(parseWorkflowResult(JSON.stringify({...planner, decision_card: decisionCard}), 'planner')).toBeNull()
  })

  it('rejects a headline over 120 characters', () => {
    expect(parseWorkflowResult(JSON.stringify({...planner, decision_card: {...card, headline: 'a'.repeat(120)}}), 'planner')).not.toBeNull()
    expect(parseWorkflowResult(JSON.stringify({...planner, decision_card: {...card, headline: 'a'.repeat(121)}}), 'planner')).toBeNull()
  })

  it('rejects unknown keys and an unknown risk_level', () => {
    expect(parseWorkflowResult(JSON.stringify({...planner, decision_card: {...card, extra: 'x'}}), 'planner')).toBeNull()
    expect(parseWorkflowResult(JSON.stringify({...planner, decision_card: {...card, risk_level: 'medium'}}), 'planner')).toBeNull()
  })

  it('accepts an autopilot with a decision_card', () => {
    expect(parseWorkflowResult(JSON.stringify(autopilot), 'autopilot')).not.toBeNull()
    expect(parseWorkflowResult(JSON.stringify({...autopilot, decision_card: card}), 'autopilot')).not.toBeNull()
    expect(parseWorkflowResult(JSON.stringify({...autopilot, decision_card: {...card, points: []}}), 'autopilot')).toBeNull()
  })
})

describe('triage questions with options (CYRA-885)', () => {
  const base = {code: 'CYRA-885', category: 'backend', capabilities: [], risk: 'low', requires_human_approval: false,
    reasons: [], state: 'needs-clarification'}
  const question = {body: 'Should the report be emailed or only shown?', options: [{label: 'Only shown', recommended: true}, {label: 'Email every Monday'}]}

  it('accepts a question with options, alone or mixed with string questions', () => {
    expect(parseWorkflowResult(JSON.stringify({...base, questions: [question]}), 'triage')).not.toBeNull()
    expect(parseWorkflowResult(JSON.stringify({...base, questions: ['Does the week start on Monday?', question]}), 'triage')).not.toBeNull()
    expect(parseWorkflowResult(JSON.stringify(fixture('triage_question_options.json')), 'triage')).not.toBeNull()
  })

  it('still accepts string questions', () => {
    const result = {...base, questions: ['Does the week start on Monday?']}
    expect(parseWorkflowResult(JSON.stringify(result), 'triage')).toEqual(result)
  })

  it('rejects two recommended options', () => {
    const options = [{label: 'A', recommended: true}, {label: 'B', recommended: true}]
    expect(parseWorkflowResult(JSON.stringify({...base, questions: [{...question, options}]}), 'triage')).toBeNull()
  })

  it('rejects a body over 180 characters', () => {
    expect(parseWorkflowResult(JSON.stringify({...base, questions: [{...question, body: 'a'.repeat(180)}]}), 'triage')).not.toBeNull()
    expect(parseWorkflowResult(JSON.stringify({...base, questions: [{...question, body: 'a'.repeat(181)}]}), 'triage')).toBeNull()
  })

  it('rejects fewer than two or more than four options and unknown keys', () => {
    const option = {label: 'A'}
    expect(parseWorkflowResult(JSON.stringify({...base, questions: [{...question, options: [option]}]}), 'triage')).toBeNull()
    expect(parseWorkflowResult(JSON.stringify({...base, questions: [{...question, options: [option, option, option, option]}]}), 'triage')).not.toBeNull()
    expect(parseWorkflowResult(JSON.stringify({...base, questions: [{...question, options: [option, option, option, option, option]}]}), 'triage')).toBeNull()
    expect(parseWorkflowResult(JSON.stringify({...base, questions: [{...question, extra: 'x'}]}), 'triage')).toBeNull()
  })

  // CYRA-1033 — a one-line reason, only on the recommended option.
  it('accepts a reason on the recommended option only', () => {
    expect(parseWorkflowResult(JSON.stringify(fixture('triage_question_four_options_reason.json')), 'triage')).not.toBeNull()
    const withReason = [{label: 'A', recommended: true, reason: 'Matches what the code already does.'}, {label: 'B'}]
    expect(parseWorkflowResult(JSON.stringify({...base, questions: [{...question, options: withReason}]}), 'triage')).not.toBeNull()
    const onOther = [{label: 'A', recommended: true}, {label: 'B', reason: 'Why not.'}]
    expect(parseWorkflowResult(JSON.stringify({...base, questions: [{...question, options: onOther}]}), 'triage')).toBeNull()
  })

  it('rejects a reason over 160 characters or on several lines', () => {
    const reason = (text: string) => [{label: 'A', recommended: true, reason: text}, {label: 'B'}]
    expect(parseWorkflowResult(JSON.stringify({...base, questions: [{...question, options: reason('a'.repeat(160))}]}), 'triage')).not.toBeNull()
    expect(parseWorkflowResult(JSON.stringify({...base, questions: [{...question, options: reason('a'.repeat(161))}]}), 'triage')).toBeNull()
    expect(parseWorkflowResult(JSON.stringify({...base, questions: [{...question, options: reason('one\ntwo')}]}), 'triage')).toBeNull()
  })
})
