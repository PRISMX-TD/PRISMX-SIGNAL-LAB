// 图表画图层（阶段 2 第一批重写，2026-11-25）：工具的绘制 / 命中 / 手柄在 draw/tools.ts，
// 全部画线由一个 series primitive 渲染（draw/primitive.ts）；本组件只管交互状态机、选择、
// 撤销、存取和浮动栏 / 设置 / 对象树这些界面。
// Chart drawing layer (phase 2 batch 1 rewrite, 2026-11-25). Per-tool render / hit / handles live
// in draw/tools.ts and one series primitive paints every drawing (draw/primitive.ts); this component
// owns the interaction state machine, selection, undo, persistence and the floating bar / settings /
// object tree UI.
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { IChartApi, Logical, MouseEventParams } from 'lightweight-charts'
import type { MainSeriesApi } from './useChartEngine'
import { usePrefs } from '../../store/prefs'
import { chartApi } from '../../api/client'
import { onChartDrawingsUpdate } from '../../utils/chartDrawingsEvents'
import ConfirmModal from '../ConfirmModal'
import { useBackToClose } from '../../utils/useBackToClose'
import { isChartAlive } from './chartLifecycle'
import { rawVolumeByRisk, toPips } from '../../api/utils'
import { CHART_PREFS_NS } from './useChartPrefs'
import { registerBarTimes, xToTime, timeToX } from './draw/coords'
import {
  type Drawing, type DrawType, type Tool, type MagnetMode, type Point, type StyleProps, type DrawTemplate,
  TOOL_META, TOOL_HOTKEYS, COLORS, isDrawType, sanitizeDrawings, finishPoints, uid, styleOf,
} from './draw/model'
import { DrawingsPrimitive, type DrawScene } from './draw/primitive'
import { anchorsOf, constrain45, inMarquee, dragHandle, type DrawLabels } from './draw/tools'
import DrawFloatingBar from './draw/DrawFloatingBar'
import DrawSettingsDialog, { type SettingsTab } from './draw/DrawSettingsDialog'
import DrawObjectTree from './draw/DrawObjectTree'
import DrawFavoritesBar from './draw/DrawFavoritesBar'

export type { Tool, MagnetMode } from './draw/model'

export interface DrawLayerHandle {
  tool: Tool
  setTool: (t: Tool) => void
  color: string
  setColor: (c: string) => void
  selectedId: string | null
  selectedCount: number
  drawCount: number
  lockedCount: number
  stayInDraw: boolean
  setStayInDraw: (s: boolean) => void
  visible: boolean
  setVisible: (v: boolean) => void
  deleteSelected: () => void
  clearAll: () => void
  applyColor: (c: string) => void
  toggleLock: () => void
  lockAll: () => void
  unlockAll: () => void
  undo: () => void
  redo: () => void
  // 磁吸：画线时把点吸到 K 线的开高低收上（weak = 靠近才吸，strong = 总是吸）
  // Magnet: snap points to the bar's OHLC while drawing (weak = when close, strong = always)
  magnet: MagnetMode
  setMagnet: (m: MagnetMode) => void
  // 收藏的工具（收藏栏）与对象树 / favourite tools (favourites bar) and the object tree
  favorites: Tool[]
  toggleFavorite: (t: Tool) => void
  treeOpen: boolean
  toggleTree: () => void
}

const MAGNET_WEAK_PX = 18
const SAVE_DEBOUNCE_MS = 800
const DRAG_SLOP_MOUSE = 4
const DRAG_SLOP_TOUCH = 10
const CLICK_PX = 4
const LONG_PRESS_SLOP = 10
const UNDO_MAX = 50
const NUDGE_MERGE_MS = 700

const isTouchDevice = typeof window !== 'undefined' && (window.matchMedia?.('(pointer: coarse)').matches || navigator.maxTouchPoints > 0)
// 触摸、以及粗指针设备上的笔，都没有「悬停」，改走「点一下选中」（见 subscribeClick）。
// Touch, and a pen on a coarse-pointer device, have no hover; they use tap-to-select.
const isTouchLike = (pointerType: string) => pointerType === 'touch' || (pointerType === 'pen' && isTouchDevice)

// 每个品种最近一次的画线（本次会话内存缓存）：切回来先秒显示，再后台核对云端。
// Latest drawings per symbol (in memory for this session): shown at once, then checked against the cloud.
const drawCache = new Map<string, Drawing[]>()
// 剪贴板跨品种有效（复制到别的品种上粘贴）/ the clipboard survives symbol switches
let clipboard: Drawing[] = []

interface Props {
  chart: IChartApi
  series: MainSeriesApi
  host: HTMLDivElement
  symbol: string
  barTimes: () => number[]
  digits?: number
  interval?: string
  fmtTime?: (t: number) => string
  theme?: { bg: string; text: string }
  // 句柄上的状态提交后通知外部工具栏重渲染 / fires after the handle's state commits so toolbars re-render
  onStateChange?: () => void
}

type Gesture =
  | { k: 'create'; pointerId: number; startX: number; startY: number }
  | { k: 'brush'; pointerId: number }
  | { k: 'move'; pointerId: number; startX: number; startY: number; slop: number; active: boolean; ids: string[]; orig: Map<string, Point[]>; clone: boolean; clickId: string; toggle: boolean }
  | { k: 'handle'; pointerId: number; startX: number; startY: number; slop: number; active: boolean; id: string; handle: number; orig: Point[] }
  | { k: 'marquee'; pointerId: number; x0: number; y0: number; additive: boolean }

interface Creating { d: Drawing; step: number }

