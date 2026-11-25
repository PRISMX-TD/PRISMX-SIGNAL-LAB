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
  TOOL_META, TOOL_HOTKEYS, COLORS, STYLE_KEYS, DEFAULT_EMOJI, isDrawType, sanitizeDrawings, finishPoints, uid, styleOf,
  pointsNeeded, isScreenAnchored, isPointer, BARS_PATTERN_MAX,
} from './draw/model'
import { DrawingsPrimitive, type DrawScene, barsBetweenTimes, LASER_MS } from './draw/primitive'
import { pickImageFile, compressImage } from './draw/image'
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

// 画完直接打开文字编辑的工具 / tools that open the text editor right after they're placed
const OPENS_TEXT = new Set<DrawType>(['text', 'anchoredText', 'note', 'pin', 'comment', 'callout', 'signpost', 'table'])

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
  const [notice, setNotice] = useState<string | null>(null)
  const noticeTimer = useRef<number | undefined>(undefined)
  const flash = useCallback((msg: string) => {
    window.clearTimeout(noticeTimer.current)
    setNotice(msg)
    noticeTimer.current = window.setTimeout(() => setNotice(null), 3500)
  }, [])
  useEffect(() => () => window.clearTimeout(noticeTimer.current), [])
  useBackToClose(confirmOpen, () => setConfirmOpen(false))

  // 收藏 / 模板 / 每种工具的默认样式（chartv2 偏好）/ favourites, templates, per-tool defaults (chartv2 prefs)
  const favorites = useMemo(() => {
    const raw = getPref<unknown>(CHART_PREFS_NS, 'drawFav', [])
    return Array.isArray(raw) ? (raw.filter((x) => isPointer(x) || isDrawType(x)) as Tool[]) : []
  }, [getPref])
  const toggleFavorite = useCallback((tl: Tool) => {
    setPref(CHART_PREFS_NS, 'drawFav', favorites.includes(tl) ? favorites.filter((x) => x !== tl) : [...favorites, tl])
  }, [favorites, setPref])
  const templates = useMemo(() => getPref<Record<string, DrawTemplate[]>>(CHART_PREFS_NS, 'drawTpl', {}) || {}, [getPref])
  // 每种工具上次用的样式（颜色、线宽、斐波那契档位……），改了就自动记住，下次画同一种直接沿用
  // Each tool's last-used style (colour, width, fib levels, ...), remembered on every edit and reused next time
  const defaults = useMemo(() => getPref<Record<string, StyleProps>>(CHART_PREFS_NS, 'drawDef', {}) || {}, [getPref])
  const defaultsRef = useRef(defaults)
  defaultsRef.current = defaults
  const rememberStyles = useCallback((changed: Drawing[]) => {
    const next = { ...defaultsRef.current }
    let dirty = false
    for (const d of changed) {
      const st = styleOf(d)
      if (JSON.stringify(next[d.type]) === JSON.stringify(st)) continue
      next[d.type] = st
      dirty = true
    }
    if (!dirty) return
    defaultsRef.current = next
    setPref(CHART_PREFS_NS, 'drawDef', next)
  }, [setPref])

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
  const polyClickRef = useRef<{ x: number; y: number; time: number } | null>(null)
  const touchSelRef = useRef(false)
  const lastTouchRef = useRef(false)
  const overlayRef = useRef<HTMLDivElement>(null)

  // ──── primitive 与场景 / primitive & scene ────
  const fmtPrice = useCallback((p: number) => p.toFixed(digits), [digits])
  const labels = useMemo<DrawLabels>(() => ({
    bars: String(t('charts.draw.lbl.bars')), rr: String(t('charts.draw.lbl.rr')), target: String(t('charts.draw.lbl.target')),
    stop: String(t('charts.draw.lbl.stop')), qty: String(t('charts.draw.lbl.qty')), risk: String(t('charts.draw.lbl.risk')),
    pips: String(t('charts.draw.lbl.pips')),
    ls: String(t('charts.draw.lbl.ls')), hd: String(t('charts.draw.lbl.hd')), rs: String(t('charts.draw.lbl.rs')),
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
    const next = drawingsRef.current.map((d) => (ids.has(d.id) ? { ...d, ...patch } : d))
    commit(next)
    // 改的是样式（不是锁定 / 隐藏）就记成这种工具的默认 / a style edit (not lock / hide) becomes the tool's default
    if ((STYLE_KEYS as readonly string[]).some((k) => k in patch)) {
      const seen = new Set<string>()
      rememberStyles(next.filter((d) => ids.has(d.id) && !seen.has(d.type) && seen.add(d.type)))
    }
  }, [commit, rememberStyles])
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
    if (selRef.current.length) { patchSelected({ color: c }); return }
    // 没选中、手上拿着工具：这个颜色记给这种工具 / nothing selected with a tool armed: the colour goes to that tool
    const cur = toolRef.current
    if (isDrawType(cur)) {
      const prev = defaultsRef.current[cur] ?? {}
      if (prev.color !== c) {
        const next = { ...defaultsRef.current, [cur]: { ...prev, color: c } }
        defaultsRef.current = next
        setPref(CHART_PREFS_NS, 'drawDef', next)
      }
    }
  }, [patchSelected, setPref])

  // 平移一组画线的点（像素位移换回时间 / 价格）/ shift a drawing's points by a pixel delta
  const shiftPts = useCallback((d: Drawing, orig: Point[], dx: number, dy: number): Point[] => orig.map((pt) => {
    // 锚定文本存的是屏幕比例 / anchored text stores screen fractions
    if (isScreenAnchored(d.type)) {
      const ps = chart.paneSize(0)
      return { t: Math.min(0.98, Math.max(0, pt.t + dx / (ps.width || 1))), p: Math.min(0.98, Math.max(0, pt.p + dy / (ps.height || 1))) }
    }
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

  const setTool = useCallback((tl0: Tool) => {
    // 再点一次正在用的画线工具 = 放下它回到光标 / picking the armed draw tool again puts it down
    const tl: Tool = isDrawType(tl0) && tl0 === toolRef.current ? 'cursor' : tl0
    createRef.current = null
    gestureRef.current = null
    const p = primRef.current
    if (p) { p.temp = null; p.requestUpdate() }
    toolRef.current = tl
    setToolState(tl)
    if (!isPointer(tl)) select([])
    // 工具栏的颜色点跟着显示这种工具上次的颜色 / the rail's colour dots show this tool's last colour
    if (isDrawType(tl)) { const c = defaultsRef.current[tl]?.color; if (c) setColor(c) }
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
    const last = defaultsRef.current[type] ?? {}
    const base: Drawing = { ...last, id: uid(), type, pts, color: last.color || colorRef.current }
    if (last.levels) base.levels = last.levels.map((lv) => ({ ...lv }))
    if (type === 'emoji') base.text = DEFAULT_EMOJI
    else if (type === 'table') base.text = String(t('charts.draw.tableDefault'))
    else if (OPENS_TEXT.has(type)) base.text = String(t('charts.draw.textDefault'))
    return base
  }, [t])
  // 选图 → 压缩；失败给提示 / pick → squeeze; a notice on failure
  const chooseImage = useCallback(async (): Promise<{ url: string; w: number; h: number } | null> => {
    const f = await pickImageFile()
    if (!f) return null
    try {
      const r = await compressImage(f)
      if (!r) flash(String(t('charts.draw.imageTooBig')))
      return r
    } catch {
      flash(String(t('charts.draw.imageBad')))
      return null
    }
  }, [flash, t])
  // 图片放进去，框的高度按图片比例调 / put the image in and fit the box height to its aspect ratio
  const placeImage = useCallback((id: string, img: { url: string; w: number; h: number }) => {
    const list = drawingsRef.current
    const d = list.find((q) => q.id === id)
    if (!d) return
    let pts = d.pts
    const a = timeToX(chart, d.pts[0].t), b = timeToX(chart, d.pts[1].t)
    const ya = series.priceToCoordinate(d.pts[0].p), yb = series.priceToCoordinate(d.pts[1].p)
    if (a != null && b != null && ya != null && yb != null && img.w > 0) {
      const hpx = Math.abs(b - a) * (img.h / img.w)
      const p1 = series.coordinateToPrice(ya + (yb >= ya ? hpx : -hpx)) as number | null
      if (p1 != null) pts = [d.pts[0], { t: d.pts[1].t, p: p1 }]
    }
    commit(list.map((q) => (q.id === id ? { ...q, img: img.url, pts } : q)))
  }, [chart, series, commit])
  const finishCreate = useCallback((d0: Drawing) => {
    createRef.current = null
    const p = primRef.current
    if (p) p.temp = null
    let d = d0
    // K 线形态复制：把框住的 K 线拷下来（相对第一根开盘价），副本先叠在原处，拖走即可
    // Bars pattern: copy the spanned bars (relative to the first open); the copy starts on top of the source
    if (d.type === 'barsPattern') {
      const t0 = Math.min(d.pts[0].t, d.pts[1].t), t1 = Math.max(d.pts[0].t, d.pts[1].t)
      let src = barsBetweenTimes(series, chart, t0, t1)
      if (src.length > BARS_PATTERN_MAX) src = src.slice(-BARS_PATTERN_MAX)
      if (src.length < 2) { p?.requestUpdate(); flash(String(t('charts.draw.barsTooFew'))); return }
      const base = src[0].o
      const r = (v: number) => Number((v - base).toPrecision(8))
      d = { ...d, bars: src.map((b) => [r(b.o), r(b.h), r(b.l), r(b.c)]), pts: [{ t: src[0].t, p: base }, { t: src[0].t, p: base }] }
    }
    const done: Drawing = { ...d, pts: finishPoints(d.type, d.pts) }
    commit([...drawingsRef.current, done])
    select([done.id])
    if (!stayRef.current) setToolState('cursor')
    // 文字类工具画完直接打开文字编辑 / text tools open the text editor straight away
    if (OPENS_TEXT.has(done.type)) setSettings({ id: done.id, tab: 'text' })
    // 图片：框画好马上弹选图（还在抬手这个手势里）/ image: the chooser opens right away, still inside the release gesture
    if (done.type === 'image') void chooseImage().then((img) => { if (img) placeImage(done.id, img) })
  }, [commit, select, series, chart, flash, t, chooseImage, placeImage])
  // 折线 / 路径：去掉跟着鼠标的那个浮动点再完成（至少两个点）
  // Polyline / path: drop the floating point that follows the mouse, then finish (two points at least)
  const finishPoly = useCallback((closed = false) => {
    const c = createRef.current
    if (!c || TOOL_META[c.d.type].create !== 'poly') return false
    const pts = c.d.pts.slice(0, -1)
    if (pts.length < 2) return false
    finishCreate({ ...c.d, pts, ...(closed ? { closed: true } : {}) })
    return true
  }, [finishCreate])
  const cancelCreate = useCallback(() => {
    createRef.current = null
    gestureRef.current = null
    showTemp()
  }, [showTemp])

  // 江恩正方（固定）：按屏幕像素锁成正方形，keep = 不动的那个点 / Gann square fixed: kept square on screen, keep = the fixed point
  const squared = useCallback((pts: Point[], keep: 0 | 1): Point[] => {
    const a = pxOf(pts[keep]), b = pxOf(pts[1 - keep])
    if (![a.x, a.y, b.x, b.y].every(Number.isFinite)) return pts
    const side = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y))
    const q = toPoint(a.x + Math.sign(b.x - a.x || 1) * side, a.y + Math.sign(b.y - a.y || 1) * side)
    if (!q) return pts
    const out = pts.map((x) => ({ ...x }))
    out[1 - keep] = q
    return out
  }, [pxOf, toPoint])

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
    const parallel = d.type === 'channel' || d.type === 'fibChannel'
    if (c.step === 2 && parallel) {
      // 通道第三点：鼠标到基线的价差就是通道宽 / channel point 3: its price gap to the base line is the width
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
      // 后面还没放的点先跟着当前点（通道先是一条线）/ points not placed yet follow this one (a channel starts flat)
      for (let k = c.step + 1; k < d.pts.length; k++) d.pts[k] = parallel ? { ...d.pts[0] } : { ...pt }
    }
    if (d.type === 'gannSquareFixed' && c.step === 1) d.pts = squared(d.pts, 0)
    showTemp()
  }, [snap, pxOf, series, toPoint, showTemp, squared])

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

    if (!isPointer(cur)) {
      if (!inMainPane(y)) return
      const type = cur as DrawType
      const meta = TOOL_META[type]
      const c = createRef.current
      if (c) {
        if (meta.create === 'poly') {
          // 折线 / 路径：双击结束；点回第一个点 = 闭合（折线）/ polyline / path: double-click ends; back on point 1 closes
          const now = Date.now()
          const lastDown = polyClickRef.current
          polyClickRef.current = { x, y, time: now }
          if (lastDown && now - lastDown.time < 350 && Math.hypot(x - lastDown.x, y - lastDown.y) < 8) { if (!finishPoly()) cancelCreate(); return }
          const first = pxOf(c.d.pts[0])
          if (type === 'polyline' && c.d.pts.length >= 4 && Math.hypot(x - first.x, y - first.y) <= 8) { finishPoly(true); return }
          updateCreate(x, y, e.shiftKey)
          c.d.pts.push({ ...c.d.pts[c.d.pts.length - 1] })
          c.step = c.d.pts.length - 1
          showTemp()
          return
        }
        // 多点工具的后续点击：落点 / follow-up click of a multi-point tool
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
        if (isScreenAnchored(type)) { const ps = chart.paneSize(0); d.pts = [{ t: s.x / (ps.width || 1), p: s.y / (ps.height || 1) }] }
        finishCreate(d)
        return
      }
      if (meta.create === 'poly') {
        polyClickRef.current = { x, y, time: Date.now() }
        createRef.current = { d: newDrawing(type, [pt, { ...pt }]), step: 1 }
        showTemp()
        return
      }
      if (meta.create === 'free') {
        createRef.current = { d: newDrawing(type, [pt]), step: -1 }
        gestureRef.current = { k: 'brush', pointerId: e.pointerId }
        showTemp()
        return
      }
      const pts = Array.from({ length: pointsNeeded(type) }, () => ({ ...pt }))
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
  }, [cancelCreate, updateCreate, snap, toPoint, newDrawing, finishCreate, finishPoly, showTemp, select, pxOf, chart]) // eslint-disable-line react-hooks/exhaustive-deps

  // 交互层接管指针时图表收不到移动事件，十字光标会停住：这里替它跟上（画线 / 拉手柄时跟着磁吸后的点）
  // While the layer holds the pointer the chart gets no moves and its crosshair freezes: drive it from
  // here (following the magnet-snapped point while drawing / dragging a handle)
  const syncCrosshair = useCallback((x: number, y: number) => {
    if (!isChartAlive(chart)) return
    const tt = chart.timeScale().coordinateToTime(x)
    const pp = series.coordinateToPrice(y) as number | null
    if (tt == null || pp == null || y > chart.paneSize(0).height) { chart.clearCrosshairPosition(); return }
    chart.setCrosshairPosition(pp, tt, series as never)
  }, [chart, series])

  const onMove = useCallback((e: RPointerEvent<HTMLDivElement>) => {
    const g = gestureRef.current
    const { x, y } = localXY(e)
    if (!isTouchLike(e.pointerType)) {
      const sp = createRef.current || g?.k === 'handle' ? snap(x, y) : { x, y }
      syncCrosshair(sp.x, sp.y)
    }
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
      setCursorStyle(g.k === 'handle' ? 'grabbing' : 'move')
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
      let dx = x - g.startX, dy = y - g.startY
      // Shift：只沿水平或垂直方向挪 / Shift: move along one axis only
      if (e.shiftKey) { if (Math.abs(dx) >= Math.abs(dy)) dy = 0; else dx = 0 }
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
    let pts = dragHandle(d, g.handle, pt, g.orig)
    if (d.type === 'gannSquareFixed') pts = squared(pts, g.handle === 0 ? 1 : 0)
    paint(list.map((q) => (q.id === g.id ? { ...q, pts } : q)))
  }, [updateCreate, pxOf, toPoint, showTemp, commit, select, paint, shiftPts, snap, syncCrosshair, squared])

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
          // 图片：点一下放一个默认大小的框 / image: a click drops a default-sized box
          if (d.type === 'image') {
            const end = toPoint(a.x + 180, a.y + 120)
            if (end) { d.pts[1] = end; finishCreate(d) } else cancelCreate()
            return
          }
          // 原地点一下：进入「点两下」模式，悬停跟随，下一次点击落第二个点
          // A click in place: click-click mode, the point follows the hover until the next click
          if (clickOnly) return
          cancelCreate()
          return
        }
        if (pointsNeeded(d.type) > 2) { c.step = 2; showTemp(); return }
        finishCreate(d)
        return
      }
      // 多点工具：还没放够就等下一个点 / multi-point tools wait for the next point until all are placed
      if (c.step + 1 < pointsNeeded(d.type)) { c.step += 1; showTemp(); return }
      finishCreate(d)
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
      if (!isPointer(toolRef.current)) return
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
        if (!isPointer(toolRef.current)) return
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
      // 回车结束折线 / 路径 / Enter finishes a polyline / path
      if (e.key === 'Enter' && createRef.current && TOOL_META[createRef.current.d.type].create === 'poly') { e.preventDefault(); finishPoly(); return }
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
  }, [host, chart, cancelCreate, select, undo, redo, deleteSelected, copySelected, paste, setTool, shiftPts, commit, commitNoHistory, finishPoly])

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
    const setHover = (id: string | null, handle = -1) => {
      const p = primRef.current
      if (p && (p.hover !== id || p.hoverHandle !== handle)) { p.hover = id; p.hoverHandle = handle; p.requestUpdate() }
    }
    const evaluate = () => {
      frame = 0
      const p = last
      if (!p) return
      if (gestureRef.current) { el.style.pointerEvents = 'auto'; return }
      if (!isPointer(toolRef.current)) { el.style.pointerEvents = 'auto'; setCursorStyle('crosshair'); return }
      const r = el.getBoundingClientRect()
      const x = p.x - r.left, y = p.y - r.top
      if (x < 0 || y < 0 || x > r.width || y > r.height) { el.style.pointerEvents = 'none'; setCursorStyle(''); setHover(null); return }
      const h = primRef.current?.hitAt(x, y) ?? null
      setHover(h?.d.id ?? null, h?.handle ?? -1)
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
      if (toolRef.current === 'presenter' && !isTouchLike(e.pointerType)) pushLaser(e.clientX, e.clientY)
      if (gestureRef.current || (!isPointer(toolRef.current))) {
        el.style.pointerEvents = 'auto'
        if (!gestureRef.current) setCursorStyle('crosshair')
        return
      }
      if (isTouchLike(e.pointerType)) return
      last = { x: e.clientX, y: e.clientY, ctrl: e.ctrlKey || e.metaKey }
      // 同步判定（不等下一帧）：鼠标刚移到线上马上按下，也能抓到线，不会变成拖图表
      // Evaluated synchronously (not next frame): a press right after reaching a line grabs the line, not the chart
      if (frame !== 0) { window.cancelAnimationFrame(frame); frame = 0 }
      evaluate()
    }
    // 交互层接管时，滚轮照样交给图表缩放 / scrolling still zooms the chart while the layer holds the pointer
    const onWheel = (e: WheelEvent) => {
      if (el.style.pointerEvents !== 'auto') return
      el.style.pointerEvents = 'none'
      const under = document.elementFromPoint(e.clientX, e.clientY)
      el.style.pointerEvents = 'auto'
      if (!under || under === el || el.contains(under)) return
      e.preventDefault()
      under.dispatchEvent(new WheelEvent('wheel', e))
    }
    const onLeave = () => { if (!gestureRef.current && isChartAlive(chart)) chart.clearCrosshairPosition() }
    // 演示光标：记下轨迹，动画帧里一直重画到轨迹淡完 / presenter: record the trail, repaint each frame until it fades
    let laserFrame = 0
    const tickLaser = () => {
      laserFrame = 0
      const p = primRef.current
      if (!p) return
      const now = performance.now()
      p.laser = p.laser.filter((q, i, arr) => now - q.at < LASER_MS || i === arr.length - 1)
      if (p.laser.length && now - p.laser[p.laser.length - 1].at > LASER_MS * 4) p.laser = []
      p.requestUpdate()
      if (p.laser.length) laserFrame = window.requestAnimationFrame(tickLaser)
    }
    const pushLaser = (cx: number, cy: number) => {
      const p = primRef.current
      if (!p) return
      const r = el.getBoundingClientRect()
      const x = cx - r.left, y = cy - r.top
      if (x < 0 || y < 0 || x > r.width || y > chart.paneSize(0).height) return
      p.laser.push({ x, y, at: performance.now() })
      if (p.laser.length > 80) p.laser.shift()
      if (!laserFrame) laserFrame = window.requestAnimationFrame(tickLaser)
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
      if (!isPointer(toolRef.current)) return
      el.style.pointerEvents = 'none'
    }
    window.addEventListener('pointermove', onHover, true)
    window.addEventListener('pointerdown', onPress, true)
    window.addEventListener('pointerup', onRelease)
    window.addEventListener('pointercancel', onRelease)
    window.addEventListener('keydown', onCtrl)
    window.addEventListener('keyup', onCtrl)
    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('pointerleave', onLeave)
    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('pointerleave', onLeave)
      window.removeEventListener('pointermove', onHover, true)
      window.removeEventListener('pointerdown', onPress, true)
      window.removeEventListener('pointerup', onRelease)
      window.removeEventListener('pointercancel', onRelease)
      window.removeEventListener('keydown', onCtrl)
      window.removeEventListener('keyup', onCtrl)
      if (frame !== 0) window.cancelAnimationFrame(frame)
      if (laserFrame) window.cancelAnimationFrame(laserFrame)
    }
  }, [chart])

  // 演示光标：藏起系统光标和十字线，离开时还原 / presenter: hide the system cursor and the crosshair, restored on leave
  useEffect(() => {
    if (tool !== 'presenter' || !isChartAlive(chart)) return
    const ch = chart.options().crosshair
    const prev = { v: ch.vertLine.visible, h: ch.horzLine.visible, vl: ch.vertLine.labelVisible, hl: ch.horzLine.labelVisible }
    chart.applyOptions({ crosshair: { vertLine: { visible: false, labelVisible: false }, horzLine: { visible: false, labelVisible: false } } })
    host.classList.add('chart-presenter')
    return () => {
      host.classList.remove('chart-presenter')
      const p = primRef.current
      if (p) { p.laser = []; p.requestUpdate() }
      if (isChartAlive(chart)) chart.applyOptions({ crosshair: { vertLine: { visible: prev.v, labelVisible: prev.vl }, horzLine: { visible: prev.h, labelVisible: prev.hl } } })
    }
  }, [tool, chart, host])

  useEffect(() => {
    const el = overlayRef.current; if (!el) return
    if (!isPointer(tool)) { el.style.pointerEvents = 'auto'; setCursorStyle('crosshair') }
    else { el.style.pointerEvents = 'none'; setCursorStyle('') }
  }, [tool])

  // 选中被别的路径清掉时，撤掉手指点选带来的接管 / drop tap-selection arming when the selection clears
  useEffect(() => {
    if (sel.length) return
    touchSelRef.current = false
    const el = overlayRef.current
    if (el && !gestureRef.current && (isPointer(toolRef.current))) el.style.pointerEvents = 'none'
  }, [sel])

  // ──── 设置弹窗：实时预览，确定才提交 / settings dialog: live preview, committed on OK ────
  const settingsDrawing = settings ? drawings.find((d) => d.id === settings.id) ?? null : null
  const previewDrawing = useCallback((d: Drawing) => {
    paint(drawingsRef.current.map((q) => (q.id === d.id ? d : q)))
  }, [paint])
  const applySettings = useCallback((d: Drawing) => {
    setSettings(null)
    const before = drawingsRef.current.find((q) => q.id === d.id)
    if (before && JSON.stringify(before) !== JSON.stringify(d)) {
      commit(drawingsRef.current.map((q) => (q.id === d.id ? d : q)))
      rememberStyles([d])
    } else paint()
  }, [commit, paint, rememberStyles])
  const cancelSettings = useCallback(() => { setSettings(null); paint() }, [paint])
  const saveTemplate = useCallback((type: DrawType, name: string, style: StyleProps) => {
    const list = (templates[type] ?? []).filter((x) => x.name !== name)
    setPref(CHART_PREFS_NS, 'drawTpl', { ...templates, [type]: [...list, { name, style }].slice(-20) })
  }, [templates, setPref])
  const deleteTemplate = useCallback((type: DrawType, name: string) => {
    setPref(CHART_PREFS_NS, 'drawTpl', { ...templates, [type]: (templates[type] ?? []).filter((x) => x.name !== name) })
  }, [templates, setPref])

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
        style={{ display: visible ? '' : 'none', cursor: cursorStyle || (!isPointer(tool) ? 'crosshair' : 'default') }}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onCancel}
        onContextMenu={(e) => {
          e.preventDefault()
          // 画到一半右键 = 取消这一笔 / a right-click mid-stroke cancels it
          if (createRef.current) { cancelCreate(); return }
          if (!isPointer(tool)) return
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
          onPickImage={chooseImage}
          t={t}
        />
      )}

      {notice && <div className="draw-notice" role="status">{notice}</div>}

      {confirmOpen && (
        <ConfirmModal title={t('charts.draw.clear')} message={t('charts.draw.clearConfirm', { symbol })} confirmLabel={t('charts.draw.clear')} danger center
          onConfirm={doClearAll} onCancel={() => setConfirmOpen(false)} />
      )}
    </>
  )
}

export default forwardRef(DrawLayer)
