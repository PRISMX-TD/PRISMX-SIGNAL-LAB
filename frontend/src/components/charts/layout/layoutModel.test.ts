// 多图布局纯逻辑的单测（阶段 6）/ unit tests for the multi-chart layout logic (phase 6)
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SYNC, GRIDS, LAYOUT_MAX_BYTES, cellArea, fitLayoutSize, gridTemplate, layoutBytes, mergeDoc,
  paneCount, patchPanes, sanitizeLayout, sanitizePaneState, sanitizeSync, uniqueName, visibleCells, withGrid,
  type LayoutDoc,
} from './layoutModel'
import { normalizeLayoutPrefs } from './useChartLayouts'

const FB = { symbol: 'XAUUSD', interval: '15' }
const doc = (over: Partial<LayoutDoc> = {}): LayoutDoc => ({ v: 1, grid: '1', sync: { ...DEFAULT_SYNC }, active: 0, panes: [{ ...FB }], ...over })

describe('grid → cells', () => {
  it('counts panes per grid', () => {
    expect(GRIDS.map(paneCount)).toEqual([1, 2, 2, 3, 4])
  })
  it('builds templates', () => {
    expect(gridTemplate('1')).toEqual({ cols: 'minmax(0, 1fr)', rows: 'minmax(0, 1fr)' })
    expect(gridTemplate('2h').cols.split(' minmax').length).toBe(2)
    expect(gridTemplate('2v').rows.split(' minmax').length).toBe(2)
    expect(gridTemplate('3').cols).toContain('3fr')
  })
  it('places cells without overlap', () => {
    expect(cellArea('2h', 0)).toBe('1 / 1 / 2 / 2')
    expect(cellArea('2h', 1)).toBe('1 / 2 / 2 / 3')
    expect(cellArea('2v', 1)).toBe('2 / 1 / 3 / 2')
    // 3：左边一格占两行 / grid 3: the left cell spans both rows
    expect(cellArea('3', 0)).toBe('1 / 1 / 3 / 2')
    expect(cellArea('3', 2)).toBe('2 / 2 / 3 / 3')
    expect(new Set([0, 1, 2, 3].map((i) => cellArea('4', i))).size).toBe(4)
  })
  it('shows only the active cell on phones and when single', () => {
    expect(visibleCells('4', 2, false, null)).toEqual({ mounted: [2], shown: [2] })
    expect(visibleCells('1', 3, true, null)).toEqual({ mounted: [0], shown: [0] })
  })
  it('mounts every cell but shows only the maximised one', () => {
    expect(visibleCells('4', 0, true, null)).toEqual({ mounted: [0, 1, 2, 3], shown: [0, 1, 2, 3] })
    expect(visibleCells('3', 0, true, 1)).toEqual({ mounted: [0, 1, 2], shown: [1] })
    // 越界的最大化下标被忽略 / an out-of-range maximised index is ignored
    expect(visibleCells('2h', 0, true, 3).shown).toEqual([0, 1])
  })
  it('clamps an out-of-range active cell', () => {
    expect(visibleCells('2v', 3, false, null).shown).toEqual([0])
  })
})

describe('sync flags', () => {
  it('defaults to crosshair only', () => {
    expect(sanitizeSync(null)).toEqual({ symbol: false, interval: false, crosshair: true, time: false, date: false })
  })
  it('keeps booleans and drops junk', () => {
    expect(sanitizeSync({ symbol: true, time: 'yes', date: true, extra: 1 })).toEqual({ ...DEFAULT_SYNC, symbol: true, date: true })
  })
})

describe('sanitize / migrate', () => {
  it('falls back to a single chart for junk', () => {
    expect(sanitizeLayout(null, FB)).toEqual(doc())
    expect(sanitizeLayout({ v: 9, grid: '4', panes: [] }, FB)).toEqual(doc())
  })
  it('accepts v1 and fills missing cells from cell 0', () => {
    const d = sanitizeLayout({ v: 1, grid: '4', active: 2, panes: [{ symbol: 'EURUSD', interval: '60' }, { symbol: 'BTCUSD', interval: 'D' }] }, FB)
    expect(d.grid).toBe('4')
    expect(d.active).toBe(2)
    expect(d.panes.map((p) => p.symbol)).toEqual(['EURUSD', 'BTCUSD', 'EURUSD', 'EURUSD'])
  })
  it('migrates a v0 draft (symbols array)', () => {
    const d = sanitizeLayout({ grid: '2h', symbols: ['EURUSD', 'GBPUSD'], interval: '5' }, FB)
    expect(d.panes).toEqual([{ symbol: 'EURUSD', interval: '5' }, { symbol: 'GBPUSD', interval: '5' }])
  })
  it('rejects bad symbols / intervals and clamps active', () => {
    const d = sanitizeLayout({ v: 1, grid: '2v', active: 7, panes: [{ symbol: '<script>', interval: '15' }, { symbol: 'EURUSD', interval: '1 5' }] }, FB)
    expect(d.panes[0].symbol).toBe('XAUUSD')
    expect(d.panes[1].interval).toBe('15')
    expect(d.active).toBe(0)
  })
  it('caps panes at 4 and cleans compare entries', () => {
    const many = Array.from({ length: 9 }, () => ({ symbol: 'EURUSD', interval: '15' }))
    expect(sanitizeLayout({ v: 1, grid: '4', panes: many }, FB).panes).toHaveLength(4)
    const p = sanitizePaneState({ symbol: 'EURUSD', interval: '15', compare: [{ symbol: 'GBPUSD', mode: 'x' }, { symbol: '' }, 3] }, FB)
    expect(p.compare).toEqual([{ symbol: 'GBPUSD', mode: 'percent', color: '#7c5cff' }])
  })
  it('keeps object indicator layouts and drops others', () => {
    expect(sanitizePaneState({ symbol: 'EURUSD', interval: '15', ind: { list: [] } }, FB).ind).toEqual({ list: [] })
    expect(sanitizePaneState({ symbol: 'EURUSD', interval: '15', ind: 'x' }, FB).ind).toBeUndefined()
  })
})