function DrawLayer({ chart, series, host, symbol, barTimes, digits = 2, interval = '', fmtTime, theme, onStateChange }: Props, ref: React.Ref<DrawLayerHandle>) {
  const { t } = useTranslation()
  const { getPref, setPref } = usePrefs()

  useEffect(() => { registerBarTimes(chart, barTimes) }, [chart, barTimes])

  // ──── 状态 / state ────
  const [tool, setToolState] = useState<Tool>('cursor')
  const [color, setColor] = useState<string>(COLORS[0])
  const [sel, setSelState] = useState<string[]>([])
  const [drawings, setDrawings] = useState<Drawing[]>([])
  const [stayInDraw, setStayInDraw] = useState(false)
  const [visible, setVisible] = useState(true)
  const [dragging, setDragging] = useState(false)
  const [magnet, setMagnetState] = useState<MagnetMode>(() => {
    const m = getPref<string>('charts', 'drawMagnet', 'off')
    return m === 'weak' || m === 'strong' ? m : 'off'
  })
  const setMagnet = useCallback((m: MagnetMode) => { setMagnetState(m); setPref('charts', 'drawMagnet', m) }, [setPref])
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null)
  useBackToClose(!!ctxMenu, () => setCtxMenu(null))
  const [settings, setSettings] = useState<{ id: string; tab: SettingsTab } | null>(null)
  const [treeOpen, setTreeOpen] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  useBackToClose(confirmOpen, () => setConfirmOpen(false))

  // 收藏 / 模板 / 每种工具的默认样式（chartv2 偏好）/ favourites, templates, per-tool defaults (chartv2 prefs)
  const favorites = useMemo(() => {
    const raw = getPref<unknown>(CHART_PREFS_NS, 'drawFav', [])
    return Array.isArray(raw) ? (raw.filter((x) => x === 'cursor' || x === 'cross' || isDrawType(x)) as Tool[]) : []
  }, [getPref])
  const toggleFavorite = useCallback((tl: Tool) => {
    setPref(CHART_PREFS_NS, 'drawFav', favorites.includes(tl) ? favorites.filter((x) => x !== tl) : [...favorites, tl])
  }, [favorites, setPref])
  const templates = useMemo(() => getPref<Record<string, DrawTemplate[]>>(CHART_PREFS_NS, 'drawTpl', {}) || {}, [getPref])
  const defaults = useMemo(() => getPref<Record<string, StyleProps>>(CHART_PREFS_NS, 'drawDef', {}) || {}, [getPref])
  const defaultsRef = useRef(defaults)
  defaultsRef.current = defaults

  // refs（指针回调里读最新值）/ refs read by pointer handlers
  const toolRef = useRef(tool); toolRef.current = tool
  const colorRef = useRef(color); colorRef.current = color
  const selRef = useRef<string[]>(sel)
  const drawingsRef = useRef<Drawing[]>([])
  const stayRef = useRef(stayInDraw); stayRef.current = stayInDraw
  const visibleRef = useRef(visible); visibleRef.current = visible
  const magnetRef = useRef(magnet); magnetRef.current = magnet
  const gestureRef = useRef<Gesture | null>(null)
  const createRef = useRef<Creating | null>(null)
  const appliedRef = useRef('')
  const symRef = useRef(symbol)
  const lastClickRef = useRef<{ id: string; time: number } | null>(null)
  const touchSelRef = useRef(false)
  const lastTouchRef = useRef(false)
  const overlayRef = useRef<HTMLDivElement>(null)

  // ──── primitive 与场景 / primitive & scene ────
  const fmtPrice = useCallback((p: number) => p.toFixed(digits), [digits])
  const labels = useMemo<DrawLabels>(() => ({
    bars: String(t('charts.draw.lbl.bars')), rr: String(t('charts.draw.lbl.rr')), target: String(t('charts.draw.lbl.target')),
    stop: String(t('charts.draw.lbl.stop')), qty: String(t('charts.draw.lbl.qty')), risk: String(t('charts.draw.lbl.risk')),
    pips: String(t('charts.draw.lbl.pips')),
    dur: (sec: number) => {
      const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.round((sec % 3600) / 60)
      const parts: string[] = []
      if (d) parts.push(`${d}${t('charts.draw.lbl.d')}`)
      if (h) parts.push(`${h}${t('charts.draw.lbl.h')}`)
      if (m && !d) parts.push(`${m}${t('charts.draw.lbl.m')}`)
      return parts.join(' ') || `0${t('charts.draw.lbl.m')}`
    },
  }), [t])
  const scene = useMemo<DrawScene>(() => ({
    fmtPrice,
    fmtTime: fmtTime ?? ((x: number) => new Date(x * 1000).toISOString().slice(0, 16).replace('T', ' ')),
    L: labels,
    theme: theme ?? { bg: '#09090b', text: '#94a3b8' },
    qty: (riskAmt, sl, refP) => rawVolumeByRisk(symbol, riskAmt, 100, sl, refP),
    pips: (dp) => toPips(symbol, dp),
    interval,
    touch: isTouchDevice,
  }), [fmtPrice, fmtTime, labels, theme, symbol, interval])
  const sceneRef = useRef(scene)
  sceneRef.current = scene

  const primRef = useRef<DrawingsPrimitive | null>(null)
  useEffect(() => {
    const p = new DrawingsPrimitive(sceneRef.current)
    primRef.current = p
    series.attachPrimitive(p as never)
    return () => {
      primRef.current = null
      if (!isChartAlive(chart)) return
      try { series.detachPrimitive(p as never) } catch { /* 已 detach / already detached */ }
    }
  }, [chart, series])

  // 把当前（或预览用的）列表交给 primitive 重画 / hand the current (or preview) list to the primitive
  const paint = useCallback((list?: Drawing[]) => {
    const p = primRef.current
    if (!p) return
    p.list = visibleRef.current ? (list ?? drawingsRef.current) : []
    p.selected = new Set(selRef.current)
    p.requestUpdate()
  }, [])
  useEffect(() => { const p = primRef.current; if (p) { p.scene = scene; p.requestUpdate() } }, [scene])

  const select = useCallback((ids: string[]) => {
    selRef.current = ids
    setSelState(ids)
    paint()
  }, [paint])

  // ──── 撤销（按品种各一份）/ undo (one stack per symbol) ────
  const stacksRef = useRef(new Map<string, { u: Drawing[][]; r: Drawing[][] }>())
  const stackOf = (sym: string) => {
    let s = stacksRef.current.get(sym)
    if (!s) { s = { u: [], r: [] }; stacksRef.current.set(sym, s) }
    return s
  }

  // ──── 云端保存（rev 55 chart_drawings）/ cloud save ────
  const pendingRef = useRef<{ symbol: string; list: Drawing[] } | null>(null)
  const saveTimerRef = useRef<number | undefined>(undefined)
  const lastSavedAtRef = useRef<string | null>(null)
  const flushSave = useCallback(() => {
    window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = undefined
    const job = pendingRef.current
    if (!job) return
    pendingRef.current = null
    chartApi.saveDrawings(job.symbol, job.list)
      .then((r) => { lastSavedAtRef.current = r.updatedAt ?? null })
      .catch(() => { /* 下次改动会再存；本机缓存里还有 / the next edit saves again */ })
  }, [])
  const scheduleSave = useCallback((sym: string, list: Drawing[]) => {
    drawCache.set(sym, list)
    pendingRef.current = { symbol: sym, list }
    window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = window.setTimeout(flushSave, SAVE_DEBOUNCE_MS)
  }, [flushSave])
  useEffect(() => {
    const onHide = () => { if (document.visibilityState === 'hidden') flushSave() }
    document.addEventListener('visibilitychange', onHide)
    window.addEventListener('pagehide', flushSave)
    return () => { document.removeEventListener('visibilitychange', onHide); window.removeEventListener('pagehide', flushSave); flushSave() }
  }, [flushSave])

  const commitNoHistory = useCallback((next: Drawing[]) => {
    appliedRef.current = JSON.stringify(next)
    drawingsRef.current = next
    setDrawings(next)
    scheduleSave(symRef.current, next)
    const ids = new Set(next.map((d) => d.id))
    if (selRef.current.some((id) => !ids.has(id))) { selRef.current = selRef.current.filter((id) => ids.has(id)); setSelState(selRef.current) }
    paint(next)
  }, [scheduleSave, paint])
  const lastNudgeRef = useRef(0)
  const commit = useCallback((next: Drawing[]) => {
    const s = stackOf(symRef.current)
    s.u.push(drawingsRef.current)
    if (s.u.length > UNDO_MAX) s.u.shift()
    s.r = []
    lastNudgeRef.current = 0
    commitNoHistory(next)
  }, [commitNoHistory])
  const undo = useCallback(() => {
    const s = stackOf(symRef.current); if (s.u.length === 0) return
    s.r.push(drawingsRef.current)
    commitNoHistory(s.u.pop()!)
    select([])
  }, [commitNoHistory, select])
  const redo = useCallback(() => {
    const s = stackOf(symRef.current); if (s.r.length === 0) return
    s.u.push(drawingsRef.current)
    commitNoHistory(s.r.pop()!)
    select([])
  }, [commitNoHistory, select])

  // ──── 选中项上的操作 / actions on the selection ────
  const patchSelected = useCallback((patch: Partial<Drawing>) => {
    const ids = new Set(selRef.current)
    if (!ids.size) return
    commit(drawingsRef.current.map((d) => (ids.has(d.id) ? { ...d, ...patch } : d)))
  }, [commit])
  const deleteSelected = useCallback(() => {
    const ids = new Set(selRef.current)
    if (!ids.size) return
    commit(drawingsRef.current.filter((d) => !ids.has(d.id)))
    select([])
  }, [commit, select])
  const toggleLock = useCallback(() => {
    const ids = new Set(selRef.current)
    const chosen = drawingsRef.current.filter((d) => ids.has(d.id))
    if (!chosen.length) return
    patchSelected({ locked: !chosen.every((d) => d.locked) })
  }, [patchSelected])
  const lockAll = useCallback(() => { commit(drawingsRef.current.map((d) => ({ ...d, locked: true }))) }, [commit])
  const unlockAll = useCallback(() => { commit(drawingsRef.current.map((d) => ({ ...d, locked: false }))) }, [commit])
  const clearAll = useCallback(() => { if (drawingsRef.current.length > 0) setConfirmOpen(true) }, [])
  const doClearAll = useCallback(() => { setConfirmOpen(false); commit([]); select([]) }, [commit, select])
  const applyColor = useCallback((c: string) => {
    setColor(c)
    if (selRef.current.length) patchSelected({ color: c })
  }, [patchSelected])

  // 平移一组画线的点（像素位移换回时间 / 价格）/ shift a drawing's points by a pixel delta
  const shiftPts = useCallback((d: Drawing, orig: Point[], dx: number, dy: number): Point[] => orig.map((pt) => {
    let tt = pt.t, pp = pt.p
    if (d.type !== 'hline' && dx !== 0) {
      const ox = timeToX(chart, pt.t)
      const nt = ox == null ? null : xToTime(chart, ox + dx)
      if (nt != null) tt = nt
    }
    if (d.type !== 'vline' && dy !== 0) {
      const oy = series.priceToCoordinate(pt.p)
      const np = oy == null ? null : (series.coordinateToPrice(oy + dy) as number | null)
      if (np != null) pp = np
    }
    return { t: tt, p: pp }
  }), [chart, series])

  const cloneSelected = useCallback(() => {
    const ids = new Set(selRef.current)
    const src = drawingsRef.current.filter((d) => ids.has(d.id))
    if (!src.length) return
    const copies = src.map((d) => ({ ...d, id: uid(), locked: false, pts: shiftPts(d, d.pts, 16, 16) }))
    commit([...drawingsRef.current, ...copies])
    select(copies.map((d) => d.id))
  }, [commit, select, shiftPts])
  const copySelected = useCallback(() => {
    const ids = new Set(selRef.current)
    clipboard = drawingsRef.current.filter((d) => ids.has(d.id)).map((d) => ({ ...d, pts: d.pts.map((p) => ({ ...p })) }))
  }, [])
  const paste = useCallback(() => {
    if (!clipboard.length) return
    const copies = clipboard.map((d) => ({ ...d, id: uid(), locked: false, pts: d.pts.map((p) => ({ ...p })) }))
    commit([...drawingsRef.current, ...copies])
    select(copies.map((d) => d.id))
  }, [commit, select])
  // 叠放次序 / z-order
  const reorder = useCallback((how: 'front' | 'back' | 'up' | 'down', only?: string) => {
    const ids = new Set(only ? [only] : selRef.current)
    const list = [...drawingsRef.current]
    if (!ids.size) return
    if (how === 'front') commit([...list.filter((d) => !ids.has(d.id)), ...list.filter((d) => ids.has(d.id))])
    else if (how === 'back') commit([...list.filter((d) => ids.has(d.id)), ...list.filter((d) => !ids.has(d.id))])
    else {
      const step = how === 'up' ? 1 : -1
      const order = how === 'up' ? [...list.keys()].reverse() : [...list.keys()]
      for (const i of order) {
        const j = i + step
        if (!ids.has(list[i].id) || j < 0 || j >= list.length || ids.has(list[j].id)) continue
        ;[list[i], list[j]] = [list[j], list[i]]
      }
      commit(list)
    }
  }, [commit])

  const setTool = useCallback((tl: Tool) => {
    createRef.current = null
    gestureRef.current = null
    const p = primRef.current
    if (p) { p.temp = null; p.requestUpdate() }
    setToolState(tl)
    if (tl !== 'cursor' && tl !== 'cross') select([])
  }, [select])

  // ──── 句柄 / handle ────
  const lockedCount = drawings.filter((d) => d.locked).length
  const toggleTree = useCallback(() => setTreeOpen((v) => !v), [])
  useImperativeHandle(ref, () => ({
    tool, setTool, color, setColor, selectedId: sel[0] ?? null, selectedCount: sel.length,
    drawCount: drawings.length, lockedCount, stayInDraw, setStayInDraw, visible, setVisible,
    deleteSelected, clearAll, applyColor, toggleLock, lockAll, unlockAll, undo, redo, magnet, setMagnet,
    favorites, toggleFavorite, treeOpen, toggleTree,
  }), [tool, setTool, color, sel, drawings.length, lockedCount, stayInDraw, visible, deleteSelected, clearAll, applyColor, toggleLock, lockAll, unlockAll, undo, redo, magnet, setMagnet, favorites, toggleFavorite, treeOpen, toggleTree])
  const onStateChangeRef = useRef(onStateChange)
  onStateChangeRef.current = onStateChange
  useEffect(() => { onStateChangeRef.current?.() }, [tool, color, sel, drawings.length, lockedCount, stayInDraw, visible, magnet, favorites, treeOpen])

  // 显示 / 隐藏全部 / show / hide all
  useEffect(() => {
    if (!visible) select([])
    paint()
  }, [visible, paint, select])

  // ──── 加载（云端 + 旧 chartDraw 一次性迁移）/ load (cloud + one-off legacy chartDraw migration) ────
  const legacyOf = useCallback((sym: string): Drawing[] => sanitizeDrawings(getPref<unknown>('chartDraw', sym, [])), [getPref])
  const legacyRef = useRef(legacyOf)
  legacyRef.current = legacyOf
  const applyList = useCallback((arr: Drawing[], resetSel: boolean) => {
    const json = JSON.stringify(arr)
    if (json === appliedRef.current) return
    appliedRef.current = json
    drawingsRef.current = arr
    setDrawings(arr)
    if (resetSel) { selRef.current = []; setSelState([]); setSettings(null) }
    paint(arr)
  }, [paint])
  const fetchCloud = useCallback((sym: string, migrate: boolean) => {
    chartApi.getDrawings(sym).then((r) => {
      if (symRef.current !== sym || pendingRef.current?.symbol === sym) return
      const cloud = sanitizeDrawings(r.drawings)
      if (r.updatedAt == null && migrate) {
        const legacy = legacyRef.current(sym)
        if (legacy.length > 0) { scheduleSave(sym, legacy); flushSave(); applyList(legacy, false); return }
      }
      lastSavedAtRef.current = r.updatedAt ?? null
      drawCache.set(sym, cloud)
      applyList(cloud, false)
    }).catch(() => { /* 离线 / 未登录：保持本机显示 / offline: keep the local copy */ })
  }, [applyList, scheduleSave, flushSave])
  const loadedSymRef = useRef<string | null>(null)
  useEffect(() => {
    if (loadedSymRef.current === symbol) return
    if (pendingRef.current && pendingRef.current.symbol !== symbol) flushSave()
    loadedSymRef.current = symbol
    symRef.current = symbol
    createRef.current = null
    gestureRef.current = null
    if (primRef.current) primRef.current.temp = null
    appliedRef.current = ''
    applyList(drawCache.get(symbol) ?? legacyRef.current(symbol), true)
    // 品种列表还没到时 symbol 是空串，不去拉（后端会回 422）/ '' until the symbol list arrives
    if (symbol) fetchCloud(symbol, !drawCache.has(symbol))
  }, [symbol, applyList, fetchCloud, flushSave])
  useEffect(() => onChartDrawingsUpdate((d) => {
    if (d.symbol !== symRef.current || d.updatedAt === lastSavedAtRef.current || pendingRef.current) return
    if (gestureRef.current || createRef.current) return
    fetchCloud(d.symbol, false)
  }), [fetchCloud])

  // ──── 坐标工具 / coordinate helpers ────
  const localXY = (e: { clientX: number; clientY: number }) => {
    const r = overlayRef.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  const toPoint = useCallback((x: number, y: number): Point | null => {
    const tt = xToTime(chart, x)
    const pp = series.coordinateToPrice(y) as number | null
    return tt == null || pp == null ? null : { t: tt, p: pp }
  }, [chart, series])
  // 磁吸：把 (x, y) 吸到最近一根 K 线的开高低收上 / magnet: snap to the nearest bar's OHLC
  const snap = useCallback((x: number, y: number): { x: number; y: number } => {
    const m = magnetRef.current
    if (m === 'off') return { x, y }
    const ts = chart.timeScale()
    const lg = ts.coordinateToLogical(x)
    if (lg == null) return { x, y }
    const idx = Math.round(lg)
    const bar = series.dataByIndex(idx) as { open?: number; high?: number; low?: number; close?: number } | null
    if (!bar || bar.high == null || bar.low == null || bar.open == null || bar.close == null) return { x, y }
    let best: number | null = null
    let dist = Infinity
    for (const p of [bar.open, bar.high, bar.low, bar.close]) {
      const py = series.priceToCoordinate(p)
      if (py == null) continue
      const d = Math.abs(py - y)
      if (d < dist) { dist = d; best = py }
    }
    if (best == null || (m === 'weak' && dist > MAGNET_WEAK_PX)) return { x, y }
    const cx = ts.logicalToCoordinate(idx as Logical)
    return { x: m === 'strong' && cx != null ? cx : x, y: best }
  }, [chart, series])
  const pxOf = useCallback((pt: Point) => ({ x: timeToX(chart, pt.t) ?? NaN, y: series.priceToCoordinate(pt.p) ?? NaN }), [chart, series])

  // ──── 创建 / creation ────
  const showTemp = useCallback(() => {
    const p = primRef.current
    const c = createRef.current
    if (!p) return
    if (!c) { p.temp = null; p.requestUpdate(); return }
    const d = c.d
    p.temp = d.type === 'long' || d.type === 'short' ? { ...d, pts: finishPoints(d.type, d.pts.slice(0, 2)) } : { ...d, pts: d.pts.map((q) => ({ ...q })) }
    p.requestUpdate()
  }, [])
  const newDrawing = useCallback((type: DrawType, pts: Point[]): Drawing => {
    const base: Drawing = { ...(defaultsRef.current[type] ?? {}), id: uid(), type, pts, color: colorRef.current }
    if (type === 'text') base.text = String(t('charts.draw.textDefault'))
    return base
  }, [t])
  const finishCreate = useCallback((d: Drawing) => {
    createRef.current = null
    const p = primRef.current
    if (p) p.temp = null
    const done: Drawing = { ...d, pts: finishPoints(d.type, d.pts) }
    commit([...drawingsRef.current, done])
    select([done.id])
    if (!stayRef.current) setToolState('cursor')
    if (done.type === 'text') setSettings({ id: done.id, tab: 'text' })
  }, [commit, select])
  const cancelCreate = useCallback(() => {
    createRef.current = null
    gestureRef.current = null
    showTemp()
  }, [showTemp])

  // 把正在放的那个点移到 (x, y) / move the point being placed to (x, y)
  const updateCreate = useCallback((x0: number, y0: number, shift: boolean) => {
    const c = createRef.current
    if (!c || c.step < 0) return
    const d = c.d
    let { x, y } = snap(x0, y0)
    if (c.step === 1 && shift && TOOL_META[d.type].lineLike) {
      const a = pxOf(d.pts[0])
      if (Number.isFinite(a.x) && Number.isFinite(a.y)) ({ x, y } = constrain45(a, { x, y }))
    }
    if (c.step === 2 && d.type === 'channel') {
      const a = pxOf(d.pts[0]), b = pxOf(d.pts[1])
      const lineY = b.x === a.x ? a.y : a.y + (b.y - a.y) * (x - a.x) / (b.x - a.x)
      const pc = series.coordinateToPrice(y) as number | null
      const pl = series.coordinateToPrice(lineY) as number | null
      if (pc == null || pl == null) return
      d.pts[2] = { t: d.pts[0].t, p: d.pts[0].p + (pc - pl) }
    } else {
      const pt = toPoint(x, y)
      if (!pt) return
      d.pts[c.step] = pt
      // 三点工具放第二个点时，第三个点先跟着（通道先是一条线，扩展先从第二点起）
      // While placing point 2 of a three-point tool the third follows (a flat channel, an extension from p2)
      if (c.step === 1 && TOOL_META[d.type].create === 'three') d.pts[2] = d.type === 'channel' ? { ...d.pts[0] } : { ...pt }
    }
    showTemp()
  }, [snap, pxOf, series, toPoint, showTemp])

  // 主图区高度（副图区不能画）/ main pane height (sub-panes can't be drawn on yet)
  const inMainPane = (y: number) => y <= chart.paneSize(0).height

  // ──── 指针 / pointer ────
  const onDown = useCallback((e: RPointerEvent<HTMLDivElement>) => {
    if (!e.isPrimary) {
      // 第二根手指：画到一半就作废这一笔 / a second finger voids a stroke in progress
      if (gestureRef.current?.k === 'create' || gestureRef.current?.k === 'brush') cancelCreate()
      return
    }
    const { x, y } = localXY(e)
    const cur = toolRef.current
    e.currentTarget.setPointerCapture?.(e.pointerId)
    setCtxMenu(null)

    if (cur !== 'cursor' && cur !== 'cross') {
      if (!inMainPane(y)) return
      const type = cur as DrawType
      const meta = TOOL_META[type]
      const c = createRef.current
      if (c) {
        // 两点 / 三点工具的后续点击：落点 / follow-up click of a click-click / three-point tool
        updateCreate(x, y, e.shiftKey)
        gestureRef.current = { k: 'create', pointerId: e.pointerId, startX: x, startY: y }
        return
      }
      const s = snap(x, y)
      const pt = toPoint(s.x, s.y)
      if (!pt) return
      if (meta.create === 'click') {
        const d = newDrawing(type, [pt])
        if (type === 'hline') d.pts = [{ t: 0, p: pt.p }]
        if (type === 'vline') d.pts = [{ t: pt.t, p: 0 }]
        finishCreate(d)
        return
      }
      if (meta.create === 'free') {
        createRef.current = { d: newDrawing(type, [pt]), step: -1 }
        gestureRef.current = { k: 'brush', pointerId: e.pointerId }
        showTemp()
        return
      }
      const pts = meta.create === 'three' ? [pt, { ...pt }, { ...pt }] : [pt, { ...pt }]
      createRef.current = { d: newDrawing(type, pts), step: 1 }
      gestureRef.current = { k: 'create', pointerId: e.pointerId, startX: x, startY: y }
      showTemp()
      return
    }

    // 光标模式 / cursor mode
    const prim = primRef.current
    const hit = prim?.hitAt(x, y) ?? null
    const touch = isTouchLike(e.pointerType)
    const slop = touch ? DRAG_SLOP_TOUCH : DRAG_SLOP_MOUSE
    const multi = e.ctrlKey || e.metaKey
    if (!hit) {
      touchSelRef.current = false
      if (multi) {
        gestureRef.current = { k: 'marquee', pointerId: e.pointerId, x0: x, y0: y, additive: true }
        return
      }
      select([])
      return
    }
    touchSelRef.current = touch
    const d = hit.d
    const now = Date.now()
    const dbl = lastClickRef.current && lastClickRef.current.id === d.id && now - lastClickRef.current.time < 350
    lastClickRef.current = { id: d.id, time: now }
    if (dbl && !multi) {
      select([d.id])
      setSettings({ id: d.id, tab: 'style' })
      return
    }
    if (hit.handle >= 0 && !d.locked && !multi) {
      select([d.id])
      gestureRef.current = { k: 'handle', pointerId: e.pointerId, startX: x, startY: y, slop, active: false, id: d.id, handle: hit.handle, orig: d.pts.map((p) => ({ ...p })) }
      return
    }
    const cur0 = selRef.current
    const inSel = cur0.includes(d.id)
    let ids: string[]
    if (multi || e.shiftKey) ids = inSel ? cur0 : [...cur0, d.id]
    else ids = inSel ? cur0 : [d.id]
    if (!multi && !e.shiftKey && !inSel) select(ids)
    else if (!inSel) select(ids)
    const list = drawingsRef.current
    const movable = ids.filter((id) => !list.find((x) => x.id === id)?.locked)
    const orig = new Map<string, Point[]>()
    for (const id of movable) { const dd = list.find((x) => x.id === id); if (dd) orig.set(id, dd.pts.map((p) => ({ ...p }))) }
    gestureRef.current = {
      k: 'move', pointerId: e.pointerId, startX: x, startY: y, slop, active: false,
      ids: movable, orig, clone: multi, clickId: d.id, toggle: (multi || e.shiftKey) && inSel,
    }
  }, [cancelCreate, updateCreate, snap, toPoint, newDrawing, finishCreate, showTemp, select]) // eslint-disable-line react-hooks/exhaustive-deps

  const onMove = useCallback((e: RPointerEvent<HTMLDivElement>) => {
    const g = gestureRef.current
    const { x, y } = localXY(e)
    // 没按着：两点点击 / 三点工具的悬停预览 / not pressed: hover preview while placing points
    if (!g) {
      if (createRef.current && createRef.current.step >= 0) updateCreate(x, y, e.shiftKey)
      return
    }
    if (e.pointerId !== g.pointerId) return
    const prim = primRef.current
    if (g.k === 'create') { updateCreate(x, y, e.shiftKey); return }
    if (g.k === 'brush') {
      const c = createRef.current
      if (!c) return
      const last = pxOf(c.d.pts[c.d.pts.length - 1])
      if (Math.hypot(x - last.x, y - last.y) < 3) return
      const pt = toPoint(x, y)
      if (pt) { c.d.pts.push(pt); showTemp() }
      return
    }
    if (g.k === 'marquee') {
      if (prim) { prim.marquee = { x1: g.x0, y1: g.y0, x2: x, y2: y }; prim.requestUpdate() }
      return
    }
    if (!g.active) {
      if (Math.hypot(x - g.startX, y - g.startY) < g.slop) return
      g.active = true
      setDragging(true)
      // Ctrl+拖：先复制一份再拖副本 / Ctrl+drag clones first, then drags the copies
      if (g.k === 'move' && g.clone && g.ids.length) {
        const list = drawingsRef.current
        const copies: Drawing[] = []
        const orig = new Map<string, Point[]>()
        for (const id of g.ids) {
          const d = list.find((x) => x.id === id)
          if (!d) continue
          const c = { ...d, id: uid(), locked: false, pts: d.pts.map((p) => ({ ...p })) }
          copies.push(c)
          orig.set(c.id, c.pts.map((p) => ({ ...p })))
        }
        commit([...list, ...copies])
        g.ids = copies.map((c) => c.id)
        g.orig = orig
        select(g.ids)
      }
    }
    const list = drawingsRef.current
    if (g.k === 'move') {
      const dx = x - g.startX, dy = y - g.startY
      const ids = new Set(g.ids)
      paint(list.map((d) => (ids.has(d.id) ? { ...d, pts: shiftPts(d, g.orig.get(d.id) ?? d.pts, dx, dy) } : d)))
      return
    }
    // 拉手柄 / handle drag
    const d = list.find((q) => q.id === g.id)
    if (!d) return
    let s = snap(x, y)
    if (e.shiftKey && TOOL_META[d.type].lineLike && (g.handle === 0 || g.handle === 1)) {
      const other = pxOf(g.orig[g.handle === 0 ? 1 : 0])
      if (Number.isFinite(other.x)) s = constrain45(other, s)
    }
    const pt = toPoint(s.x, s.y)
    if (!pt) return
    const pts = dragHandle(d, g.handle, pt, g.orig)
    paint(list.map((q) => (q.id === g.id ? { ...q, pts } : q)))
  }, [updateCreate, pxOf, toPoint, showTemp, commit, select, paint, shiftPts, snap])

  const onUp = useCallback((e: RPointerEvent<HTMLDivElement>) => {
    const g = gestureRef.current
    if (g && e.pointerId !== g.pointerId) return
    gestureRef.current = null
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    setDragging(false)
    if (!g) return
    const { x, y } = localXY(e)
    const prim = primRef.current

    if (g.k === 'brush') {
      const c = createRef.current
      if (c && c.d.pts.length >= 2) finishCreate(c.d)
      else cancelCreate()
      return
    }
    if (g.k === 'create') {
      const c = createRef.current
      if (!c) return
      const d = c.d
      const clickOnly = Math.hypot(x - g.startX, y - g.startY) < CLICK_PX
      if (c.step === 1) {
        const a = pxOf(d.pts[0]), b = pxOf(d.pts[1])
        const tiny = !(Math.hypot(b.x - a.x, b.y - a.y) >= CLICK_PX)
        if (tiny) {
          // 多空仓位：点一下就按默认大小放一个 / positions: a click drops a default-sized one
          if (d.type === 'long' || d.type === 'short') {
            const bs = chart.timeScale().options().barSpacing || 6
            // 至少 120px，K 线很密（手机）时手柄和时间标签不会挤在一起
            // At least 120px so handles and time labels don't pile up when bars are dense (phones)
            const end = toPoint(a.x + Math.max(bs * 20, 120), a.y)
            if (end) { d.pts[1] = end; finishCreate(d) } else cancelCreate()
            return
          }
          // 原地点一下：进入「点两下」模式，悬停跟随，下一次点击落第二个点
          // A click in place: click-click mode, the point follows the hover until the next click
          if (clickOnly) return
          cancelCreate()
          return
        }
        if (TOOL_META[d.type].create === 'three') { c.step = 2; showTemp(); return }
        finishCreate(d)
        return
      }
      if (c.step === 2) finishCreate(d)
      return
    }
    if (g.k === 'marquee') {
      const env = prim?.env()
      if (prim) { prim.marquee = null; prim.requestUpdate() }
      if (!env) return
      const box = { x1: Math.min(g.x0, x), y1: Math.min(g.y0, y), x2: Math.max(g.x0, x), y2: Math.max(g.y0, y) }
      if (box.x2 - box.x1 < 3 && box.y2 - box.y1 < 3) return
      const hits = drawingsRef.current.filter((d) => prim!.list.includes(d) && inMarquee(d, anchorsOf(d, env), box)).map((d) => d.id)
      select(g.additive ? [...new Set([...selRef.current, ...hits])] : hits)
      return
    }
    if (!g.active) {
      // 没拖动：Ctrl / Shift 点一下切换选中；普通点一下只选这一条
      // No drag: Ctrl / Shift click toggles; a plain click selects just this one
      if (g.k === 'move') {
        if (g.toggle) select(selRef.current.filter((id) => id !== g.clickId))
        else if (!g.clone && selRef.current.length > 1) select([g.clickId])
      }
      return
    }
    // 拖完提交（拖动中只预览没 commit）/ commit after the drag (only previewed during it)
    const live = prim?.list ?? drawingsRef.current
    const ids = g.k === 'move' ? new Set(g.ids) : new Set([g.id])
    const next = drawingsRef.current.map((d) => (ids.has(d.id) ? live.find((q) => q.id === d.id) ?? d : d))
    if (JSON.stringify(next) !== appliedRef.current) {
      if (g.k === 'move' && g.clone) commitNoHistory(next)
      else commit(next)
    }
  }, [finishCreate, cancelCreate, pxOf, chart, toPoint, showTemp, select, commit, commitNoHistory])

  // 系统取消（返回手势、掌心误触、来电）：放弃这一笔 / a system cancel abandons the stroke
  const onCancel = useCallback((e: RPointerEvent<HTMLDivElement>) => {
    const g = gestureRef.current
    if (g && e.pointerId !== g.pointerId) return
    gestureRef.current = null
    setDragging(false)
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    if (g?.k === 'create' || g?.k === 'brush') cancelCreate()
    const prim = primRef.current
    if (prim) prim.marquee = null
    paint()
  }, [cancelCreate, paint])

  // ──── 触屏：点一下选中 / touch: tap to select ────
  useEffect(() => {
    const onClick = (p: MouseEventParams) => {
      if (toolRef.current !== 'cursor' && toolRef.current !== 'cross') return
      if (!p.hoveredObjectId && !p.point) { select([]); return }
      if (!lastTouchRef.current || p.paneIndex !== 0) return
      const el = overlayRef.current
      const src = p.sourceEvent
      if (!el || !src) return
      const r = el.getBoundingClientRect()
      const hit = primRef.current?.hitAt(src.clientX - r.left, src.clientY - r.top)
      if (!hit) return
      touchSelRef.current = true
      el.style.pointerEvents = 'auto'
      select([hit.d.id])
    }
    chart.subscribeClick(onClick)
    return () => chart.unsubscribeClick(onClick)
  }, [chart, select])

  // 右键菜单点外面关闭 / context menu closes on an outside click
  useEffect(() => {
    if (!ctxMenu) return
    const onDocClick = () => setCtxMenu(null)
    const tmr = setTimeout(() => document.addEventListener('click', onDocClick), 100)
    return () => { clearTimeout(tmr); document.removeEventListener('click', onDocClick) }
  }, [ctxMenu])

  // 手机长按出菜单 / mobile long-press menu
  useEffect(() => {
    if (!isTouchDevice) return
    const el = overlayRef.current; if (!el) return
    let sx = 0, sy = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    const clear = () => { if (timer) { clearTimeout(timer); timer = null } }
    const onStart = (e: TouchEvent) => {
      clear()
      if (e.touches.length !== 1) return
      sx = e.touches[0].clientX; sy = e.touches[0].clientY
      timer = setTimeout(() => {
        timer = null
        if (toolRef.current !== 'cursor' && toolRef.current !== 'cross') return
        const r = el.getBoundingClientRect()
        const hit = primRef.current?.hitAt(sx - r.left, sy - r.top)
        if (hit) { gestureRef.current = null; setDragging(false); select([hit.d.id]); setCtxMenu({ x: sx, y: sy }) }
      }, 500)
    }
    const onMoveTouch = (e: TouchEvent) => {
      const tt = e.touches[0]
      if (!tt || Math.hypot(tt.clientX - sx, tt.clientY - sy) > LONG_PRESS_SLOP) clear()
    }
    el.addEventListener('touchstart', onStart, { passive: true })
    el.addEventListener('touchmove', onMoveTouch, { passive: true })
    el.addEventListener('touchend', clear, { passive: true })
    el.addEventListener('touchcancel', clear, { passive: true })
    return () => {
      clear()
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchmove', onMoveTouch)
      el.removeEventListener('touchend', clear)
      el.removeEventListener('touchcancel', clear)
    }
  }, [select])

  // ──── 键盘 / keyboard ────
  useEffect(() => {
    const inTextField = (target: EventTarget | null): boolean => {
      const el = target as HTMLElement | null
      return !!el?.closest?.('input,textarea,select,[contenteditable="true"]')
    }
    // 单键 / Ctrl+C·V 只在焦点落在图表区时生效（WCAG 2.1.4）/ only while focus is in the chart area
    const inChartArea = (): boolean => {
      const scope = host.closest('.term-cv') || host.parentElement
      const active = document.activeElement
      return !!scope && !!active && scope.contains(active)
    }
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (e.key === 'Escape') {
        if (createRef.current || gestureRef.current) cancelCreate()
        setToolState('cursor'); select([]); setCtxMenu(null)
        return
      }
      if (inTextField(e.target)) return
      if (mod && !e.altKey && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return }
      if (mod && !e.altKey && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); redo(); return }
      if (!inChartArea()) return
      if ((e.key === 'Delete' || e.key === 'Backspace') && selRef.current.length) { e.preventDefault(); deleteSelected(); return }
      if (mod && !e.altKey && e.code === 'KeyC' && selRef.current.length) { copySelected(); return }
      if (mod && !e.altKey && e.code === 'KeyV' && clipboard.length) { e.preventDefault(); paste(); return }
      if (e.altKey && !mod) {
        // Alt+字母（按 e.code 认键：Mac 上 Option 会改 e.key）/ Alt+letter by e.code
        for (const [tl, k] of Object.entries(TOOL_HOTKEYS)) {
          if (k && k.code === e.code && !!k.shift === e.shiftKey) { e.preventDefault(); setTool(tl as Tool); return }
        }
      }
    }
    // 方向键微调选中的画线：捕获期抢在图表快捷键（方向键平移 / 缩放）前面，并截住
    // Arrow keys nudge the selection: capture phase, ahead of the chart's arrow pan / zoom, and stopped there
    const onArrow = (e: KeyboardEvent) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return
      if (!selRef.current.length || inTextField(e.target) || !inChartArea() || e.ctrlKey || e.metaKey || e.altKey) return
      const ids = new Set(selRef.current)
      const list = drawingsRef.current
      if (!list.some((d) => ids.has(d.id) && !d.locked)) return
      e.preventDefault()
      e.stopPropagation()
      const bs = chart.timeScale().options().barSpacing || 6
      const k = e.shiftKey ? 10 : 1
      const dx = e.key === 'ArrowLeft' ? -bs * k : e.key === 'ArrowRight' ? bs * k : 0
      const dy = e.key === 'ArrowUp' ? -k : e.key === 'ArrowDown' ? k : 0
      const next = list.map((d) => (ids.has(d.id) && !d.locked ? { ...d, pts: shiftPts(d, d.pts, dx, dy) } : d))
      // 连按合并成一步撤销 / rapid presses merge into one undo step
      const now = Date.now()
      if (now - lastNudgeRef.current < NUDGE_MERGE_MS) commitNoHistory(next)
      else commit(next)
      lastNudgeRef.current = now
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keydown', onArrow, true)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('keydown', onArrow, true) }
  }, [host, chart, cancelCreate, select, undo, redo, deleteSelected, copySelected, paste, setTool, shiftPts, commit, commitNoHistory])

  // ──── 悬停：动态接管指针 + 光标样式 / hover: dynamic pointer-events + cursor ────
  // 交互层平时不接管指针（否则图表的拖动平移 / 滚轮缩放到不了底下），只有在拖、画、悬停在画线上、
  // 或按住 Ctrl 准备框选时才切成 auto。
  // The layer only takes the pointer while dragging, drawing, hovering a drawing, or holding Ctrl to
  // marquee; otherwise the chart's own pan / zoom must reach the canvas underneath.
  const [cursorStyle, setCursorStyle] = useState<string>('')
  useEffect(() => {
    const el = overlayRef.current; if (!el) return
    let frame = 0
    let last: { x: number; y: number; ctrl: boolean } | null = null
    const setHover = (id: string | null) => {
      const p = primRef.current
      if (p && p.hover !== id) { p.hover = id; p.requestUpdate() }
    }
    const evaluate = () => {
      frame = 0
      const p = last
      if (!p) return
      if (gestureRef.current) { el.style.pointerEvents = 'auto'; return }
      if (toolRef.current !== 'cursor' && toolRef.current !== 'cross') { el.style.pointerEvents = 'auto'; setCursorStyle('crosshair'); return }
      const r = el.getBoundingClientRect()
      const x = p.x - r.left, y = p.y - r.top
      if (x < 0 || y < 0 || x > r.width || y > r.height) { el.style.pointerEvents = 'none'; setCursorStyle(''); setHover(null); return }
      const h = primRef.current?.hitAt(x, y) ?? null
      setHover(h?.d.id ?? null)
      if (h) {
        el.style.pointerEvents = 'auto'
        if (h.d.locked) setCursorStyle('pointer')
        else if (h.handle >= 0) setCursorStyle(p.ctrl ? 'copy' : 'grab')
        else setCursorStyle(p.ctrl ? 'copy' : 'move')
      } else if (p.ctrl && y <= chart.paneSize(0).height) {
        el.style.pointerEvents = 'auto'
        setCursorStyle('crosshair')
      } else {
        el.style.pointerEvents = 'none'
        setCursorStyle(toolRef.current === 'cross' ? 'crosshair' : '')
      }
    }
    const onHover = (e: PointerEvent) => {
      if (gestureRef.current || (toolRef.current !== 'cursor' && toolRef.current !== 'cross')) {
        el.style.pointerEvents = 'auto'
        if (!gestureRef.current) setCursorStyle('crosshair')
        return
      }
      if (isTouchLike(e.pointerType)) return
      last = { x: e.clientX, y: e.clientY, ctrl: e.ctrlKey || e.metaKey }
      if (frame === 0) frame = window.requestAnimationFrame(evaluate)
    }
    const onCtrl = (e: KeyboardEvent) => {
      if (e.key !== 'Control' && e.key !== 'Meta') return
      if (!last) return
      last = { ...last, ctrl: e.type === 'keydown' }
      if (frame === 0) frame = window.requestAnimationFrame(evaluate)
    }
    const onPress = (e: PointerEvent) => { lastTouchRef.current = isTouchLike(e.pointerType) }
    const onRelease = (e: PointerEvent) => {
      if (!isTouchLike(e.pointerType) || gestureRef.current || touchSelRef.current) return
      if (toolRef.current !== 'cursor' && toolRef.current !== 'cross') return
      el.style.pointerEvents = 'none'
    }
    window.addEventListener('pointermove', onHover, true)
    window.addEventListener('pointerdown', onPress, true)
    window.addEventListener('pointerup', onRelease)
    window.addEventListener('pointercancel', onRelease)
    window.addEventListener('keydown', onCtrl)
    window.addEventListener('keyup', onCtrl)
    return () => {
      window.removeEventListener('pointermove', onHover, true)
      window.removeEventListener('pointerdown', onPress, true)
      window.removeEventListener('pointerup', onRelease)
      window.removeEventListener('pointercancel', onRelease)
      window.removeEventListener('keydown', onCtrl)
      window.removeEventListener('keyup', onCtrl)
      if (frame !== 0) window.cancelAnimationFrame(frame)
    }
  }, [chart])

  useEffect(() => {
    const el = overlayRef.current; if (!el) return
    if (tool !== 'cursor' && tool !== 'cross') { el.style.pointerEvents = 'auto'; setCursorStyle('crosshair') }
    else { el.style.pointerEvents = 'none'; setCursorStyle('') }
  }, [tool])

  // 选中被别的路径清掉时，撤掉手指点选带来的接管 / drop tap-selection arming when the selection clears
  useEffect(() => {
    if (sel.length) return
    touchSelRef.current = false
    const el = overlayRef.current
    if (el && !gestureRef.current && (toolRef.current === 'cursor' || toolRef.current === 'cross')) el.style.pointerEvents = 'none'
  }, [sel])

  // ──── 设置弹窗：实时预览，确定才提交 / settings dialog: live preview, committed on OK ────
  const settingsDrawing = settings ? drawings.find((d) => d.id === settings.id) ?? null : null
  const previewDrawing = useCallback((d: Drawing) => {
    paint(drawingsRef.current.map((q) => (q.id === d.id ? d : q)))
  }, [paint])
  const applySettings = useCallback((d: Drawing) => {
    setSettings(null)
    const before = drawingsRef.current.find((q) => q.id === d.id)
    if (before && JSON.stringify(before) !== JSON.stringify(d)) commit(drawingsRef.current.map((q) => (q.id === d.id ? d : q)))
    else paint()
  }, [commit, paint])
  const cancelSettings = useCallback(() => { setSettings(null); paint() }, [paint])
  const saveTemplate = useCallback((type: DrawType, name: string, style: StyleProps) => {
    const list = (templates[type] ?? []).filter((x) => x.name !== name)
    setPref(CHART_PREFS_NS, 'drawTpl', { ...templates, [type]: [...list, { name, style }].slice(-20) })
  }, [templates, setPref])
  const deleteTemplate = useCallback((type: DrawType, name: string) => {
    setPref(CHART_PREFS_NS, 'drawTpl', { ...templates, [type]: (templates[type] ?? []).filter((x) => x.name !== name) })
  }, [templates, setPref])
  const saveDefault = useCallback((type: DrawType, style: StyleProps) => {
    const { color: _c, ...rest } = style
    setPref(CHART_PREFS_NS, 'drawDef', { ...defaults, [type]: rest })
  }, [defaults, setPref])

  // 收藏栏位置 / favourites bar position
  const favPos = getPref<{ x: number; y: number } | null>(CHART_PREFS_NS, 'drawFavPos', null)

  const selDrawings = useMemo(() => {
    const ids = new Set(sel)
    return drawings.filter((d) => ids.has(d.id))
  }, [sel, drawings])

  const menuItem = 'flex w-full items-center gap-2 rounded px-3 py-1.5 text-left text-xs text-neutral-300 hover:bg-white/10'

  return (
    <>
      {/* 交互层 / interaction layer */}
      <div
        ref={overlayRef}
        className="pointer-events-none absolute inset-1.5 z-10 touch-none"
        style={{ display: visible ? '' : 'none', cursor: cursorStyle || (tool !== 'cursor' && tool !== 'cross' ? 'crosshair' : 'default') }}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onCancel}
        onContextMenu={(e) => {
          e.preventDefault()
          // 画到一半右键 = 取消这一笔 / a right-click mid-stroke cancels it
          if (createRef.current) { cancelCreate(); return }
          if (tool !== 'cursor' && tool !== 'cross') return
          const { x, y } = localXY(e)
          const hit = primRef.current?.hitAt(x, y)
          if (hit) {
            if (!selRef.current.includes(hit.d.id)) select([hit.d.id])
            setCtxMenu({ x: e.clientX, y: e.clientY })
          }
        }}
      />

      {visible && selDrawings.length > 0 && !dragging && (
        <DrawFloatingBar
          drawings={selDrawings}
          onPatch={patchSelected}
          onSettings={() => setSettings({ id: selDrawings[0].id, tab: 'style' })}
          onToggleLock={toggleLock}
          onClone={cloneSelected}
          onDelete={deleteSelected}
          onReorder={(how) => reorder(how)}
          onHide={() => { patchSelected({ hidden: true }); select([]) }}
          onTree={() => setTreeOpen(true)}
          t={t}
        />
      )}

      {visible && favorites.length > 0 && (
        <DrawFavoritesBar
          favorites={favorites}
          tool={tool}
          onPick={setTool}
          pos={favPos}
          onPos={(p) => setPref(CHART_PREFS_NS, 'drawFavPos', p)}
          host={host}
          t={t}
        />
      )}

      {treeOpen && (
        <DrawObjectTree
          drawings={drawings}
          selected={sel}
          onSelect={(id, add) => select(add ? (sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]) : [id])}
          onPatch={(id, patch) => commit(drawingsRef.current.map((d) => (d.id === id ? { ...d, ...patch } : d)))}
          onDelete={(id) => commit(drawingsRef.current.filter((d) => d.id !== id))}
          onReorder={(id, how) => reorder(how, id)}
          onSettings={(id) => { select([id]); setSettings({ id, tab: 'style' }) }}
          onClose={() => setTreeOpen(false)}
          t={t}
        />
      )}

      {ctxMenu && selDrawings.length > 0 && (
        <div className="fixed z-menu min-w-[168px] rounded-lg float-panel p-1" style={{ left: ctxMenu.x, top: ctxMenu.y }} onClick={(e) => e.stopPropagation()} role="menu">
          {selDrawings.length === 1 && (
            <button type="button" role="menuitem" className={menuItem} onClick={() => { setSettings({ id: selDrawings[0].id, tab: 'style' }); setCtxMenu(null) }}>{t('charts.draw.settings')}</button>
          )}
          <button type="button" role="menuitem" className={menuItem} onClick={() => { cloneSelected(); setCtxMenu(null) }}>{t('charts.draw.clone')}</button>
          <button type="button" role="menuitem" className={menuItem} onClick={() => { copySelected(); setCtxMenu(null) }}>{t('charts.draw.copy')}</button>
          <button type="button" role="menuitem" className={menuItem} onClick={() => { toggleLock(); setCtxMenu(null) }}>{selDrawings.every((d) => d.locked) ? t('charts.draw.unlock') : t('charts.draw.lock')}</button>
          <button type="button" role="menuitem" className={menuItem} onClick={() => { patchSelected({ hidden: true }); select([]); setCtxMenu(null) }}>{t('charts.draw.hide')}</button>
          <div className="my-1 h-px bg-white/10" />
          <button type="button" role="menuitem" className={menuItem} onClick={() => { reorder('front'); setCtxMenu(null) }}>{t('charts.draw.zFront')}</button>
          <button type="button" role="menuitem" className={menuItem} onClick={() => { reorder('back'); setCtxMenu(null) }}>{t('charts.draw.zBack')}</button>
          <div className="my-1 h-px bg-white/10" />
          <button type="button" role="menuitem" className={`${menuItem} text-down`} onClick={() => { deleteSelected(); setCtxMenu(null) }}>{t('charts.draw.delete')}</button>
        </div>
      )}

      {settings && settingsDrawing && (
        <DrawSettingsDialog
          key={settings.id}
          drawing={settingsDrawing}
          initialTab={settings.tab}
          digits={digits}
          fmtTime={scene.fmtTime}
          templates={templates[settingsDrawing.type] ?? []}
          onPreview={previewDrawing}
          onApply={applySettings}
          onCancel={cancelSettings}
          onSaveTemplate={(name, d) => saveTemplate(d.type, name, styleOf(d))}
          onDeleteTemplate={(name) => deleteTemplate(settingsDrawing.type, name)}
          onSaveDefault={(d) => saveDefault(d.type, styleOf(d))}
          t={t}
        />
      )}

      {confirmOpen && (
        <ConfirmModal title={t('charts.draw.clear')} message={t('charts.draw.clearConfirm', { symbol })} confirmLabel={t('charts.draw.clear')} danger center
          onConfirm={doClearAll} onCancel={() => setConfirmOpen(false)} />
      )}
    </>
  )
}

export default forwardRef(DrawLayer)
