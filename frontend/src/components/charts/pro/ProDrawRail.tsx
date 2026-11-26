// 专业版终端的左侧画线栏，排布与操作照 TradingView 的左工具栏：
//   光标 · 趋势线工具（线 + 通道 + 音叉）· 斐波那契与江恩 · 形态 · 预测与测量（仓位、预测、成交量、
//   测量）· 几何形状 · 文字标注 · 图标 ┊ 测量尺 · 区域放大（缩小只在放大过后出现）┊ 磁吸 · 连续绘制 ·
//   锁定全部 · 隐藏 ┊ 删除 …… 对象树。
// 操作：每组一个按钮，显示该组上次用的工具，点一下就拿起它；鼠标移上去右边出现小箭头，点箭头向右弹出
// 整组工具（分小节、带快捷键，星标加进收藏栏）。磁吸、隐藏、删除也是「主按钮 + 箭头菜单」：
// 磁吸主按钮开关上次选的强度；隐藏主按钮切换上次选的那一项（画线 / 指标 / 持仓与订单 / 全部）；
// 删除主按钮删画线，菜单里还能删指标或两样都删。
// 与经典版竖轨的差别：没有颜色圆点（颜色在选中画线的浮动工具条里改），图标更大更细。
// 图标都是本项目自己画的线条图标，只是表达同样的工具。
// The pro terminal's left draw bar, laid out and operated like TradingView's left toolbar:
//   cursors · trend line tools (lines + channels + pitchforks) · Fibonacci & Gann · patterns ·
//   prediction & measurement (positions, forecast, volume, measurers) · shapes · annotations ·
//   icons ┊ ruler · zoom-in area (zoom-out appears after a zoom) ┊ magnet · stay in drawing mode ·
//   lock all · hide ┊ remove …… object tree.
// One button per group showing the group's last-used tool (a click arms it); on hover a small
// arrow appears on its right, which opens the whole group to the right (sections, hotkeys, a
// star for the favourites bar). Magnet, hide and remove are "main button + arrow menu" too.
// Unlike the classic rail there are no colour dots (colour lives in the selected drawing's
// floating toolbar) and the icons are larger and thinner. All icons are the project's own.
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { DrawLayerHandle } from '../DrawLayer'
import { TOOL_GROUPS, type Tool } from '../draw/model'
import { DrawToolIcon, toolKeyHint } from '../DrawToolsRow'
import { IcRuler as Ruler, IcZoom as Zoom, IcMagnet as Magnet, IcStay as Stay, IcLock as Lock, IcEye as Eye, IcTrash as Trash, IcTree as Tree } from '../draw/railIcons'
import { usePrefs } from '../../../store/prefs'
import { CHART_PREFS_NS } from '../useChartPrefs'
import ConfirmModal from '../../ConfirmModal'

type HideMode = 'drawings' | 'indicators' | 'positions' | 'all'
type RemoveMode = 'drawings' | 'indicators' | 'all'

interface Props {
  drawLayerRef: RefObject<DrawLayerHandle>
  bumpDraw: () => void
  t: (key: string, o?: Record<string, unknown>) => unknown
  measureOn: boolean
  onMeasure: () => void
  zoomOn: boolean
  onZoom: () => void
  canZoomOut: boolean
  onZoomOut: () => void
  indCount: number
  indHidden: boolean
  onHideIndicators: (hide: boolean) => void
  positionsShown: boolean
  onShowPositions: (show: boolean) => void
  onRemoveIndicators: () => void
}

interface Group { id: string; tools: Tool[]; secs?: Partial<Record<Tool, string>> }
const byId = (id: string) => TOOL_GROUPS.find((g) => g.id === id)!
// TradingView 的分组：线、通道、音叉合成「趋势线工具」；预测、成交量、测量合成一组；表情单独成「图标」
// TradingView's grouping: lines + channels + pitchforks are "trend line tools"; projection,
// volume and measurers form one group; emoji gets its own "icons" button
const GROUPS: Group[] = [
  byId('cursors'),
  { id: 'lines', tools: [...byId('lines').tools, ...byId('channels').tools], secs: { trend: 'lines', ...byId('channels').secs } },
  byId('fibs'),
  byId('patterns'),
  { id: 'projection', tools: [...byId('projection').tools, ...byId('measurers').tools], secs: { ...byId('projection').secs, priceRange: 'measurers' } },
  byId('shapes'),
  { id: 'texts', tools: byId('texts').tools.filter((x) => x !== 'emoji') },
  { id: 'icons', tools: ['emoji'] },
]

