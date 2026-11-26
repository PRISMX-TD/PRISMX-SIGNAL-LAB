// 多图布局的纯逻辑（阶段 6）：网格 → 格子位置、同步开关、布局 JSON 的清洗 / 迁移 / 限长、
// 远端布局与本地的合并。不碰 React、不碰图表，单测见 layoutModel.test.ts。
// Pure multi-chart layout logic (phase 6): grid → cell placement, sync flags, sanitising /
// migrating / size-capping the layout JSON, merging a remote layout into the local one. No
// React, no chart; tests in layoutModel.test.ts.
import type { CompareEntry, CompareMode, PaneState } from './paneState'

// 网格：1 = 单图；2h = 左右两图；2v = 上下两图；3 = 左一大 + 右两小；4 = 2×2
// Grids: 1 = single; 2h = side by side; 2v = stacked; 3 = one large left + two stacked right; 4 = 2×2
export type GridId = '1' | '2h' | '2v' | '3' | '4'
export const GRIDS: readonly GridId[] = ['1', '2h', '2v', '3', '4']
export const MAX_PANES = 4
// 后端每份布局 data ≤64KB / the backend caps each layout's data at 64KB
export const LAYOUT_MAX_BYTES = 64 * 1024

export interface SyncFlags {
  symbol: boolean
  interval: boolean
  crosshair: boolean
  // 可见时间范围（平移 / 缩放）/ the visible time range (pan / zoom)
  time: boolean
  // 日期范围（区间快捷键、跳转到日期）/ date range (range presets, go to date)
  date: boolean
}
export const SYNC_KEYS: readonly (keyof SyncFlags)[] = ['symbol', 'interval', 'crosshair', 'time', 'date']
export const DEFAULT_SYNC: SyncFlags = { symbol: false, interval: false, crosshair: true, time: false, date: false }

export interface LayoutDoc {
  v: 1
  grid: GridId
  sync: SyncFlags
  // 当前选中的格子 / the active cell
  active: number
  panes: PaneState[]
}

export function isGrid(v: unknown): v is GridId {
  return typeof v === 'string' && (GRIDS as readonly string[]).includes(v)
}

export function paneCount(g: GridId): number {
  return g === '1' ? 1 : g === '2h' || g === '2v' ? 2 : g === '3' ? 3 : 4
}

// CSS 网格模板 / CSS grid template
export function gridTemplate(g: GridId): { cols: string; rows: string } {
  const one = 'minmax(0, 1fr)'
  const two = `${one} ${one}`
  switch (g) {
    case '2h': return { cols: two, rows: one }
    case '2v': return { cols: one, rows: two }
    case '3': return { cols: 'minmax(0, 3fr) minmax(0, 2fr)', rows: two }
    case '4': return { cols: two, rows: two }
    default: return { cols: one, rows: one }
  }
}

// 第 i 格的 grid-area（行起 / 列起 / 行止 / 列止）/ cell i's grid-area (row-start / col-start / row-end / col-end)
export function cellArea(g: GridId, i: number): string {
  if (g === '2h') return i === 0 ? '1 / 1 / 2 / 2' : '1 / 2 / 2 / 3'
  if (g === '2v') return i === 0 ? '1 / 1 / 2 / 2' : '2 / 1 / 3 / 2'
  if (g === '3') return i === 0 ? '1 / 1 / 3 / 2' : i === 1 ? '1 / 2 / 2 / 3' : '2 / 2 / 3 / 3'
  if (g === '4') return ['1 / 1 / 2 / 2', '1 / 2 / 2 / 3', '2 / 1 / 3 / 2', '2 / 2 / 3 / 3'][i] ?? '1 / 1 / 2 / 2'
  return '1 / 1 / 2 / 2'
}

// 屏幕上实际显示哪些格子：手机（<768px）只显示当前格；最大化时只显示那一格（其余格子挂着但藏起，
// 不重建图表）。返回 [要挂载的下标, 可见的下标]。
// Which cells show: phones (<768px) show only the active one; a maximised cell shows alone (the others
// stay mounted but hidden, so their charts aren't rebuilt). Returns [mounted indices, visible indices].
export function visibleCells(g: GridId, active: number, canMulti: boolean, maxIdx: number | null): { mounted: number[]; shown: number[] } {
  const n = paneCount(g)
  const a = clampIdx(active, n)
  if (!canMulti || n === 1) return { mounted: [a], shown: [a] }
  const all = Array.from({ length: n }, (_, i) => i)
  if (maxIdx != null && maxIdx >= 0 && maxIdx < n) return { mounted: all, shown: [maxIdx] }
  return { mounted: all, shown: all }
}

