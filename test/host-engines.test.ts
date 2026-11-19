import {describe, expect, it} from 'vitest'
import {enginesInUse, HOST_ENGINES_TTL_MS, makeHostEnginesStore, parseHostEngines} from '../src/lib/host-engines'

// CYAU-305: the engines the server declares in the beat response decide which ones are checked before a claim.

describe('parseHostEngines', () => {
  it('reads a complete list under data', () => {
    expect(parseHostEngines({data: {engines: {work: 'codex', reviewer: 'opencode', supporter: 'claude'}}}))
      .toEqual({work: 'codex', reviewer: 'opencode', supporter: 'claude'})
  })

  it('reads a top-level list too', () => {
    expect(parseHostEngines({engines: {work: 'claude', reviewer: 'codex', supporter: 'codex'}}))
      .toEqual({work: 'claude', reviewer: 'codex', supporter: 'codex'})
  })

  it('a supporter declared off (null) is complete', () => {
    expect(parseHostEngines({data: {engines: {work: 'codex', reviewer: 'opencode', supporter: null}}}))
      .toEqual({work: 'codex', reviewer: 'opencode', supporter: null})
  })

  it.each([
    ['no body', null],
    ['no engines', {data: {}}],
    ['engines not an object', {data: {engines: 'codex'}}],
    ['engines as an array', {data: {engines: ['codex', 'codex', 'codex']}}],
    ['an unknown work engine', {data: {engines: {work: 'gemini', reviewer: 'codex', supporter: 'codex'}}}],
    ['OpenCode as the work engine', {data: {engines: {work: 'opencode', reviewer: 'codex', supporter: 'codex'}}}],
    ['an unknown reviewer', {data: {engines: {work: 'codex', reviewer: 'Codex', supporter: 'codex'}}}],
    ['an unknown supporter', {data: {engines: {work: 'codex', reviewer: 'codex', supporter: 'gpt'}}}],
    ['a missing reviewer', {data: {engines: {work: 'codex', supporter: 'codex'}}}],
    ['a missing supporter (not declared off)', {data: {engines: {work: 'codex', reviewer: 'codex'}}}],
  ])('%s → no list', (_label, body) => {
    expect(parseHostEngines(body)).toBeNull()
  })
})

describe('enginesInUse', () => {
  it('no list → both engines, with no role to name', () => {
    expect([...enginesInUse(null)]).toEqual([['claude', []], ['codex', []]])
  })

  it('all on Codex → only Codex, for every role', () => {
    expect([...enginesInUse({work: 'codex', reviewer: 'codex', supporter: 'codex'})]).toEqual([['codex', ['lavoro', 'rilettura', 'supporto']]])
  })

  it('the supporter on Claude brings Claude in', () => {
    expect([...enginesInUse({work: 'codex', reviewer: 'codex', supporter: 'claude'})])
      .toEqual([['codex', ['lavoro', 'rilettura']], ['claude', ['supporto']]])
  })

  it('OpenCode and a supporter off add no engine', () => {
    expect([...enginesInUse({work: 'codex', reviewer: 'opencode', supporter: null})]).toEqual([['codex', ['lavoro']]])
  })
})

describe('makeHostEnginesStore', () => {
  const list = {work: 'codex' as const, reviewer: 'codex' as const, supporter: 'codex' as const}
  const at = new Date('2026-11-05T10:00:00.000Z')

  it('holds the list until it is five minutes old', () => {
    const store = makeHostEnginesStore()
    store.replace(list, at)
    expect(store.current(new Date(at.getTime() + HOST_ENGINES_TTL_MS - 1))).toEqual(list)
    expect(store.current(new Date(at.getTime() + HOST_ENGINES_TTL_MS))).toBeNull()
  })

  it('null clears the previous list', () => {
    const store = makeHostEnginesStore()
    store.replace(list, at)
    store.replace(null, at)
    expect(store.current(at)).toBeNull()
  })

  it('a list from the future is not trusted', () => {
    const store = makeHostEnginesStore()
    store.replace(list, at)
    expect(store.current(new Date(at.getTime() - 1))).toBeNull()
  })
})
