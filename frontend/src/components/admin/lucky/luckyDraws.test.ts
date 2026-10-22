import { describe, expect, it } from 'vitest'
import { NOTE_MAX, PAGE, clampOffset, csvFileName, drawsQuery, parseNote } from './luckyDraws'

describe('luckyDraws.drawsQuery', () => {
  it('pending mode always asks for the open queue, ignoring the dropdown', () => {
    expect(drawsQuery('pending', 'delivered', 50)).toEqual({ status: 'open', limit: PAGE, offset: 50 })
  })
  it('all mode passes the chosen status, empty = every status', () => {
    expect(drawsQuery('all', '', 0)).toEqual({ status: '', limit: PAGE, offset: 0 })
    expect(drawsQuery('all', 'submitted', 0).status).toBe('submitted')
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