describe('size cap', () => {
  it('passes small docs through untouched', () => {
    const d = doc()
    expect(fitLayoutSize(d)).toBe(d)
  })
  it('drops later cells\' indicators first', () => {
    const big = { list: 'x'.repeat(LAYOUT_MAX_BYTES) }
    const d = doc({ grid: '2h', panes: [{ ...FB, ind: { list: [] } }, { ...FB, ind: big }] })
    const f = fitLayoutSize(d)!
    expect(f.panes[1].ind).toBeUndefined()
    expect(f.panes[0].ind).toEqual({ list: [] })
    expect(layoutBytes(f)).toBeLessThanOrEqual(LAYOUT_MAX_BYTES)
  })
  it('returns null when nothing can be dropped', () => {
    expect(fitLayoutSize(doc({ panes: [{ symbol: 'X', interval: '1', chartType: 'y' }] }), 10)).toBeNull()
  })
})

describe('grid changes and patches', () => {
  it('seeds new cells from the active one and keeps extra cells', () => {
    const seed = { symbol: 'EURUSD', interval: '60', chartType: 'bars', ind: { list: [1] } }
    const d = withGrid(doc(), '3', seed)
    expect(d.panes).toHaveLength(3)
    expect(d.panes[2]).toEqual(seed)
    const back = withGrid({ ...d, active: 2 }, '1', seed)
    expect(back.panes).toHaveLength(3)
    expect(back.active).toBe(0)
  })
  it('patches one cell or all (sync)', () => {
    const d = doc({ grid: '2h', panes: [{ ...FB }, { symbol: 'EURUSD', interval: '5' }] })
    expect(patchPanes(d, 1, { interval: '60' }, false).panes.map((p) => p.interval)).toEqual(['15', '60'])
    expect(patchPanes(d, 1, { symbol: 'BTCUSD' }, true).panes.map((p) => p.symbol)).toEqual(['BTCUSD', 'BTCUSD'])
    // 没变化时原样返回 / unchanged → same object
    expect(patchPanes(d, 0, { symbol: 'XAUUSD' }, false)).toBe(d)
  })
  it('merges a remote layout but keeps local cell 0 and active', () => {
    const local = doc({ grid: '2h', active: 1, panes: [{ ...FB }, { symbol: 'EURUSD', interval: '5' }] })
    const remote = doc({ grid: '4', active: 3, panes: [{ symbol: 'A', interval: '1' }, { symbol: 'B', interval: '1' }, { symbol: 'C', interval: '1' }, { symbol: 'D', interval: '1' }] })
    const m = mergeDoc(local, remote, false)
    expect(m.panes[0]).toEqual(FB)
    expect(m.panes[3].symbol).toBe('D')
    expect(m.active).toBe(1)
    expect(mergeDoc(local, remote, true)).toBe(remote)
  })
  it('takes cell 0\'s compare symbols from the remote layout', () => {
    const cmp = [{ symbol: 'XAGUSD', mode: 'percent' as const, color: '#f59e0b' }]
    const local = doc({ panes: [{ ...FB, compare: [{ symbol: 'OLD', mode: 'scale' as const, color: '#fff' }] }] })
    expect(mergeDoc(local, doc({ panes: [{ symbol: 'A', interval: '1', compare: cmp }] }), false).panes[0]).toEqual({ ...FB, compare: cmp })
    expect(mergeDoc(local, doc({ panes: [{ symbol: 'A', interval: '1' }] }), false).panes[0]).toEqual(FB)
  })
  it('makes unique names', () => {
    expect(uniqueName('我的布局', [])).toBe('我的布局')
    expect(uniqueName('我的布局', ['我的布局', '我的布局 2'])).toBe('我的布局 3')
    expect(uniqueName('  ', [])).toBe('Layout')
  })
})

describe('layout prefs', () => {
  it('defaults to autosave on and no id', () => {
    expect(normalizeLayoutPrefs(undefined)).toEqual({ id: null, autosave: true })
    expect(normalizeLayoutPrefs({ id: 'abc', autosave: false })).toEqual({ id: 'abc', autosave: false })
    expect(normalizeLayoutPrefs({ id: '', autosave: 'no' })).toEqual({ id: null, autosave: true })
  })
})
