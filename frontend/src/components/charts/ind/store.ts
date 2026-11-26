// 指标布局（实例列表 + 窗格 + 收藏 / 最近 / 模板 / 默认值）的读写规则。存在云端偏好的
// 新键 chartv2 / ind；旧键 charts.indicators / charts.indicatorSettings 原样不动，旧 App 包
// 继续认它们。第一次读到新键为空时，按旧开关与旧参数迁移出一份（不主动写回，用户第一次改动
// 才落库）。每次读回都过 normalizeLayout：坏值、未知指标、空窗格一律剔除。
// Rules for the indicator layout (instances + panes + favourites / recent / templates /
// defaults), stored under the new cloud key chartv2 / ind. The old charts.indicators /
// charts.indicatorSettings keys stay untouched so old App bundles keep reading them. While the
// new key is empty, a layout is migrated from the old toggles and settings (not written back
// until the user's first change). Every read passes normalizeLayout.
import { DEFAULT_INDICATOR_SETTINGS, mergeIndicatorSettings, type IndicatorSettings } from '../indicatorSettings'
import { defOf, defaultInputs } from './registry'
import {
  MAX_INSTANCES, SOURCE_KINDS, VIS_KINDS,
  type IndInstance, type IndLayout, type IndPane, type IndTemplate, type Inputs, type PlotStyle, type VisRule,
} from './types'

export const IND_NS = 'chartv2'
export const IND_KEY = 'ind'

const HEX = /^#[0-9a-fA-F]{6}$/
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const isColor = (c: unknown): c is string => typeof c === 'string' && (HEX.test(c) || c === 'up' || c === 'down')

export function newUid(): string {
  return Math.random().toString(36).slice(2, 10)
}

export const EMPTY_LAYOUT: IndLayout = { v: 1, list: [], panes: [], mainH: 3, favs: [], recent: [], tpls: [], defaults: {} }

