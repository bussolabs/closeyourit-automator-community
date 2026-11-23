import {describe, expect, it} from 'vitest'
import {codexFinalMessage} from '../src/lib/codex-output'
import {parseWorkflowResult} from '../src/lib/typed-workflow'
import {parseAgentReport} from '../src/lib/agent-result'

const result = {code: 'CYAU-277', category: 'backend', capabilities: ['backend'], risk: 'low',
  requires_human_approval: false, reasons: ['Ready'], state: 'workable'}
const message = (text: string) => JSON.stringify({type: 'item.completed', item: {id: 'item_1', type: 'agent_message', text}})
// Representative CLI JSONL fixture, not a recording of an authenticated provider run.
const usage = '{"type":"turn.completed","usage":{"input_tokens":24763,"cached_input_tokens":24448,"output_tokens":122}}'

describe('Codex JSONL output', () => {
  it('uses the last completed agent message and ignores tool output containing a result', () => {
    const stdout = [message(JSON.stringify({...result, code: 'OLD'})),
      JSON.stringify({type: 'item.completed', item: {type: 'command_execution', aggregated_output: JSON.stringify(result)}}),
      message(`Done.\n\`\`\`json\n${JSON.stringify(result)}\n\`\`\``), usage].join('\n')
    expect(parseWorkflowResult(stdout, 'triage')).toEqual(result)
    expect(parseAgentReport(message('{"summary":"Done"}')).report?.summary).toBe('Done')
    expect(parseWorkflowResult(`${stdout}\n${message('No result available')}`, 'triage')).toBeNull()
  })

  it('keeps plain output readable when no final event is available', () => {
    for (const text of ['plain text', 'null', '{bad json', JSON.stringify(result)]) expect(codexFinalMessage(text)).toBe(text)
    expect(parseWorkflowResult(JSON.stringify(result), 'triage')).toEqual(result)
  })
})
