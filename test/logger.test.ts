import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterAll, describe, expect, it} from 'vitest'
import {appendLogFooter, boundedExcerpt, formatTimestamp, openLog, prune} from '../src/lib/logger'
import {UNPARSABLE_EXCERPT_CHARS} from '../src/lib/runner'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automator-log-'))
let counter = 0
const subdir = (): string => path.join(dir, `logs-${counter++}`)

afterAll(() => fs.rmSync(dir, {recursive: true, force: true}))

describe('formatTimestamp', () => {
  it('produce YYYYMMDDTHHmmss (UTC)', () => {
    expect(formatTimestamp(new Date('2026-07-07T12:34:56.789Z'))).toBe('20260707T123456')
  })
})

describe('openLog', () => {
  it('creates the <action>-<ts>.log file and writes header/body/footer', () => {
    const logDir = subdir()
    const now = new Date('2026-07-07T12:34:56.000Z')
    const log = openLog(logDir, 'triage', now)
    expect(path.basename(log.path)).toBe('triage-20260707T123456.log')

    log.header({type: 'shell', command: 'echo x', cwd: '/tmp', start: now})
    log.write('output riga\n')
    log.footer({status: 'success'})

    const content = fs.readFileSync(log.path, 'utf8')
    expect(content).toContain('# azione: triage')
    expect(content).toContain('output riga')
    expect(content).toContain('# status: success')
  })

  // CYAU-105: `runAction` writes the footer as soon as the process ends, so BEFORE the runner knows whether the
  // delivery started. Without a second footer the file keeps saying `status: success` on a run that
  // delivered nothing — it is the footer that sent the diagnosis astray for two days.
  it('appendLogFooter adds the terminal outcome AFTER the runAction footer, without rewriting it', () => {
    const logDir = subdir()
    const now = new Date('2026-07-07T12:34:56.000Z')
    const log = openLog(logDir, 'triage', now)
    log.header({type: 'claude', command: 'claude -p', cwd: '/tmp', start: now})
    log.footer({status: 'success', exit_code: 0})

    expect(appendLogFooter(log.path, {delivery: 'not-attempted', error_code: 'C422-WORKFLOW-001'})).toBe(true)

    const content = fs.readFileSync(log.path, 'utf8')
    expect(content).toContain('# status: success')
    expect(content).toContain('# delivery: not-attempted')
    expect(content).toContain('# error_code: C422-WORKFLOW-001')
    // Append-only: the history is not rewritten, the final outcome is appended at the end.
    expect(content.indexOf('# status: success')).toBeLessThan(content.indexOf('# delivery: not-attempted'))
  })

  it('appendLogFooter also redacts and sanitizes the delimited excerpt', () => {
    const logDir = subdir()
    const log = openLog(logDir, 'x', new Date('2026-07-07T00:00:00.000Z'))
    const token = `cyi_ah_${'A'.repeat(24)}`
    appendLogFooter(log.path, {delivery: 'not-attempted'}, {
      label: 'risultato non interpretabile',
      text: `prima[31m ${token}\nseconda riga`,
    })

    const content = fs.readFileSync(log.path, 'utf8')
    expect(content).toContain('# ---- risultato non interpretabile ----')
    expect(content).toContain('# ---- fine risultato non interpretabile ----')
    expect(content).not.toContain(token)
    expect(content).not.toContain('')
    expect(content).toContain('seconda riga') // i newline dell'estratto restano
  })

  it('appendLogFooter without excerpt does not write an empty block, and a non-writable path returns false', () => {
    const logDir = subdir()
    const log = openLog(logDir, 'y', new Date('2026-07-07T00:00:00.000Z'))
    appendLogFooter(log.path, {delivery: 'ok'}, {label: 'vuoto', text: ''})
    expect(fs.readFileSync(log.path, 'utf8')).not.toContain('---- vuoto ----')

    // A log that cannot be written must not throw (it does not abort the tick) but must not lie either: the
    // caller receives `false` and reports it.
    expect(appendLogFooter(path.join(dir, 'nessuna-directory', 'x.log'), {delivery: 'ok'})).toBe(false)
  })

  it('boundedExcerpt tiene testa e coda e dichiara quanto ha omesso', () => {
    expect(boundedExcerpt('corto', 100)).toBe('corto')
    const long = `${'A'.repeat(50)}${'B'.repeat(50)}${'C'.repeat(50)}`
    const excerpt = boundedExcerpt(long, 40)
    expect(excerpt.startsWith('A'.repeat(20))).toBe(true)
    expect(excerpt.endsWith('C'.repeat(20))).toBe(true)
    expect(excerpt).toContain('[110 caratteri omessi]')
    expect(boundedExcerpt(long, 0)).toBe('')
  })

  // CYAU-186 — the cut itself is right (above), but the LIMIT it is called with decides whether a
  // real result survives or not. With 4096 characters a 6 KB delivery result lost the
  // middle — the work report — and the cause of the rejection became undeterminable.
  //
  // This test pins the size: a result as big as the real ones (the largest seen
  // in production is 19 KB) must end up in the log WHOLE, without the omission mark.
  it('a result of real size stays whole in the log (CYAU-186)', () => {
    const risultatoVero = 'X'.repeat(64 * 1024)

    const excerpt = boundedExcerpt(risultatoVero, UNPARSABLE_EXCERPT_CHARS)

    expect(excerpt).toBe(risultatoVero)
    expect(excerpt).not.toContain('caratteri omessi')
  })

  // The cap stays though: a megabyte of stdout in every log at every failure helps
  // nobody, and it is the reason the cut exists. The size changed, not the rule.
  it('a pathological output is still cut (CYAU-186)', () => {
    const patologico = 'Y'.repeat(1024 * 1024)

    expect(boundedExcerpt(patologico, UNPARSABLE_EXCERPT_CHARS)).toContain('caratteri omessi')
  })

  it('sanitizes the control sequences (ANSI) keeping the newlines', () => {
    const logDir = subdir()
    const log = openLog(logDir, 'x', new Date('2026-07-07T00:00:00.000Z'))
    log.write('a[31mrosso[0m\nb')
    const content = fs.readFileSync(log.path, 'utf8')
    expect(content).not.toContain('')
    expect(content).toContain('\n')
  })

  it('masks a token split between writes preserving the sequence and the output after the flush', () => {
    const logDir = subdir()
    const log = openLog(logDir, 'stream', new Date('2026-07-07T00:00:00.000Z'))
    const token = `cyi_ah_${'A'.repeat(24)}`
    log.write('prima:')
    log.write(token.slice(0, 5))
    log.write(token.slice(5, 13))
    log.write(`${token.slice(13)}:dopo`)
    log.footer({status: 'success'})

    const content = fs.readFileSync(log.path, 'utf8')
    expect(content).toContain('prima:[REDACTED]:dopo')
    expect(content).not.toContain(token)
    expect(content.indexOf(':dopo')).toBeLessThan(content.indexOf('# status: success'))
  })

  it('at flush does not lose harmless fragments and keeps the split placeholders', () => {
    const logDir = subdir()
    const log = openLog(logDir, 'flush', new Date('2026-07-07T00:00:00.000Z'))
    log.write('uno')
    log.write('due cyi_ah_')
    log.write('… fine')
    log.footer({status: 'success'})

    const content = fs.readFileSync(log.path, 'utf8')
    expect(content).toContain('unodue cyi_ah_… fine')
  })

  it('caps the inter-stream buffer conservatively redacting a tail left open', () => {
    const logDir = subdir()
    const log = openLog(logDir, 'bounded', new Date('2026-07-07T00:00:00.000Z'))
    const token = 'cyi_ah_ABCDEF'
    log.write('prima:cyi_ah_', 'stdout')
    log.write(`stderr:${'x'.repeat(1024 * 1024)}\n`, 'stderr')
    log.write('stderr-before:cyi_ah_', 'stderr')
    log.write('ABCDEF ', 'stdout')
    log.write('XYZ:stderr-after\n', 'stderr')
    log.footer({status: 'success'})

    const content = fs.readFileSync(log.path, 'utf8')
    expect(content.indexOf('prima:[REDACTED]')).toBeLessThan(content.indexOf('stderr:'))
    expect(content.indexOf('stderr:')).toBeLessThan(content.indexOf('stderr-before:[REDACTED]'))
    expect(content).not.toContain('ABCDEF')
    expect(content).not.toContain('XYZ')
    expect(content).not.toContain(token)
  })

  // CYAU-113: the log can contain, even after the best-effort redaction, sensitive data → it must be
  // readable ONLY by the user who writes it (file 0o600, directory 0o700).
  it('creates the 0o700 directory and the 0o600 log file', () => {
    const logDir = subdir()
    const log = openLog(logDir, 'perm', new Date('2026-07-07T00:00:00.000Z'))
    log.write('output riga\n')
    log.footer({status: 'success'})

    expect(fs.statSync(logDir).mode & 0o777).toBe(0o700)
    expect(fs.statSync(log.path).mode & 0o777).toBe(0o600)
  })

  // CYAU-113: the cloud credential shapes and the session tokens now really disappear from the log FILE.
  it('masks a cloud credential and a session token in the log', () => {
    const logDir = subdir()
    const log = openLog(logDir, 'cred', new Date('2026-07-07T00:00:00.000Z'))
    const aws = `AKIA${'A'.repeat(16)}`
    const jwt = `eyJ${'a'.repeat(10)}.${'b'.repeat(10)}.${'c'.repeat(10)}`
    log.write(`aws=${aws} jwt=${jwt}\n`)
    log.footer({status: 'success'})

    const content = fs.readFileSync(log.path, 'utf8')
    expect(content).not.toContain(aws)
    expect(content).not.toContain(jwt)
    expect(content).toContain('aws=[REDACTED] jwt=[REDACTED]')
  })
})

