import { describe, expect, it } from 'vitest'
import { MAX_GROUPS, MAX_GROUP_NAME, normalizeWlGroups, wlGroupsReducer, type WlGroup } from './wlGroups'

const base: WlGroup[] = [{ id: 'g1', name: 'Metals', symbols: ['XAUUSD'] }]

describe('wlGroupsReducer', () => {
  it('creates, renames and deletes groups', () => {
    let s = wlGroupsReducer(base, { type: 'create', id: 'g2', name: '  My   FX  ', symbols: ['EURUSD', 'EURUSD'] })
    expect(s[1]).toEqual({ id: 'g2', name: 'My FX', symbols: ['EURUSD'] })
    s = wlGroupsReducer(s, { type: 'rename', id: 'g2', name: 'Majors' })
    expect(s[1].name).toBe('Majors')
    s = wlGroupsReducer(s, { type: 'delete', id: 'g1' })
    expect(s.map((g) => g.id)).toEqual(['g2'])
  })
  it('adds, removes and toggles symbols', () => {
    let s = wlGroupsReducer(base, { type: 'add', id: 'g1', symbol: 'XAGUSD' })
    expect(s[0].symbols).toEqual(['XAUUSD', 'XAGUSD'])
    s = wlGroupsReducer(s, { type: 'toggle', id: 'g1', symbol: 'XAUUSD' })
    expect(s[0].symbols).toEqual(['XAGUSD'])
    s = wlGroupsReducer(s, { type: 'toggle', id: 'g1', symbol: 'XAUUSD' })
    expect(s[0].symbols).toEqual(['XAGUSD', 'XAUUSD'])
    s = wlGroupsReducer(s, { type: 'remove', id: 'g1', symbol: 'XAGUSD' })
    expect(s[0].symbols).toEqual(['XAUUSD'])
  })
  it('returns the same array for no-ops', () => {
    expect(wlGroupsReducer(base, { type: 'create', id: 'g1', name: 'dup id' })).toBe(base)
    expect(wlGroupsReducer(base, { type: 'create', id: 'g9', name: '   ' })).toBe(base)
    expect(wlGroupsReducer(base, { type: 'rename', id: 'g1', name: 'Metals' })).toBe(base)
    expect(wlGroupsReducer(base, { type: 'rename', id: 'nope', name: 'x' })).toBe(base)
    expect(wlGroupsReducer(base, { type: 'add', id: 'g1', symbol: 'XAUUSD' })).toBe(base)
    expect(wlGroupsReducer(base, { type: 'remove', id: 'g1', symbol: 'EURUSD' })).toBe(base)
    expect(wlGroupsReducer(base, { type: 'delete', id: 'nope' })).toBe(base)
    expect(wlGroupsReducer(base, { type: 'toggle', id: 'nope', symbol: 'A' })).toBe(base)
  })
  it('caps the number of groups and the name length', () => {
    let s: WlGroup[] = []
    for (let i = 0; i < MAX_GROUPS + 3; i++) s = wlGroupsReducer(s, { type: 'create', id: `g${i}`, name: `G${i}` })
    expect(s).toHaveLength(MAX_GROUPS)
    s = wlGroupsReducer(s, { type: 'rename', id: 'g0', name: 'x'.repeat(80) })
    expect(s[0].name).toHaveLength(MAX_GROUP_NAME)
  })
})

describe('normalizeWlGroups', () => {
  it('drops bad entries, duplicate ids and non-string symbols', () => {
    expect(normalizeWlGroups(null)).toEqual([])
    expect(normalizeWlGroups({})).toEqual([])
    const out = normalizeWlGroups([
      { id: 'a', name: 'A', symbols: ['X', 'X', 3, 'Y'] },
      { id: 'a', name: 'dup', symbols: [] },
      { id: 'b', name: '   ', symbols: [] },
      { id: 7, name: 'bad id' },
      'junk',
      { id: 'c', name: 'C' },
    ])
    expect(out).toEqual([{ id: 'a', name: 'A', symbols: ['X', 'Y'] }, { id: 'c', name: 'C', symbols: [] }])
  })
})
