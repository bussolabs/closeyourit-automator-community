import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {readUpdateFailure, recordUpdateOutcome, updateOutcomePath} from '../src/lib/update-outcome'

// CYAU-202 — "a failed update is visible on CloseYourIt". The update starts by itself, so
// nobody reads the outcome on screen any more: the command leaves it written and the beat carries it to the panel, so one
// knows there is something to do without logging into the server. A successful update clears the notice: a reason
// no longer current is worse than no reason.

const directories: string[] = []
let savedStateDir: string | undefined

function isolatedStateDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-outcome-'))
  directories.push(directory)
  process.env.AUTOMATOR_STATE_DIR = directory
  return directory
}

beforeEach(() => {
  savedStateDir = process.env.AUTOMATOR_STATE_DIR
  isolatedStateDir()
})

afterEach(() => {
  if (savedStateDir === undefined) delete process.env.AUTOMATOR_STATE_DIR
  else process.env.AUTOMATOR_STATE_DIR = savedStateDir
  for (const directory of directories.splice(0)) fs.rmSync(directory, {recursive: true, force: true})
})

describe('esito dell aggiornamento automatico', () => {
  it('restore to the previous version → notice with both versions', () => {
    recordUpdateOutcome({outcome: 'rolled-back', reason: 'health check fallito', fromVersion: '0.32.3', toVersion: '0.33.0'})

    const stop = readUpdateFailure()
    expect(stop?.action).toBe('update')
    expect(stop?.reason).toContain('0.33.0')
    expect(stop?.reason).toContain('0.32.3')
    expect(stop?.reason).toContain('health check fallito')
  })

  it('failed update → warning written', () => {
    recordUpdateOutcome({outcome: 'failed', reason: 'checksum non corrispondente', fromVersion: '0.32.3', toVersion: '0.33.0'})

    expect(readUpdateFailure()?.reason).toContain('checksum non corrispondente')
  })

  it('successful update → the previous notice disappears', () => {
    recordUpdateOutcome({outcome: 'failed', reason: 'rete assente', fromVersion: '0.32.3', toVersion: '0.33.0'})

    recordUpdateOutcome({outcome: 'updated', reason: 'aggiornata', fromVersion: '0.32.3', toVersion: '0.33.0'})

    expect(readUpdateFailure()).toBeNull()
    expect(fs.existsSync(updateOutcomePath())).toBe(false)
  })

  it('busy machine → neither clears a still valid notice nor writes a new one', () => {
    recordUpdateOutcome({outcome: 'failed', reason: 'rete assente', fromVersion: '0.32.3', toVersion: '0.33.0'})

    recordUpdateOutcome({outcome: 'busy', reason: 'la macchina sta lavorando', fromVersion: null, toVersion: null})

    expect(readUpdateFailure()?.reason).toContain('rete assente')
  })

  it('no failed update → no notice', () => {
    expect(readUpdateFailure()).toBeNull()
  })

  it('unreadable notice → no notice, never a beat brought down', () => {
    fs.mkdirSync(path.dirname(updateOutcomePath()), {recursive: true})
    fs.writeFileSync(updateOutcomePath(), '{ non è json')

    expect(readUpdateFailure()).toBeNull()
  })

  it('the reason is redacted before being written', () => {
    recordUpdateOutcome({
      outcome: 'failed',
      reason: 'token cyi_ah_abcdefghijklmnopqrstuvwxyz012345 rifiutato',
      fromVersion: '0.32.3',
      toVersion: '0.33.0',
    })

    expect(fs.readFileSync(updateOutcomePath(), 'utf8')).not.toContain('cyi_ah_abcdefghijklmnopqrstuvwxyz012345')
  })
})
