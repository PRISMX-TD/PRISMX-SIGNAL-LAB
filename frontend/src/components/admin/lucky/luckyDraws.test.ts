import { describe, expect, it } from 'vitest'
import { NOTE_MAX, PAGE, clampOffset, csvFileName, csvQuery, drawsQuery, parseNote } from './luckyDraws'

describe('luckyDraws.drawsQuery', () => {
  it('pending mode always asks for the open queue across every round, ignoring the dropdown', () => {
    expect(drawsQuery('pending', 'delivered', 50, 'r1')).toEqual({ status: 'open', limit: PAGE, offset: 50 })
  })
  it('all mode passes the chosen status for the selected round, empty = every status', () => {
    expect(drawsQuery('all', '', 0, 'r1')).toEqual({ status: '', roundId: 'r1', limit: PAGE, offset: 0 })
    expect(drawsQuery('all', 'submitted', 0, 'r1').status).toBe('submitted')
    expect(drawsQuery('all', '', 0).roundId).toBeUndefined()
  })
})

describe('luckyDraws.csvQuery', () => {
  it('exports what the list shows', () => {
    expect(csvQuery('pending', 'delivered', 'r1')).toEqual({ status: 'open' })
    expect(csvQuery('all', 'delivered', 'r1')).toEqual({ status: 'delivered', roundId: 'r1' })
  })
})

describe('luckyDraws.clampOffset', () => {
  it('keeps a valid offset', () => {
    expect(clampOffset(0, 0)).toBe(0)
    expect(clampOffset(50, 51)).toBe(50)
  })
  it('steps back to the last page when the current one emptied out', () => {
    expect(clampOffset(50, 50)).toBe(0)
    expect(clampOffset(100, 51)).toBe(50)
    expect(clampOffset(50, 0)).toBe(0)
  })
})

describe('luckyDraws.parseNote', () => {
  it('treats a dismissed prompt as abort', () => {
    expect(parseNote('deliver', null)).toEqual({ kind: 'abort' })
    expect(parseNote('cancel', null)).toEqual({ kind: 'abort' })
  })
  it('allows an empty delivery note but not an empty cancel reason', () => {
    expect(parseNote('deliver', '  ')).toEqual({ kind: 'ok', note: '' })
    expect(parseNote('cancel', '   ')).toEqual({ kind: 'empty' })
  })
  it('trims and enforces the backend length cap', () => {
    expect(parseNote('cancel', ' 库存不足 ')).toEqual({ kind: 'ok', note: '库存不足' })
    expect(parseNote('deliver', 'x'.repeat(NOTE_MAX))).toEqual({ kind: 'ok', note: 'x'.repeat(NOTE_MAX) })
    expect(parseNote('deliver', 'x'.repeat(NOTE_MAX + 1))).toEqual({ kind: 'long' })
  })
})

describe('luckyDraws.csvFileName', () => {
  it('names the file after the queue', () => {
    expect(csvFileName('pending', '')).toBe('lucky-draws-pending.csv')
    expect(csvFileName('all', '')).toBe('lucky-draws.csv')
    expect(csvFileName('all', 'delivered')).toBe('lucky-draws-delivered.csv')
  })
})
