import {describe, expect, it} from 'vitest'
import {createClaudeStreamReader} from '../src/lib/claude-stream'

function collect(maxLineBytes?: number) {
  const output: string[] = []
  const events: Record<string, unknown>[] = []
  const reader = createClaudeStreamReader({
    onOutput: (text) => output.push(text),
    onEvent: (event) => events.push(event),
  }, maxLineBytes)
  return {reader, output, events, text: () => output.join('')}
}

const RESULT = '{"type":"result","subtype":"success","is_error":false,"result":"done","total_cost_usd":0.1}'

describe('createClaudeStreamReader', () => {
  it('passes only the result line to the output and every other event to the callback', () => {
    const {reader, events, text} = collect()
    reader.push('{"type":"system","subtype":"init"}\n{"type":"assistant","message":{}}\n')
    reader.push(`${RESULT}\n`)
    reader.end()
    expect(text()).toBe(`${RESULT}\n`)
    expect(events.map((event) => event.type)).toEqual(['system', 'assistant'])
  })

  it('joins a line split across chunks', () => {
    const {reader, events, text} = collect()
    reader.push('{"type":"assi')
    reader.push('stant"}\n{"type":"res')
    reader.push('ult","result":"x"}\n')
    reader.end()
    expect(events).toEqual([{type: 'assistant'}])
    expect(text()).toBe('{"type":"result","result":"x"}\n')
  })

  it('keeps a multi-byte character split across chunks intact', () => {
    const {reader, events} = collect()
    const line = Buffer.from('{"type":"assistant","text":"caffè"}\n')
    const cut = line.indexOf(0xc3) + 1
    reader.push(line.subarray(0, cut))
    reader.push(line.subarray(cut))
    reader.end()
    expect(events).toEqual([{type: 'assistant', text: 'caffè'}])
  })

  it('passes lines that are not stream events to the output unchanged', () => {
    const {reader, events, text} = collect()
    reader.push('Error: something went wrong\n[1,2]\n{"no_type":true}\n')
    reader.end()
    expect(events).toEqual([])
    expect(text()).toBe('Error: something went wrong\n[1,2]\n{"no_type":true}\n')
  })

  it('handles a last line without a trailing newline at the end', () => {
    const {reader, events, text} = collect()
    reader.push(`{"type":"user"}\n${RESULT}`)
    reader.end()
    expect(events).toEqual([{type: 'user'}])
    expect(text()).toBe(RESULT)
  })

  it('drops a line longer than the limit without holding it in memory', () => {
    const {reader, events, text} = collect(64)
    reader.push(`{"type":"user","tool_use_result":{"originalFile":"${'x'.repeat(40)}`)
    reader.push(`${'y'.repeat(40)}"}}\n${RESULT}\n`)
    reader.end()
    expect(events).toEqual([])
    expect(text()).toBe(`${RESULT}\n`)
  })

  it('ignores chunks pushed after the end', () => {
    const {reader, events, text} = collect()
    reader.end()
    reader.push('{"type":"assistant"}\n')
    expect(events).toEqual([])
    expect(text()).toBe('')
  })
})