// 输入值按定义校验：数字夹进区间、选项必须在列表里、数据源可以是价格或指标引用。
// Inputs validated against the definition: numbers clamped, options from the list, sources a price or an indicator ref.
export function cleanInputs(type: string, raw: unknown): Inputs {
  const def = defOf(type)
  if (!def) return {}
  const r = obj(raw)
  const out: Inputs = {}
  for (const d of def.inputs) {
    const v = r[d.key]
    switch (d.kind) {
      case 'int': case 'float': {
        const n = typeof v === 'number' && Number.isFinite(v) ? v : d.def
        const c = Math.min(d.max, Math.max(d.min, n))
        out[d.key] = d.kind === 'int' ? Math.round(c) : c
        break
      }
      case 'bool': out[d.key] = typeof v === 'boolean' ? v : d.def; break
      case 'source':
        out[d.key] = typeof v === 'string' && ((SOURCE_KINDS as string[]).includes(v) || /^ind:[\w-]+:[\w#-]+$/.test(v)) ? v : d.def
        break
      case 'ma': {
        const opts = d.options ?? ['sma', 'ema', 'wma', 'rma', 'hma', 'dema', 'tema', 'vwma', 'alma', 'lsma']
        out[d.key] = typeof v === 'string' && opts.includes(v as never) ? v : d.def
        break
      }
      case 'select': out[d.key] = typeof v === 'string' && d.options.includes(v) ? v : d.def; break
      case 'symbol': out[d.key] = typeof v === 'string' && /^[A-Za-z0-9._#&-]{1,24}$/.test(v) ? v : d.def; break
    }
  }
  return out
}

function cleanStyle(raw: unknown): PlotStyle {
  const r = obj(raw)
  const s: PlotStyle = {}
  if (typeof r.visible === 'boolean') s.visible = r.visible
  if (isColor(r.color)) s.color = r.color
  if (Array.isArray(r.colors) && r.colors.every(isColor)) s.colors = (r.colors as string[]).slice(0, 8)
  if (typeof r.opacity === 'number' && r.opacity >= 0 && r.opacity <= 100) s.opacity = Math.round(r.opacity)
  if (typeof r.width === 'number' && r.width >= 1 && r.width <= 4) s.width = Math.round(r.width)
  if (r.dash === 'solid' || r.dash === 'dashed' || r.dash === 'dotted') s.dash = r.dash
  if (typeof r.kind === 'string' && ['line', 'step', 'hist', 'columns', 'area', 'points', 'cross'].includes(r.kind)) s.kind = r.kind as PlotStyle['kind']
  if (typeof r.value === 'number' && Number.isFinite(r.value)) s.value = r.value
  return s
}

function cleanStyles(raw: unknown): Record<string, PlotStyle> {
  const out: Record<string, PlotStyle> = {}
  for (const [k, v] of Object.entries(obj(raw)).slice(0, 40)) {
    const s = cleanStyle(v)
    if (Object.keys(s).length) out[k.slice(0, 40)] = s
  }
  return out
}

function cleanVis(raw: unknown): VisRule | undefined {
  const r = obj(raw)
  const out: VisRule = {}
  for (const k of VIS_KINDS) {
    const x = obj(r[k])
    if (typeof x.on !== 'boolean') continue
    out[k] = { on: x.on, from: Number(x.from) || 1, to: Number(x.to) || 1 }
  }
  return Object.keys(out).length ? out : undefined
}

export function cleanInstance(raw: unknown, panes: Set<string>): IndInstance | null {
  const r = obj(raw)
  const type = typeof r.type === 'string' ? r.type : ''
  if (!defOf(type)) return null
  const uid = typeof r.uid === 'string' && /^[\w-]{1,24}$/.test(r.uid) ? r.uid : newUid()
  const pane = typeof r.pane === 'string' && (r.pane === 'main' || panes.has(r.pane)) ? r.pane : 'main'
  const inst: IndInstance = { uid, type, inputs: cleanInputs(type, r.inputs), styles: cleanStyles(r.styles), pane }
  if (r.hidden === true) inst.hidden = true
  if (r.scale === 'right' || r.scale === 'left' || r.scale === 'none') inst.scale = r.scale
  if (typeof r.precision === 'number' && r.precision >= 0 && r.precision <= 8) inst.precision = Math.round(r.precision)
  if (typeof r.labels === 'boolean') inst.labels = r.labels
  if (typeof r.tf === 'string' && r.tf.length <= 8) inst.tf = r.tf
  if (r.tfWait === true) inst.tfWait = true
  const vis = cleanVis(r.vis)
  if (vis) inst.vis = vis
  return inst
}

function cleanPanes(raw: unknown): IndPane[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: IndPane[] = []
  for (const x of raw.slice(0, 20)) {
    const r = obj(x)
    if (typeof r.id !== 'string' || !/^[\w-]{1,24}$/.test(r.id) || seen.has(r.id)) continue
    seen.add(r.id)
    const h = typeof r.h === 'number' && r.h > 0 && r.h < 100 ? r.h : 1
    out.push({ id: r.id, h, ...(r.collapsed === true ? { collapsed: true } : {}) })
  }
  return out
}

// 去掉没有实例的窗格 / drop panes without instances
export function prunePanes(l: IndLayout): IndLayout {
  const used = new Set(l.list.map((i) => i.pane))
  const panes = l.panes.filter((p) => used.has(p.id))
  return panes.length === l.panes.length ? l : { ...l, panes }
}

export function normalizeLayout(raw: unknown): IndLayout {
  const r = obj(raw)
  const panes = cleanPanes(r.panes)
  const ids = new Set(panes.map((p) => p.id))
  const list: IndInstance[] = []
  const uids = new Set<string>()
  if (Array.isArray(r.list)) {
    for (const x of r.list.slice(0, MAX_INSTANCES)) {
      const inst = cleanInstance(x, ids)
      if (!inst || uids.has(inst.uid)) continue
      uids.add(inst.uid)
      list.push(inst)
    }
  }
  const strs = (v: unknown, max: number) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!defOf(x)).slice(0, max) : [])
  const tpls: IndTemplate[] = Array.isArray(r.tpls)
    ? r.tpls.slice(0, 20).flatMap((x) => {
        const t = obj(x)
        if (typeof t.name !== 'string' || !t.name.trim()) return []
        const tp = cleanPanes(t.panes)
        const tids = new Set(tp.map((p) => p.id))
        const tl = Array.isArray(t.list) ? t.list.slice(0, MAX_INSTANCES).map((i) => cleanInstance(i, tids)).filter((i): i is IndInstance => !!i) : []
        return [{ name: t.name.slice(0, 40), list: tl.map(({ uid: _u, ...rest }) => rest), panes: tp }]
      })
    : []
  const defaults: IndLayout['defaults'] = {}
  for (const [k, v] of Object.entries(obj(r.defaults))) {
    if (!defOf(k)) continue
    const d = obj(v)
    defaults[k] = { inputs: cleanInputs(k, d.inputs), styles: cleanStyles(d.styles) }
  }
  return prunePanes({
    v: 1,
    list,
    panes,
    mainH: typeof r.mainH === 'number' && r.mainH > 0 && r.mainH < 100 ? r.mainH : 3,
    favs: strs(r.favs, 60),
    recent: strs(r.recent, 12),
    tpls,
    defaults,
  })
}

// ── 迁移旧指标（14 个开关 + 参数）/ migrate the legacy indicators (14 toggles + settings) ──
const LEGACY_ORDER = ['ma', 'ema', 'boll', 'donch', 'vwap', 'st', 'sar', 'rsi', 'macd', 'kdj', 'cci', 'wr', 'atr', 'volume', 'obv', 'xmab', 'macandle', 'shenlong', 'kpsq'] as const

export function migrateLegacy(flagsRaw: unknown, settingsRaw: unknown): IndLayout {
  const flags = obj(flagsRaw)
  // 旧默认：只开成交量 / legacy default: volume only
  const on = (k: string) => (k in flags ? flags[k] === true : k === 'volume')
  const s: IndicatorSettings = mergeIndicatorSettings(DEFAULT_INDICATOR_SETTINGS, obj(settingsRaw) as Partial<IndicatorSettings>)
  const list: IndInstance[] = []
  const panes: IndPane[] = []
  const w = (x: { width?: number }) => (x.width && x.width > 1 ? { width: x.width } : {})
  const dash = (x: { dash?: string }) => (x.dash === 'dashed' ? { dash: 'dashed' as const } : {})
  const add = (key: string, type: string, inputs: Inputs, styles: Record<string, PlotStyle>, sub: boolean, size?: string) => {
    let pane = 'main'
    if (sub) {
      pane = `p-${key}`
      panes.push({ id: pane, h: size === 'sm' ? 0.7 : size === 'lg' ? 1.4 : 1 })
    }
    list.push({ uid: `m-${key}`, type, inputs: cleanInputs(type, inputs), styles, pane })
  }
  for (const k of LEGACY_ORDER) {
    if (!on(k)) continue
    switch (k) {
      case 'ma': case 'ema':
        s[k].periods.forEach((p, i) => add(`${k}${i}`, k === 'ma' ? 'sma' : 'ema', { len: p }, { ma: { color: s[k].colors[i], ...w(s[k]), ...dash(s[k]) } }, false))
        break
      case 'boll': {
        const c = { color: s.boll.color, ...w(s.boll) }
        add(k, 'bb', { len: s.boll.period, mult: s.boll.mult }, { basis: c, upper: { ...c, dash: 'dashed' }, lower: { ...c, dash: 'dashed' }, 'f:bg': { visible: false } }, false)
        break
      }
      case 'donch': add(k, 'dc', { len: s.donch.period }, { upper: { color: s.donch.color }, lower: { color: s.donch.color }, basis: { visible: false }, 'f:bg': { visible: false } }, false); break
      case 'vwap': add(k, 'vwap', {}, { vwap: { color: s.vwap.color, ...w(s.vwap) } }, false); break
      case 'st': add(k, 'supertrend', { atrLen: s.st.period, mult: s.st.mult }, { up: { color: s.st.upColor }, dn: { color: s.st.downColor } }, false); break
      case 'sar': add(k, 'psar', { step: s.sar.step, max: s.sar.max }, { sar: { color: s.sar.color, kind: 'points' } }, false); break
      case 'rsi': add(k, 'rsi', { len: s.rsi.period }, { rsi: { color: s.rsi.color, ...w(s.rsi) }, 'h:ob': { value: s.rsi.overbought }, 'h:os': { value: s.rsi.oversold } }, true, s.rsi.size); break
      case 'macd': add(k, 'macd', { fast: s.macd.fast, slow: s.macd.slow, signal: s.macd.signal }, { macd: { color: s.macd.macdColor }, signal: { color: s.macd.signalColor } }, true, s.macd.size); break
      case 'kdj': add(k, 'kdj', { len: s.kdj.period, kSmooth: s.kdj.kSmooth, dSmooth: s.kdj.dSmooth }, { k: { color: s.kdj.kColor }, d: { color: s.kdj.dColor }, j: { color: s.kdj.jColor } }, true, s.kdj.size); break
      case 'cci': add(k, 'cci', { len: s.cci.period, src: 'hlc3' }, { cci: { color: s.cci.color } }, true, s.cci.size); break
      case 'wr': add(k, 'willr', { len: s.wr.period }, { r: { color: s.wr.color } }, true, s.wr.size); break
      case 'atr': add(k, 'atr', { len: s.atr.period }, { atr: { color: s.atr.color } }, true, s.atr.size); break
      case 'volume': add(k, 'vol', {}, {}, true, s.volume.size); break
      case 'obv': add(k, 'obv', {}, { obv: { color: s.obv.color } }, true, s.obv.size); break
      case 'xmab': add(k, 'xmab', { period: s.xmab.period, p1: s.xmab.p1, p2: s.xmab.p2 }, {}, false); break
      case 'macandle': add(k, 'macandle', { period: s.macandle.period, delay: s.macandle.delay }, {}, false); break
      case 'shenlong': add(k, 'shenlong', { period: s.shenlong.period }, {}, false); break
      case 'kpsq': add(k, 'kpsq', { ma1: s.kpsq.ma1, ma2: s.kpsq.ma2, ma3: s.kpsq.ma3 }, {}, false); break
    }
  }
  return { ...EMPTY_LAYOUT, list, panes }
}

// ── 编辑操作（全部返回新对象）/ edits (all return a new layout) ──
const CYCLE = ['#f5c451', '#38bdf8', '#a78bfa', '#22d3ee', '#fb7185', '#2ee07e', '#facc15', '#f472b6', '#ff6d00', '#2962ff']

export function addInstance(l: IndLayout, type: string, at?: { pane?: string }): { layout: IndLayout; uid: string } | null {
  const def = defOf(type)
  if (!def || l.list.length >= MAX_INSTANCES) return null
  const uid = newUid()
  const d = l.defaults[type]
  const styles: Record<string, PlotStyle> = { ...(d?.styles ?? {}) }
  // 同一种指标加第二个：第一条线换个颜色，免得叠在一起分不清
  // A second instance of a kind: give its first line another colour so they don't blend
  const same = l.list.filter((i) => i.type === type)
  const first = def.plots[0]
  if (same.length > 0 && first && !first.colors && !first.shape && !styles[first.key]?.color) {
    const used = new Set(same.map((i) => i.styles[first.key]?.color ?? first.color))
    const c = CYCLE.find((x) => !used.has(x)) ?? CYCLE[same.length % CYCLE.length]
    styles[first.key] = { ...styles[first.key], color: c }
  }
  let panes = l.panes
  let pane = at?.pane ?? 'main'
  if (!at?.pane && !def.overlay) {
    pane = `p${newUid()}`
    panes = [...panes, { id: pane, h: 1 }]
  }
  const inst: IndInstance = { uid, type, inputs: { ...defaultInputs(def), ...(d?.inputs ?? {}) }, styles, pane }
  const recent = [type, ...l.recent.filter((x) => x !== type)].slice(0, 12)
  return { layout: { ...l, list: [...l.list, inst], panes, recent }, uid }
}

export function updateInstance(l: IndLayout, uid: string, patch: Partial<IndInstance> | ((i: IndInstance) => IndInstance)): IndLayout {
  return { ...l, list: l.list.map((i) => (i.uid === uid ? (typeof patch === 'function' ? patch(i) : { ...i, ...patch }) : i)) }
}

export function removeInstance(l: IndLayout, uid: string): IndLayout {
  // 被别人当数据源的，引用退回收盘价 / instances using it as a source fall back to close
  const list = l.list.filter((i) => i.uid !== uid).map((i) => {
    const bad = Object.entries(i.inputs).filter(([, v]) => typeof v === 'string' && v.startsWith(`ind:${uid}:`))
    if (!bad.length) return i
    return { ...i, inputs: { ...i.inputs, ...Object.fromEntries(bad.map(([k]) => [k, 'close'])) } }
  })
  return prunePanes({ ...l, list })
}

export function duplicateInstance(l: IndLayout, uid: string): IndLayout {
  const src = l.list.find((i) => i.uid === uid)
  if (!src || l.list.length >= MAX_INSTANCES) return l
  const copy: IndInstance = JSON.parse(JSON.stringify(src))
  copy.uid = newUid()
  const at = l.list.indexOf(src)
  const list = [...l.list]
  list.splice(at + 1, 0, copy)
  return { ...l, list }
}

// 移动实例：到主图、某个已有窗格，或在某位置新建窗格 / move to main, an existing pane, or a new pane at an index
export function moveInstance(l: IndLayout, uid: string, target: { pane: string } | { newPaneAt: number }): IndLayout {
  let panes = l.panes
  let pane: string
  if ('pane' in target) pane = target.pane
  else {
    pane = `p${newUid()}`
    panes = [...panes]
    panes.splice(Math.max(0, Math.min(panes.length, target.newPaneAt)), 0, { id: pane, h: 1 })
  }
  const inst = l.list.find((i) => i.uid === uid)
  if (!inst) return l
  // 移到主图的副图指标默认用自己的价格轴，免得把 K 线压扁 / oscillators moved to main get their own scale
  const def = defOf(inst.type)
  const scale = pane === 'main' && def && !def.overlay ? 'none' : inst.scale === 'none' && pane !== 'main' ? undefined : inst.scale
  return prunePanes({ ...updateInstance({ ...l, panes }, uid, { pane, scale }) })
}

export function movePane(l: IndLayout, id: string, dir: -1 | 1): IndLayout {
  const i = l.panes.findIndex((p) => p.id === id)
  const j = i + dir
  if (i < 0 || j < 0 || j >= l.panes.length) return l
  const panes = [...l.panes]
  ;[panes[i], panes[j]] = [panes[j], panes[i]]
  return { ...l, panes }
}

export function removePane(l: IndLayout, id: string): IndLayout {
  return prunePanes({ ...l, list: l.list.filter((i) => i.pane !== id) })
}

export function setPane(l: IndLayout, id: string, patch: Partial<IndPane>): IndLayout {
  return { ...l, panes: l.panes.map((p) => (p.id === id ? { ...p, ...patch } : p)) }
}

// 模板：存当前整套（去掉 uid，窗格 id 原样）/ templates: the whole set without uids
export function templateOfLayout(l: IndLayout, name: string): IndTemplate {
  return { name: name.slice(0, 40), list: l.list.map(({ uid: _u, ...rest }) => rest), panes: l.panes.map((p) => ({ ...p })) }
}

export function applyTemplate(l: IndLayout, t: IndTemplate): IndLayout {
  const map = new Map(t.panes.map((p) => [p.id, `p${newUid()}`]))
  const panes = t.panes.map((p) => ({ ...p, id: map.get(p.id)! }))
  const list = t.list.map((i) => ({ ...i, uid: newUid(), pane: i.pane === 'main' ? 'main' : map.get(i.pane) ?? 'main' }))
  return prunePanes({ ...l, list, panes })
}

// 内置模板 / built-in templates
export const BUILTIN_TEMPLATES: { id: string; types: string[] }[] = [
  { id: 'ma', types: ['sma', 'ema', 'vol'] },
  { id: 'trend', types: ['ema', 'supertrend', 'atr'] },
  { id: 'osc', types: ['bb', 'rsi', 'macd'] },
  { id: 'vol', types: ['vwap', 'vol', 'obv'] },
  { id: 'ichimoku', types: ['ichimoku', 'dmi'] },
]

export function applyBuiltin(l: IndLayout, types: string[]): IndLayout {
  let cur: IndLayout = { ...l, list: [], panes: [] }
  for (const t of types) {
    const r = addInstance(cur, t)
    if (r) cur = r.layout
  }
  return { ...cur, recent: l.recent }
}
