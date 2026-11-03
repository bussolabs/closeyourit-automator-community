import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterAll, describe, expect, it} from 'vitest'
import {openLiveSpool} from '../src/lib/live-spool'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-live-spool-'))
afterAll(() => fs.rmSync(dir, {recursive: true, force: true}))
const now = new Date('2026-11-02T15:00:00.000Z')

function lines(file: string): Record<string, unknown>[] {
  return fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
}

describe('openLiveSpool', () => {
  it('appends events with increasing sequence numbers next to the action log', () => {
    const spool = openLiveSpool(dir, 'ticket-CYRA-1', now, {clock: () => now})
    spool.append([{kind: 'file_read', path: 'a.rb'}])
    spool.append([{kind: 'search', pattern: 'x'}, {kind: 'command', command: 'bin/rspec'}])
    expect(spool.path).toBe(path.join(dir, 'ticket-CYRA-1-20261102T150000.live.jsonl'))
    expect(lines(spool.path)).toEqual([
      {seq: 1, at: '2026-11-02T15:00:00.000Z', event: {kind: 'file_read', path: 'a.rb'}},
      {seq: 2, at: '2026-11-02T15:00:00.000Z', event: {kind: 'search', pattern: 'x'}},
      {seq: 3, at: '2026-11-02T15:00:00.000Z', event: {kind: 'command', command: 'bin/rspec'}},
    ])
  })

  it('creates the file only on the first event, readable only by its owner', () => {
    const spool = openLiveSpool(dir, 'ticket-CYRA-2', now)
    expect(fs.existsSync(spool.path)).toBe(false)
    spool.append([{kind: 'file_read', path: 'a.rb'}])
    expect(fs.statSync(spool.path).mode & 0o777).toBe(0o600)
  })

  it('covers secrets again before writing', () => {
    const spool = openLiveSpool(dir, 'ticket-CYRA-3', now)
    const returned = spool.append([{kind: 'command', command: 'echo ghp_abcdefghijklmnopqrstuvwxyz0123456789'}])
    expect(fs.readFileSync(spool.path, 'utf8')).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789')
    expect(JSON.stringify(returned)).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789')
  })

  it('returns exactly the lines it wrote, for the sender', () => {
    const spool = openLiveSpool(dir, 'ticket-CYRA-5', now, {clock: () => now})
    const returned = [...spool.append([{kind: 'file_read', path: 'a.rb'}]), ...spool.append([{kind: 'search', pattern: 'x'}])]
    expect(returned).toEqual(lines(spool.path))
  })

  it('stops at the size limit and says so once', () => {
    const spool = openLiveSpool(dir, 'ticket-CYRA-4', now, {clock: () => now, maxBytes: 200})
    for (let index = 0; index < 10; index += 1) spool.append([{kind: 'file_read', path: `file-${index}.rb`}])
    const written = lines(spool.path)
    expect(written.at(-1)).toEqual({seq: written.length, at: '2026-11-02T15:00:00.000Z', truncated: true})
    expect(written.filter((line) => line.truncated)).toHaveLength(1)
    expect(fs.statSync(spool.path).size).toBeLessThan(400)
  })
})
