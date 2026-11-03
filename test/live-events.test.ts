import * as os from 'node:os'
import {describe, expect, it} from 'vitest'
import {liveEventsFromClaude} from '../src/lib/live-events'

const CWD = '/work/tickets/CYRA-1'

function editResult(filePath: string, patch: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'user',
    message: {role: 'user', content: [{type: 'tool_result', tool_use_id: 't1', content: 'ok'}]},
    tool_use_result: {
      filePath,
      oldString: '  belongs_to :project\n',
      newString: '  belongs_to :project\n  has_many :comments\n',
      originalFile: 'class Ticket\n  belongs_to :project\nend\n',
      structuredPatch: patch,
      userModified: false,
      replaceAll: false,
      ...extra,
    },
  }
}

const PATCH = [{oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, lines: [' class Ticket', '   belongs_to :project', '+  has_many :comments', ' end']}]

function toolUse(name: string, input: Record<string, unknown>): Record<string, unknown> {
  return {type: 'assistant', message: {role: 'assistant', content: [{type: 'tool_use', id: 't1', name, input}]}}
}

describe('liveEventsFromClaude', () => {
  it('turns an applied edit into a file change relative to the ticket folder, with counts', () => {
    const [event] = liveEventsFromClaude(editResult(`${CWD}/app/models/ticket.rb`, PATCH), {cwd: CWD, includeCode: true})
    expect(event).toEqual({
      kind: 'file_change', path: 'app/models/ticket.rb', created: false, added: 1, removed: 0,
      hunks: [{oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, lines: [' class Ticket', '   belongs_to :project', '+  has_many :comments', ' end']}],
    })
  })

  it('never carries the whole original file or the raw strings of the edit', () => {
    const events = liveEventsFromClaude(editResult(`${CWD}/app/models/ticket.rb`, PATCH), {cwd: CWD, includeCode: true})
    const serialized = JSON.stringify(events)
    expect(serialized).not.toContain('originalFile')
    expect(serialized).not.toContain('oldString')
    expect(serialized).not.toContain('newString')
  })

  it('keeps names, counts and line numbers, never the lines, when the code view is off (CYAU-299)', () => {
    const [event] = liveEventsFromClaude(editResult(`${CWD}/app/models/ticket.rb`, PATCH), {cwd: CWD, includeCode: false})
    expect(event).toEqual({
      kind: 'file_change', path: 'app/models/ticket.rb', created: false, added: 1, removed: 0,
      hunks: [{oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, lines: []}],
    })
  })

  it('turns a new file into an addition of all its lines', () => {
    const created = {
      type: 'user',
      tool_use_result: {type: 'create', filePath: `${CWD}/notes.txt`, content: 'alpha\nbeta\n', structuredPatch: []},
    }
    const [event] = liveEventsFromClaude(created, {cwd: CWD, includeCode: true})
    expect(event).toEqual({
      kind: 'file_change', path: 'notes.txt', created: true, added: 2, removed: 0,
      hunks: [{oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ['+alpha', '+beta']}],
    })
  })

  it('covers secrets in the changed lines', () => {
    const patch = [{oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: ['+GITHUB_TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789"']}]
    const [event] = liveEventsFromClaude(editResult(`${CWD}/config/app.rb`, patch), {cwd: CWD, includeCode: true})
    const serialized = JSON.stringify(event)
    expect(serialized).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789')
    expect(serialized).toContain('[REDACTED]')
  })

  it('shows generated and sensitive files only by name', () => {
    for (const file of ['db/schema.rb', 'Gemfile.lock', 'pnpm-lock.yaml', '.env.local', 'config/master.key']) {
      const [event] = liveEventsFromClaude(editResult(`${CWD}/${file}`, PATCH), {cwd: CWD, includeCode: true})
      expect(event).toMatchObject({kind: 'file_change', path: file, added: 1, removed: 0, hunks: [{oldStart: 1, oldLines: 3, lines: []}]})
    }
  })

  it('drops the code of a change that is too large but keeps its counts', () => {
    const lines = Array.from({length: 600}, (_, index) => `+line ${index}`)
    const patch = [{oldStart: 1, oldLines: 0, newStart: 1, newLines: 600, lines}]
    const [event] = liveEventsFromClaude(editResult(`${CWD}/big.rb`, patch), {cwd: CWD, includeCode: true})
    expect(event).toMatchObject({path: 'big.rb', added: 600, removed: 0, hunks: [{oldStart: 1, newLines: 600, lines: []}]})
  })

  it('shortens a very long line', () => {
    const patch = [{oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: [`+${'a'.repeat(2000)}`]}]
    const [event] = liveEventsFromClaude(editResult(`${CWD}/long.rb`, patch), {cwd: CWD, includeCode: true})
    const line = (event as {hunks: {lines: string[]}[]}).hunks[0].lines[0]
    expect(line.length).toBeLessThan(600)
    expect(line.endsWith('…')).toBe(true)
  })

  it('ignores changes outside the ticket folder instead of leaking the path', () => {
    expect(liveEventsFromClaude(editResult('/home/automator/.claude/x.json', PATCH), {cwd: CWD, includeCode: true})).toEqual([])
    expect(liveEventsFromClaude(editResult(`${CWD}/../other/x.rb`, PATCH), {cwd: CWD, includeCode: true})).toEqual([])
  })

  it('keeps a file whose name starts with two dots', () => {
    const [event] = liveEventsFromClaude(editResult(`${CWD}/..hidden.rb`, PATCH), {cwd: CWD, includeCode: false})
    expect(event).toMatchObject({path: '..hidden.rb'})
  })

  it('reports reads, searches and commands, with secrets covered', () => {
    expect(liveEventsFromClaude(toolUse('Read', {file_path: `${CWD}/app/models/ticket.rb`}), {cwd: CWD, includeCode: false}))
      .toEqual([{kind: 'file_read', path: 'app/models/ticket.rb'}])
    expect(liveEventsFromClaude(toolUse('Grep', {pattern: 'with_status'}), {cwd: CWD, includeCode: false}))
      .toEqual([{kind: 'search', pattern: 'with_status'}])
    const [command] = liveEventsFromClaude(
      toolUse('Bash', {command: 'GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789 bin/rspec'}),
      {cwd: CWD, includeCode: false},
    )
    expect(command).toMatchObject({kind: 'command'})
    expect(JSON.stringify(command)).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789')
  })

  it('keeps code written through a command out of the queue when the code view is off', () => {
    const cases: Array<[string, string]> = [
      ['bin/rspec spec/models/ticket_spec.rb', 'bin/rspec spec/models/ticket_spec.rb'],
      ['cat <<EOF > app/a.rb\nclass A\nend\nEOF', 'cat …'],
      ['python3 -c "open(\'a.rb\',\'w\').write(\'x\')"', 'python3 …'],
      ['git commit -m "Add the status filter"', 'git commit -m …'],
      ['echo \'secret code\' > a.rb', 'echo …'],
      ['ruby -e puts', 'ruby …'],
    ]
    for (const [input, expected] of cases) {
      const [command] = liveEventsFromClaude(toolUse('Bash', {command: input}), {cwd: CWD, includeCode: false})
      expect(command).toEqual({kind: 'command', command: expected})
    }
  })

  it('shows the whole command when the code view is on', () => {
    const [command] = liveEventsFromClaude(toolUse('Bash', {command: 'git commit -m "Add the status filter"'}), {cwd: CWD, includeCode: true})
    expect(command).toEqual({kind: 'command', command: 'git commit -m "Add the status filter"'})
  })

  it('hides host paths in commands and searches', () => {
    const [command] = liveEventsFromClaude(toolUse('Bash', {command: `cd ${CWD} && cat ${CWD}/app/a.rb ${os.homedir()}/notes`}), {cwd: CWD, includeCode: true})
    expect(command).toEqual({kind: 'command', command: 'cd . && cat app/a.rb ~/notes'})
    const [search] = liveEventsFromClaude(toolUse('Glob', {pattern: `${CWD}/app/**/*.rb`}), {cwd: CWD, includeCode: false})
    expect(search).toEqual({kind: 'search', pattern: 'app/**/*.rb'})
  })

  it('skips reads outside the ticket folder', () => {
    expect(liveEventsFromClaude(toolUse('Read', {file_path: '/opt/skills/SKILL.md'}), {cwd: CWD, includeCode: false})).toEqual([])
  })

  it('skips searches and commands with no text, which the app would reject', () => {
    for (const includeCode of [true, false]) {
      expect(liveEventsFromClaude(toolUse('Bash', {command: '  '}), {cwd: CWD, includeCode})).toEqual([])
      expect(liveEventsFromClaude(toolUse('Grep', {pattern: ''}), {cwd: CWD, includeCode})).toEqual([])
    }
  })

  it('ignores events it does not know', () => {
    expect(liveEventsFromClaude({type: 'system', subtype: 'init', cwd: CWD}, {cwd: CWD, includeCode: true})).toEqual([])
    expect(liveEventsFromClaude({type: 'user', tool_use_result: 'Error: file not found'}, {cwd: CWD, includeCode: true})).toEqual([])
  })
})
