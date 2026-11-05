import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {afterAll, describe, expect, it} from 'vitest'
import {
  chooseConversation,
  claudeConversationExists,
  clearConversation,
  codexConversationExists,
  conversationEntryPath,
  conversationFingerprint,
  CONVERSATION_MAX_AGE_MS,
  type ConversationStore,
  type ConversationTarget,
  isConversationId,
  localConversationStore,
  newConversationId,
  readConversationEntry,
  recordConversation,
} from '../src/lib/agent-conversation'
import {PlaybookSchema} from '../src/lib/schema'
import {agentConversationsDir} from '../src/lib/paths'

// CYAU-285 — the registry that lets a phase resume its agent conversation after a restart.

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-conversation-'))
afterAll(() => fs.rmSync(root, {recursive: true, force: true}))
let counter = 0

const ID = '6f1c2b7e-3d4a-4e5f-8a9b-0c1d2e3f4a5b'
const NOW = new Date('2026-11-05T10:00:00.000Z')

function fresh(): {dir: string; cwd: string} {
  const base = path.join(root, `case-${counter++}`)
  const cwd = path.join(base, 'worktree')
  fs.mkdirSync(cwd, {recursive: true})
  return {dir: path.join(base, 'conversations'), cwd}
}

function store(dir: string, exists = true): ConversationStore & {asked: Array<[string, string, string]>} {
  const asked: Array<[string, string, string]> = []
  return {dir, asked, sessionExists: (engine, id, cwd) => (asked.push([engine, id, cwd]), exists)}
}

function target(cwd: string, overrides: Partial<ConversationTarget> = {}): ConversationTarget {
  return {ticket: 'CYAU-285', phase: 'autopilot', engine: 'claude', cwd, fingerprint: 'f'.repeat(64), ...overrides}
}

describe('conversation registry', () => {
  it('lives in the state dir, one file per ticket and phase', () => {
    expect(agentConversationsDir()).toMatch(/conversations$/)
    expect(path.basename(conversationEntryPath('/s', 'CYAU-285', 'closer_staging'))).toBe('CYAU-285--closer_staging.json')
    expect(path.basename(conversationEntryPath('/s', '../x', 'a/b'))).toBe('___x--a_b.json')
  })

  it('records the conversation atomically and reads it back', () => {
    const {dir, cwd} = fresh()
    recordConversation(dir, target(cwd), ID, NOW)
    expect(readConversationEntry(dir, 'CYAU-285', 'autopilot')).toEqual({
      status: 'ok',
      entry: {
        version: 1, ticket: 'CYAU-285', phase: 'autopilot', engine: 'claude', conversation_id: ID,
        cwd: path.resolve(cwd), prompt_sha256: 'f'.repeat(64), recorded_at: NOW.toISOString(),
      },
    })
    expect(fs.readdirSync(dir).filter((name) => name.includes('.tmp-'))).toEqual([])
  })

  it('refuses to record a name that is not a UUID', () => {
    const {dir, cwd} = fresh()
    expect(() => recordConversation(dir, target(cwd), '--last')).toThrow()
    expect(readConversationEntry(dir, 'CYAU-285', 'autopilot')).toEqual({status: 'missing'})
  })

  it('clears an entry, and clearing a missing one is fine', () => {
    const {dir, cwd} = fresh()
    recordConversation(dir, target(cwd), ID, NOW)
    clearConversation(dir, 'CYAU-285', 'autopilot')
    expect(readConversationEntry(dir, 'CYAU-285', 'autopilot')).toEqual({status: 'missing'})
    expect(() => clearConversation(dir, 'CYAU-285', 'autopilot')).not.toThrow()
  })

  it('a damaged entry reads as corrupt, never as a conversation to resume', () => {
    const {dir, cwd} = fresh()
    const file = conversationEntryPath(dir, 'CYAU-285', 'autopilot')
    fs.mkdirSync(dir, {recursive: true})
    const valid = {
      version: 1, ticket: 'CYAU-285', phase: 'autopilot', engine: 'claude', conversation_id: ID,
      cwd, prompt_sha256: 'f', recorded_at: NOW.toISOString(),
    }
    for (const content of [
      '{not json',
      '[]',
      JSON.stringify({...valid, version: 2}),
      JSON.stringify({...valid, ticket: 'CYAU-1'}),
      JSON.stringify({...valid, phase: 'triage'}),
      JSON.stringify({...valid, engine: 'opencode'}),
      JSON.stringify({...valid, conversation_id: '../../x'}),
      JSON.stringify({...valid, cwd: 3}),
      JSON.stringify({...valid, prompt_sha256: null}),
      JSON.stringify({...valid, recorded_at: undefined}),
    ]) {
      fs.writeFileSync(file, content)
      expect(readConversationEntry(dir, 'CYAU-285', 'autopilot')).toEqual({status: 'corrupt'})
    }
    fs.rmSync(file)
    fs.mkdirSync(file)
    expect(readConversationEntry(dir, 'CYAU-285', 'autopilot')).toEqual({status: 'corrupt'})
  })
})