describe('prune — retention at the X-1 / X / X+1 boundaries', () => {
  function seed(logDir: string, action: string, stamp: string): void {
    fs.mkdirSync(logDir, {recursive: true})
    fs.writeFileSync(path.join(logDir, `${action}-${stamp}.log`), 'x')
  }

  it('deletes only the logs older than the cutoff (boundaries X-1 / X / X+1)', () => {
    const logDir = subdir()
    const now = new Date('2026-07-10T00:00:00.000Z') // cutoff with keepDays=7 → 2026-07-03T00:00:00Z
    seed(logDir, 'a', '20260701T000000') // very old → deleted
    seed(logDir, 'a', '20260702T235959') // cutoff-1s → deleted
    seed(logDir, 'a', '20260703T000000') // exactly cutoff → kept (not < cutoff)
    seed(logDir, 'a', '20260703T000001') // cutoff+1s → kept
    const removed = prune(logDir, 7, now)
    expect(removed).toBe(2)
    expect(fs.existsSync(path.join(logDir, 'a-20260703T000000.log'))).toBe(true)
    expect(fs.existsSync(path.join(logDir, 'a-20260703T000001.log'))).toBe(true)
  })

  it('directory inesistente → 0', () => {
    expect(prune(path.join(dir, 'mai'), 7, new Date('2026-07-10T00:00:00.000Z'))).toBe(0)
  })

  it('ignores the files without a valid timestamp in the name', () => {
    const logDir = subdir()
    fs.mkdirSync(logDir, {recursive: true})
    fs.writeFileSync(path.join(logDir, 'senza-timestamp.log'), 'x')
    expect(prune(logDir, 0, new Date('2026-07-10T00:00:00.000Z'))).toBe(0)
  })
})