const ICON = 26

export default function ProDrawRail(p: Props) {
  const { drawLayerRef, bumpDraw, t } = p
  const tt = (k: string, o?: Record<string, unknown>) => String(t(k, o))
  const { getPref, setPref } = usePrefs()
  const last = getPref<Record<string, string>>(CHART_PREFS_NS, 'drawGroupLast', {}) || {}
  const [open, setOpen] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<RemoveMode | null>(null)
  const refs = useRef<Record<string, HTMLElement | null>>({})
  const dl = drawLayerRef.current
  const cur = dl?.tool ?? 'cursor'
  const favs = dl?.favorites ?? []
  const drawCount = dl?.drawCount ?? 0
  const visible = dl?.visible ?? true
  const magnet = dl?.magnet ?? 'off'
  const allLocked = drawCount > 0 && dl?.lockedCount === drawCount
  const magnetPick = (last.magnet === 'strong' ? 'strong' : 'weak') as 'weak' | 'strong'
  const hideMode = (['drawings', 'indicators', 'positions', 'all'].includes(last.hide) ? last.hide : 'drawings') as HideMode

  const remember = (k: string, v: string) => { if (last[k] !== v) setPref(CHART_PREFS_NS, 'drawGroupLast', { ...last, [k]: v }) }
  const toggle = (id: string) => setOpen((o) => (o === id ? null : id))
  const pick = (gid: string, tl: Tool) => {
    drawLayerRef.current?.setTool(tl)
    remember(gid, tl)
    setOpen(null)
    bumpDraw()
  }

  // 隐藏：各项当前是否已隐藏 / hide: whether each item is hidden right now
  const hidden: Record<HideMode, boolean> = {
    drawings: !visible,
    indicators: p.indCount > 0 && p.indHidden,
    positions: !p.positionsShown,
    all: !visible && (p.indCount === 0 || p.indHidden) && !p.positionsShown,
  }
  const setHidden = (m: HideMode, hide: boolean) => {
    if (m === 'drawings' || m === 'all') drawLayerRef.current?.setVisible(!hide)
    if ((m === 'indicators' || m === 'all') && p.indCount > 0) p.onHideIndicators(hide)
    if (m === 'positions' || m === 'all') p.onShowPositions(!hide)
    bumpDraw()
  }
  const doRemove = (m: RemoveMode) => {
    setConfirm(null)
    if (m === 'drawings' || m === 'all') drawLayerRef.current?.clearAll(true)
    if (m === 'indicators' || m === 'all') p.onRemoveIndicators()
    bumpDraw()
  }
  const canRemove: Record<RemoveMode, boolean> = { drawings: drawCount > 0, indicators: p.indCount > 0, all: drawCount > 0 || p.indCount > 0 }
  const secLabel = (s: string) => (s === 'lines' ? tt('charts.pro.rail.secLines') : s === 'measurers' ? tt('charts.draw.grp_measurers') : tt(`charts.draw.sec_${s}`))
  const grpLabel = (id: string) => (id === 'projection' ? tt('charts.pro.rail.grpProjection') : id === 'icons' ? tt('charts.pro.rail.grpIcons') : tt(`charts.draw.grp_${id}`))

  return (
    <div className="term-rail ptr no-sb" role="toolbar" aria-orientation="vertical" aria-label={tt('charts.draw.tools')}>
      {GROUPS.map((g) => {
        const active = g.tools.includes(cur)
        const lastTool = last[g.id] as Tool | undefined
        const shown: Tool = active ? cur : (lastTool && g.tools.includes(lastTool) ? lastTool : g.tools[0])
        const hint = toolKeyHint(shown)
        const multi = g.tools.length > 1
        return (
          <div key={g.id} ref={(el) => { refs.current[g.id] = el }} className={`ptr-grp ${open === g.id ? 'open' : ''}`}>
            <button
              type="button"
              className={`ptr-btn ${active ? 'on' : ''}`}
              onClick={() => pick(g.id, shown)}
              aria-pressed={active}
              title={`${tt(`charts.draw.${shown}`)}${hint ? ` (${hint})` : ''}`}
              aria-label={tt(`charts.draw.${shown}`)}
            >
              <DrawToolIcon tool={shown} size={ICON} />
            </button>
            {multi && <Arrow label={grpLabel(g.id)} open={open === g.id} onClick={() => toggle(g.id)} />}
            {multi && (
              <Flyout open={open === g.id} anchor={refs.current[g.id]} onClose={() => setOpen(null)} label={grpLabel(g.id)}>
                {g.tools.map((tl, i) => (
                  <Fragment key={tl}>
                    {g.secs?.[tl] && <p className={`ptr-sec ${i === 0 ? 'first' : ''}`}>{secLabel(g.secs[tl]!)}</p>}
                    <div className={`ptr-row ${cur === tl ? 'on' : ''}`}>
                      <button type="button" className="ptr-item" onClick={() => pick(g.id, tl)}>
                        <span className="ptr-ic"><DrawToolIcon tool={tl} size={ICON} /></span>
                        <span className="ptr-name">{tt(`charts.draw.${tl}`)}</span>
                        {toolKeyHint(tl) && <kbd>{toolKeyHint(tl)}</kbd>}
                      </button>
                      <button
                        type="button"
                        className={`ptr-star ${favs.includes(tl) ? 'on' : ''}`}
                        aria-pressed={favs.includes(tl)}
                        aria-label={tt(favs.includes(tl) ? 'charts.draw.unfav' : 'charts.draw.fav')}
                        title={tt(favs.includes(tl) ? 'charts.draw.unfav' : 'charts.draw.fav')}
                        onClick={() => { drawLayerRef.current?.toggleFavorite(tl); bumpDraw() }}
                      >
                        <IcStar filled={favs.includes(tl)} />
                      </button>
                    </div>
                  </Fragment>
                ))}
              </Flyout>
            )}
          </div>
        )
      })}

      <hr />
      <div className="ptr-grp">
        <button type="button" className={`ptr-btn ${p.measureOn ? 'on' : ''}`} onClick={p.onMeasure} aria-pressed={p.measureOn} title={`${tt('charts.measure.title')} (Shift + 🖱)`} aria-label={tt('charts.measure.title')}>
          <IcRuler />
        </button>
      </div>
      <div className="ptr-grp">
        <button type="button" className={`ptr-btn ${p.zoomOn ? 'on' : ''}`} onClick={p.onZoom} aria-pressed={p.zoomOn} title={tt('charts.pro.rail.zoomInTip')} aria-label={tt('charts.pro.rail.zoomIn')}>
          <IcZoom plus />
        </button>
      </div>
      {p.canZoomOut && (
        <div className="ptr-grp">
          <button type="button" className="ptr-btn" onClick={p.onZoomOut} title={tt('charts.pro.rail.zoomOut')} aria-label={tt('charts.pro.rail.zoomOut')}>
            <IcZoom />
          </button>
        </div>
      )}

      <hr />
      <div ref={(el) => { refs.current.magnet = el }} className={`ptr-grp ${open === 'magnet' ? 'open' : ''}`}>
        <button
          type="button"
          className={`ptr-btn ${magnet !== 'off' ? 'on' : ''}`}
          onClick={() => { drawLayerRef.current?.setMagnet(magnet === 'off' ? magnetPick : 'off'); bumpDraw() }}
          aria-pressed={magnet !== 'off'}
          title={tt(`charts.draw.magnet_${magnet}`)}
          aria-label={tt('charts.draw.magnet')}
        >
          <IcMagnet strong={magnet === 'strong' || (magnet === 'off' && magnetPick === 'strong')} />
        </button>
        <Arrow label={tt('charts.draw.magnet')} open={open === 'magnet'} onClick={() => toggle('magnet')} />
        <Flyout open={open === 'magnet'} anchor={refs.current.magnet} onClose={() => setOpen(null)} label={tt('charts.draw.magnet')}>
          {(['weak', 'strong'] as const).map((m) => (
            <div key={m} className={`ptr-row ${magnet === m ? 'on' : ''}`}>
              <button type="button" className="ptr-item" onClick={() => { drawLayerRef.current?.setMagnet(m); remember('magnet', m); setOpen(null); bumpDraw() }}>
                <span className="ptr-ic"><IcMagnet strong={m === 'strong'} /></span>
                <span className="ptr-name">{tt(`charts.pro.rail.magnet_${m}`)}</span>
              </button>
            </div>
          ))}
        </Flyout>
      </div>
      <div className="ptr-grp">
        <button type="button" className={`ptr-btn ${dl?.stayInDraw ? 'on' : ''}`} onClick={() => { drawLayerRef.current?.setStayInDraw(!drawLayerRef.current?.stayInDraw); bumpDraw() }} aria-pressed={!!dl?.stayInDraw} title={tt('charts.draw.stayInDraw')} aria-label={tt('charts.draw.stayInDraw')}>
          <IcStay />
        </button>
      </div>
      <div className="ptr-grp">
        <button
          type="button"
          className={`ptr-btn ${allLocked ? 'on' : ''}`}
          disabled={drawCount === 0}
          onClick={() => { if (allLocked) drawLayerRef.current?.unlockAll(); else drawLayerRef.current?.lockAll(); bumpDraw() }}
          aria-pressed={allLocked}
          title={tt(allLocked ? 'charts.draw.unlockAll' : 'charts.draw.lockAll')}
          aria-label={tt(allLocked ? 'charts.draw.unlockAll' : 'charts.draw.lockAll')}
        >
          <IcLock locked={allLocked} />
        </button>
      </div>
      <div ref={(el) => { refs.current.hide = el }} className={`ptr-grp ${open === 'hide' ? 'open' : ''}`}>
        <button
          type="button"
          className={`ptr-btn ${hidden[hideMode] ? 'on' : ''}`}
          onClick={() => setHidden(hideMode, !hidden[hideMode])}
          aria-pressed={hidden[hideMode]}
          title={tt(`charts.pro.rail.hide_${hideMode}`)}
          aria-label={tt(`charts.pro.rail.hide_${hideMode}`)}
        >
          <IcEye off={hidden[hideMode]} />
        </button>
        <Arrow label={tt('charts.draw.hide')} open={open === 'hide'} onClick={() => toggle('hide')} />
        <Flyout open={open === 'hide'} anchor={refs.current.hide} onClose={() => setOpen(null)} label={tt('charts.draw.hide')}>
          {(['drawings', 'indicators', 'positions', 'all'] as const).map((m) => (
            <div key={m} className={`ptr-row ${hidden[m] ? 'on' : ''}`}>
              <button type="button" className="ptr-item" onClick={() => { setHidden(m, !hidden[m]); remember('hide', m); setOpen(null) }} aria-pressed={hidden[m]}>
                <span className="ptr-ic"><IcEye off={hidden[m]} /></span>
                <span className="ptr-name">{tt(`charts.pro.rail.hide_${m}`)}</span>
                {hidden[m] && <IcCheck />}
              </button>
            </div>
          ))}
        </Flyout>
      </div>

      <hr />
      <div ref={(el) => { refs.current.remove = el }} className={`ptr-grp ${open === 'remove' ? 'open' : ''}`}>
        <button type="button" className="ptr-btn" disabled={drawCount === 0} onClick={() => setConfirm('drawings')} title={tt('charts.pro.rail.remove_drawings')} aria-label={tt('charts.pro.rail.remove_drawings')}>
          <IcTrash />
        </button>
        <Arrow label={tt('charts.pro.rail.remove')} open={open === 'remove'} onClick={() => toggle('remove')} />
        <Flyout open={open === 'remove'} anchor={refs.current.remove} onClose={() => setOpen(null)} label={tt('charts.pro.rail.remove')}>
          {(['drawings', 'indicators', 'all'] as const).map((m) => (
            <div key={m} className="ptr-row">
              <button type="button" className="ptr-item" disabled={!canRemove[m]} onClick={() => { setOpen(null); setConfirm(m) }}>
                <span className="ptr-ic"><IcTrash /></span>
                <span className="ptr-name">{tt(`charts.pro.rail.remove_${m}`)}</span>
                <small>{m === 'drawings' ? drawCount : m === 'indicators' ? p.indCount : drawCount + p.indCount}</small>
              </button>
            </div>
          ))}
        </Flyout>
      </div>

      <span className="ptr-gap" />
      <div className="ptr-grp">
        <button type="button" className={`ptr-btn ${dl?.treeOpen ? 'on' : ''}`} onClick={() => { drawLayerRef.current?.toggleTree(); bumpDraw() }} aria-pressed={!!dl?.treeOpen} title={tt('charts.draw.objectTree')} aria-label={tt('charts.draw.objectTree')}>
          <IcTree />
        </button>
      </div>

      {confirm && (
        <ConfirmModal
          title={tt(`charts.pro.rail.remove_${confirm}`)}
          message={tt(`charts.pro.rail.removeConfirm_${confirm}`, { d: drawCount, n: p.indCount })}
          confirmLabel={tt('charts.pro.rail.remove')}
          danger
          center
          onConfirm={() => doRemove(confirm)}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  )
}

// 鼠标移上去才出现的小箭头（TradingView 同款位置：按钮右缘）/ the hover arrow on the button's right edge
function Arrow({ label, open, onClick }: { label: string; open: boolean; onClick: () => void }) {
  return (
    <button type="button" className="ptr-arrow" onClick={onClick} aria-label={label} aria-haspopup="menu" aria-expanded={open} title={label}>
      <svg width="6" height="10" viewBox="0 0 6 10" aria-hidden><path d="M1 1l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </button>
  )
}

// 向右弹出的菜单：贴着按钮右侧、与按钮顶边对齐，放不下就往上挪；点外面 / Esc 关
// The flyout opens to the right, top-aligned with the button, nudged up when it doesn't fit;
// an outside click or Escape closes it
function Flyout({ open, anchor, onClose, label, children }: { open: boolean; anchor: HTMLElement | null; onClose: () => void; label: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ top: -9999, left: -9999, maxH: 0 })
  useLayoutEffect(() => {
    if (!open || !anchor) return
    const r = anchor.getBoundingClientRect()
    const rail = anchor.closest('.ptr')?.getBoundingClientRect()
    const h = ref.current?.offsetHeight ?? 0
    const maxH = window.innerHeight - 16
    const top = Math.max(8, Math.min(r.top, window.innerHeight - 8 - Math.min(h, maxH)))
    setPos({ top, left: (rail?.right ?? r.right) + 4, maxH })
  }, [open, anchor])
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const n = e.target as Node
      if (ref.current?.contains(n) || anchor?.contains(n)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey, true) }
  }, [open, anchor, onClose])
  if (!open) return null
  return createPortal(
    <div ref={ref} className="ptr-fly no-sb" role="menu" aria-label={label} style={{ top: pos.top, left: pos.left, maxHeight: pos.maxH }}>
      {children}
    </div>,
    document.body,
  )
}

// ── 工具栏自己的图标在 draw/railIcons（与画线图标同一套 28 格细线）/ the bar's own icons live in draw/railIcons ──
const IcRuler = () => <Ruler size={ICON} />
const IcZoom = ({ plus = false }: { plus?: boolean }) => <Zoom size={ICON} plus={plus} />
const IcMagnet = ({ strong }: { strong: boolean }) => <Magnet size={ICON} strong={strong} />
const IcStay = () => <Stay size={ICON} />
const IcLock = ({ locked }: { locked: boolean }) => <Lock size={ICON} locked={locked} />
const IcEye = ({ off }: { off: boolean }) => <Eye size={ICON} off={off} />
const IcTrash = () => <Trash size={ICON} />
const IcTree = () => <Tree size={ICON} />
const IcCheck = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="ptr-check" aria-hidden><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
const IcStar = ({ filled }: { filled: boolean }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden>
    <path d="M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9z" />
  </svg>
)