export function clampIdx(i: number, n: number): number {
  return Number.isInteger(i) && i >= 0 && i < n ? i : 0
}

const COMPARE_MODES: readonly CompareMode[] = ['percent', 'scale', 'pane']
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const SYM_RE = /^[A-Za-z0-9._#\-+/]{1,32}$/
const IV_RE = /^[A-Za-z0-9]{1,8}$/

function sanitizeCompare(raw: unknown): CompareEntry[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: CompareEntry[] = []
  for (const x of raw.slice(0, 8)) {
    if (!isObj(x) || typeof x.symbol !== 'string' || !SYM_RE.test(x.symbol)) continue
    out.push({
      symbol: x.symbol,
      mode: COMPARE_MODES.includes(x.mode as CompareMode) ? (x.mode as CompareMode) : 'percent',
      color: typeof x.color === 'string' && x.color.length <= 32 ? x.color : '#7c5cff',
      ...(x.hidden === true ? { hidden: true } : {}),
    })
  }
  return out
}

// 一格的状态：品种 / 周期不合法时用兜底；其余字段原样透传（ind 由页面按指标模块的 normalizeLayout 再洗一遍）。
// One cell: an invalid symbol / interval falls back; the other fields pass through (the page runs ind
// through the indicator module's normalizeLayout).
export function sanitizePaneState(raw: unknown, fallback: PaneState): PaneState {
  if (!isObj(raw)) return { symbol: fallback.symbol, interval: fallback.interval }
  const p: PaneState = {
    symbol: typeof raw.symbol === 'string' && SYM_RE.test(raw.symbol) ? raw.symbol : fallback.symbol,
    interval: typeof raw.interval === 'string' && IV_RE.test(raw.interval) ? raw.interval : fallback.interval,
  }
  if (typeof raw.chartType === 'string' && raw.chartType.length <= 24) p.chartType = raw.chartType
  if (isObj(raw.ind)) p.ind = raw.ind
  const cmp = sanitizeCompare(raw.compare)
  if (cmp && cmp.length) p.compare = cmp
  return p
}

export function sanitizeSync(raw: unknown): SyncFlags {
  const r = isObj(raw) ? raw : {}
  const out = { ...DEFAULT_SYNC }
  for (const k of SYNC_KEYS) if (typeof r[k] === 'boolean') out[k] = r[k] as boolean
  return out
}

// 布局 JSON → LayoutDoc。不认识的版本 / 坏数据退回单图；格子不够数时用第 0 格（或兜底）补齐。
// 迁移：v0（没有 v 字段、只有 symbols 数组的早期草稿）也认。
// Layout JSON → LayoutDoc. Unknown versions / bad data fall back to a single chart; missing cells are
// filled from cell 0 (or the fallback). Migration: a v0 draft (no v, just a symbols array) is accepted.
export function sanitizeLayout(raw: unknown, fallback: PaneState): LayoutDoc {
  const base: LayoutDoc = { v: 1, grid: '1', sync: { ...DEFAULT_SYNC }, active: 0, panes: [{ symbol: fallback.symbol, interval: fallback.interval }] }
  if (!isObj(raw)) return base
  let panesRaw: unknown[] = []
  if (raw.v === 1 && Array.isArray(raw.panes)) panesRaw = raw.panes
  else if (raw.v == null && Array.isArray(raw.symbols)) {
    panesRaw = raw.symbols.map((s) => ({ symbol: s, interval: typeof raw.interval === 'string' ? raw.interval : fallback.interval }))
  } else if (raw.v != null && raw.v !== 1) return base
  const grid: GridId = isGrid(raw.grid) ? raw.grid : '1'
  const panes: PaneState[] = []
  for (const p of panesRaw.slice(0, MAX_PANES)) panes.push(sanitizePaneState(p, panes[0] ?? fallback))
  if (panes.length === 0) panes.push({ symbol: fallback.symbol, interval: fallback.interval })
  const n = paneCount(grid)
  while (panes.length < n) panes.push({ symbol: panes[0].symbol, interval: panes[0].interval })
  const active = typeof raw.active === 'number' ? clampIdx(raw.active, n) : 0
  return { v: 1, grid, sync: sanitizeSync(raw.sync), active, panes }
}

export function layoutBytes(doc: LayoutDoc): number {
  return new TextEncoder().encode(JSON.stringify(doc)).length
}

// 超过 64KB：先去掉后面格子的指标、再去掉第 0 格的、最后去掉对比品种。还超就返回 null。
// Over 64KB: drop the later cells' indicators first, then cell 0's, then compare symbols. null if still too big.
export function fitLayoutSize(doc: LayoutDoc, max = LAYOUT_MAX_BYTES): LayoutDoc | null {
  if (layoutBytes(doc) <= max) return doc
  let d = doc
  for (let i = d.panes.length - 1; i >= 0; i--) {
    if (d.panes[i].ind === undefined) continue
    d = { ...d, panes: d.panes.map((p, j) => (j === i ? withoutKey(p, 'ind') : p)) }
    if (layoutBytes(d) <= max) return d
  }
  d = { ...d, panes: d.panes.map((p) => withoutKey(p, 'compare')) }
  return layoutBytes(d) <= max ? d : null
}

function withoutKey<K extends keyof PaneState>(p: PaneState, k: K): PaneState {
  if (!(k in p)) return p
  const { [k]: _drop, ...rest } = p
  return rest as PaneState
}

// 换网格：格子不够就从 seed（通常是当前格）复制品种 / 周期 / 指标补上；多出来的格子留着（切回来还在）。
// Change grid: missing cells are seeded from `seed` (usually the active cell: symbol / interval /
// indicators); extra cells are kept so switching back restores them.
export function withGrid(doc: LayoutDoc, grid: GridId, seed: PaneState): LayoutDoc {
  const n = paneCount(grid)
  const panes = doc.panes.slice()
  while (panes.length < n) {
    const p: PaneState = { symbol: seed.symbol, interval: seed.interval }
    if (seed.chartType) p.chartType = seed.chartType
    if (seed.ind !== undefined) p.ind = seed.ind
    panes.push(p)
  }
  return { ...doc, grid, panes, active: clampIdx(doc.active, n) }
}

// 改第 idx 格的品种 / 周期 / 图表类型；all = 同步开着，作用到所有格子。
// Patch cell idx's symbol / interval / chart type; all = sync on, applies to every cell.
export function patchPanes(doc: LayoutDoc, idx: number, patch: Partial<Pick<PaneState, 'symbol' | 'interval' | 'chartType'>>, all: boolean): LayoutDoc {
  let changed = false
  const panes = doc.panes.map((p, i) => {
    if (!all && i !== idx) return p
    let next = p
    for (const k of Object.keys(patch) as (keyof typeof patch)[]) {
      const v = patch[k]
      if (v === undefined) { if (k in next) { next = withoutKey(next, k); } continue }
      if (next[k] !== v) next = { ...next, [k]: v }
    }
    if (next !== p) changed = true
    return next
  })
  return changed ? { ...doc, panes } : doc
}

// 远端（或手动载入的）布局并进本地。full = 手动载入：连第 0 格一起换；否则第 0 格保留本地（第 0 格
// 由全站偏好驱动，别的设备改了会经偏好同步过来），当前格也保留本地。
// Merge a remote (or explicitly loaded) layout into the local one. full = an explicit load: cell 0 is
// replaced too; otherwise cell 0 stays local (it follows the app-wide prefs, which sync on their own)
// and so does the active cell.
export function mergeDoc(local: LayoutDoc, remote: LayoutDoc, full: boolean): LayoutDoc {
  if (full) return remote
  const panes = remote.panes.slice()
  // 第 0 格的品种 / 周期 / 指标听全站偏好，但对比品种只存在布局里，所以对比取远端的
  // Cell 0's symbol / interval / indicators follow the app-wide prefs, but its compare symbols live only in the layout: take the remote ones
  const l0 = local.panes[0]
  if (l0) {
    const { compare: _drop, ...rest } = l0
    void _drop
    const rc = remote.panes[0]?.compare
    panes[0] = rc && rc.length ? { ...rest, compare: rc } : rest
  }
  return { ...remote, panes, active: clampIdx(local.active, paneCount(remote.grid)) }
}

// 不重名：已有「我的布局」就叫「我的布局 2」…… / unique name: "My layout" → "My layout 2" …
export function uniqueName(base: string, names: readonly string[]): string {
  const taken = new Set(names.map((n) => n.trim()))
  const b = base.trim().slice(0, 60) || 'Layout'
  if (!taken.has(b)) return b
  for (let i = 2; i < 100; i++) {
    const n = `${b} ${i}`
    if (!taken.has(n)) return n
  }
  return `${b} ${Date.now() % 10000}`
}