describe('chooseConversation', () => {
  it('nothing recorded: a new conversation, without a reason to report', () => {
    const {dir, cwd} = fresh()
    expect(chooseConversation(store(dir), target(cwd), undefined, NOW)).toEqual({conversation: {mode: 'new'}})
  })

  it('same ticket, phase, engine, folder and instruction, with the file present: resumes it', () => {
    const {dir, cwd} = fresh()
    recordConversation(dir, target(cwd), ID, NOW)
    const probe = store(dir)
    expect(chooseConversation(probe, target(cwd), undefined, NOW)).toEqual({conversation: {mode: 'resume', id: ID}})
    expect(probe.asked).toEqual([['claude', ID, cwd]])
    expect(readConversationEntry(dir, 'CYAU-285', 'autopilot').status).toBe('ok')
  })

  it('the conversation file is gone: starts over, says why and drops the entry', () => {
    const {dir, cwd} = fresh()
    recordConversation(dir, target(cwd), ID, NOW)
    expect(chooseConversation(store(dir, false), target(cwd), undefined, NOW)).toEqual({
      conversation: {mode: 'new'}, reason: 'conversation file no longer on this machine',
    })
    expect(readConversationEntry(dir, 'CYAU-285', 'autopilot')).toEqual({status: 'missing'})
  })

  it('a check of the file that fails counts as a missing file', () => {
    const {dir, cwd} = fresh()
    recordConversation(dir, target(cwd), ID, NOW)
    const broken: ConversationStore = {dir, sessionExists: () => { throw new Error('unreadable') }}
    expect(chooseConversation(broken, target(cwd), undefined, NOW).reason).toBe('conversation file no longer on this machine')
  })

  it('a different instruction, engine or folder starts over without asking for the file', () => {
    const cases: Array<[Partial<ConversationTarget>, string]> = [
      [{fingerprint: 'a'.repeat(64)}, 'conversation recorded for a different instruction'],
      [{engine: 'codex'}, 'conversation recorded for claude, phase runs on codex'],
      [{cwd: '/elsewhere'}, 'conversation recorded in a different working folder'],
    ]
    for (const [change, reason] of cases) {
      const {dir, cwd} = fresh()
      recordConversation(dir, target(cwd), ID, NOW)
      const probe = store(dir)
      expect(chooseConversation(probe, target(cwd, change), undefined, NOW)).toEqual({conversation: {mode: 'new'}, reason})
      expect(probe.asked).toEqual([])
      expect(readConversationEntry(dir, 'CYAU-285', 'autopilot')).toEqual({status: 'missing'})
    }
  })

  it('an entry recorded too long ago is not resumed', () => {
    const {dir, cwd} = fresh()
    recordConversation(dir, target(cwd), ID, new Date(NOW.getTime() - CONVERSATION_MAX_AGE_MS - 1))
    expect(chooseConversation(store(dir), target(cwd), undefined, NOW).reason).toBe('conversation recorded too long ago')
  })

  it('a forced reason (review corrections, a failed resume) wins over a matching entry', () => {
    const {dir, cwd} = fresh()
    recordConversation(dir, target(cwd), ID, NOW)
    expect(chooseConversation(store(dir), target(cwd), 'review corrections to apply', NOW)).toEqual({
      conversation: {mode: 'new'}, reason: 'review corrections to apply',
    })
    expect(readConversationEntry(dir, 'CYAU-285', 'autopilot')).toEqual({status: 'missing'})
  })

  it('a damaged entry starts over and is removed', () => {
    const {dir, cwd} = fresh()
    fs.mkdirSync(dir, {recursive: true})
    fs.writeFileSync(conversationEntryPath(dir, 'CYAU-285', 'autopilot'), '{"version":1')
    expect(chooseConversation(store(dir), target(cwd), undefined, NOW)).toEqual({
      conversation: {mode: 'new'}, reason: 'conversation entry unreadable',
    })
    expect(readConversationEntry(dir, 'CYAU-285', 'autopilot')).toEqual({status: 'missing'})
  })
})

describe('conversationFingerprint', () => {
  const parse = (action: Record<string, unknown>) =>
    PlaybookSchema.parse({version: 1, actions: {a: {schedule: 'every 1m', containment: 'strong', ...action}}}).actions.a
  const skill = {command: '/closeyourit-skills:autopilot', args: 'CYAU-285', plugin_dir: '/skills/0.18.3'}

  it('is stable for the same instruction and changes with any part of it', () => {
    const base = conversationFingerprint(parse({type: 'claude', run: 'plan v1', skill}))
    expect(conversationFingerprint(parse({type: 'claude', run: 'plan v1', skill}))).toBe(base)
    expect(base).toMatch(/^[0-9a-f]{64}$/)
    expect(conversationFingerprint(parse({type: 'claude', run: 'plan v2', skill}))).not.toBe(base)
    expect(conversationFingerprint(parse({type: 'claude', run: 'plan v1', skill: {...skill, plugin_dir: '/skills/0.18.4'}}))).not.toBe(base)
    expect(conversationFingerprint(parse({type: 'claude', run: 'plan v1', skill: {...skill, args: 'CYAU-1'}}))).not.toBe(base)
    expect(conversationFingerprint(parse({type: 'codex', run: 'plan v1', skill}))).not.toBe(base)
    expect(conversationFingerprint(parse({type: 'claude', run: 'plan v1'}))).not.toBe(base)
    expect(conversationFingerprint(parse({type: 'shell', run: 'echo'}))).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('conversation files on this machine', () => {
  it('ids are UUIDs only, and new ones are', () => {
    expect(isConversationId(newConversationId())).toBe(true)
    expect(isConversationId('--last')).toBe(false)
    expect(isConversationId(42)).toBe(false)
  })

  it('Claude: the file under the project folder derived from the session folder', () => {
    const config = path.join(root, `claude-${counter++}`)
    const cwd = '/home/automator/.local/share/closeyourit-automator/worktrees/CYAU/CYAU-285'
    expect(claudeConversationExists(ID, cwd, config)).toBe(false)
    const folder = path.join(config, 'projects', '-home-automator--local-share-closeyourit-automator-worktrees-CYAU-CYAU-285')
    fs.mkdirSync(folder, {recursive: true})
    expect(claudeConversationExists(ID, cwd, config)).toBe(false)
    fs.writeFileSync(path.join(folder, `${ID}.jsonl`), '{}\n')
    expect(claudeConversationExists(ID, cwd, config)).toBe(true)
    expect(claudeConversationExists('../x', cwd, config)).toBe(false)
  })

  it('Claude: a shortened project folder is found too', () => {
    const config = path.join(root, `claude-${counter++}`)
    const folder = path.join(config, 'projects', '-very-long-folder-shortened-abc123')
    fs.mkdirSync(folder, {recursive: true})
    fs.writeFileSync(path.join(config, 'projects', 'stray-file'), '')
    expect(claudeConversationExists(ID, '/x'.repeat(150), config)).toBe(false)
    fs.writeFileSync(path.join(folder, `${ID}.jsonl`), '{}\n')
    expect(claudeConversationExists(ID, '/x'.repeat(150), config)).toBe(true)
  })

  it('Codex: the rollout file under sessions/YYYY/MM/DD', () => {
    const home = path.join(root, `codex-${counter++}`)
    expect(codexConversationExists(ID, home)).toBe(false)
    const day = path.join(home, 'sessions', '2026', '11', '05')
    fs.mkdirSync(day, {recursive: true})
    fs.writeFileSync(path.join(day, 'rollout-2026-11-05T10-00-00-0192f0c4-5d8a-7f7e-9a3c-2f1e8c3b9d10.jsonl'), '{}\n')
    expect(codexConversationExists(ID, home)).toBe(false)
    fs.writeFileSync(path.join(day, `rollout-2026-11-05T10-00-00-${ID}.jsonl`), '{}\n')
    expect(codexConversationExists(ID.toUpperCase(), home)).toBe(true)
    expect(codexConversationExists('not-a-uuid', home)).toBe(false)
  })

  it('the local store asks each engine where it keeps its conversations', () => {
    const config = path.join(root, `claude-${counter++}`)
    const home = path.join(root, `codex-${counter++}`)
    const cwd = '/w'
    fs.mkdirSync(path.join(config, 'projects', '-w'), {recursive: true})
    fs.writeFileSync(path.join(config, 'projects', '-w', `${ID}.jsonl`), '')
    fs.mkdirSync(path.join(home, 'sessions'), {recursive: true})
    fs.writeFileSync(path.join(home, 'sessions', `rollout-${ID}.jsonl`), '')
    const local = localConversationStore('/registry', () => home, {CLAUDE_CONFIG_DIR: config})
    expect(local.dir).toBe('/registry')
    expect(local.sessionExists('claude', ID, cwd)).toBe(true)
    expect(local.sessionExists('codex', ID, cwd)).toBe(true)
    const defaults = localConversationStore('/registry', () => home, {CLAUDE_CONFIG_DIR: 'relative'})
    expect(defaults.sessionExists('claude', ID, '/nowhere-' + String(counter))).toBe(false)
  })
})
