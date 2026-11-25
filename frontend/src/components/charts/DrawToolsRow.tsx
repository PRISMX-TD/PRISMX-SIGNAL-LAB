// 画线工具：图标 + 两种排布。rail = 桌面图表左侧的竖轨；strip = 手机报价条第二行的单行横条。
// 2026-11-25（阶段 2）起工具按组排：每组一个按钮，显示该组上次用的工具，点小三角（或再点一次已选中的
// 按钮）弹出组内全部工具；列表里的星标把工具加进收藏栏。
// Draw tools: icons plus two layouts. rail = the desktop chart's left rail; strip = the phone's
// single-line bar. Since 2026-11-25 (phase 2) tools are grouped: one button per group showing the
// group's last-used tool; the corner chevron (or clicking the active button again) opens the whole
// group, and the star in that list adds a tool to the favourites bar.
import { useRef, useState, type RefObject } from 'react'
import type { DrawLayerHandle } from './DrawLayer'
import { type Tool, TOOL_GROUPS, TOOL_HOTKEYS, COLORS } from './draw/model'
import ChartPopover from './ChartPopover'
import { usePrefs } from '../../store/prefs'
import { CHART_PREFS_NS } from './useChartPrefs'
import { useOverflowHint } from '../../utils/useOverflowHint'

const S = { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true }

export function DrawToolIcon({ tool }: { tool: Tool }) {
  switch (tool) {
    case 'cursor': return <svg {...S}><path d="M4 3l7 17 2.5-6.5L20 11 4 3z" /></svg>
    case 'cross': return <svg {...S}><line x1="12" y1="3" x2="12" y2="21" /><line x1="3" y1="12" x2="21" y2="12" /></svg>
    case 'trend': return <svg {...S}><path d="M4 20L20 4" /><circle cx="4" cy="20" r="1.8" /><circle cx="20" cy="4" r="1.8" /></svg>
    case 'ray': return <svg {...S}><line x1="6" y1="18" x2="22" y2="2" /><circle cx="6" cy="18" r="1.8" /></svg>
    case 'info': return <svg {...S}><path d="M4 20L16 8" /><circle cx="4" cy="20" r="1.6" /><circle cx="16" cy="8" r="1.6" /><rect x="14" y="2" width="8" height="5" rx="1" /></svg>
    case 'extended': return <svg {...S}><path d="M2 22L22 2" /><circle cx="8" cy="16" r="1.6" /><circle cx="16" cy="8" r="1.6" /></svg>
    case 'angle': return <svg {...S}><path d="M4 19L19 6" /><path d="M4 19h16" strokeDasharray="2 2" /><path d="M11 19a7 7 0 00-2-5" /></svg>
    case 'hline': return <svg {...S}><path d="M3 12h18" /><circle cx="12" cy="12" r="1.8" /></svg>
    case 'hray': return <svg {...S}><path d="M7 12h15" /><circle cx="6" cy="12" r="1.8" /></svg>
    case 'vline': return <svg {...S}><path d="M12 3v18" /><circle cx="12" cy="12" r="1.8" /></svg>
    case 'crossline': return <svg {...S}><path d="M3 12h18" /><path d="M12 3v18" /><circle cx="12" cy="12" r="1.8" /></svg>
    case 'channel': return <svg {...S}><path d="M3 15L15 3" /><path d="M9 21L21 9" /><path d="M6 18L18 6" strokeDasharray="2 2.5" opacity="0.6" /></svg>
    case 'fib': return <svg {...S}><path d="M3 5h18M3 10h18M3 14h18M3 19h18" /><path d="M4 19L20 5" opacity="0.5" /></svg>
    case 'fibExt': return <svg {...S}><path d="M10 5h11M10 10h11M10 15h11M10 20h11" /><path d="M3 18l4-10 3 6" opacity="0.6" /></svg>
    case 'long': return <svg {...S}><rect x="4" y="4" width="16" height="7" rx="1" fill="currentColor" fillOpacity="0.18" /><rect x="4" y="13" width="16" height="7" rx="1" /><path d="M8 9l4-3 4 3" /></svg>
    case 'short': return <svg {...S}><rect x="4" y="4" width="16" height="7" rx="1" /><rect x="4" y="13" width="16" height="7" rx="1" fill="currentColor" fillOpacity="0.18" /><path d="M8 15l4 3 4-3" /></svg>
    case 'priceRange': return <svg {...S}><path d="M5 4h14M5 20h14" /><path d="M12 6v12M9 9l3-3 3 3M9 15l3 3 3-3" /></svg>
    case 'dateRange': return <svg {...S}><path d="M4 5v14M20 5v14" /><path d="M6 12h12M9 9l-3 3 3 3M15 9l3 3-3 3" /></svg>
    case 'datePriceRange': return <svg {...S}><rect x="4" y="4" width="16" height="16" rx="1" /><path d="M8 16L16 8M12 8h4v4" /></svg>
    case 'brush': return <svg {...S}><path d="M3 17c3-1 4-6 7-6s3 5 6 5 3-6 5-8" /></svg>
    case 'arrow': return <svg {...S}><path d="M4 20L19 5" /><path d="M11 5h8v8" /></svg>
    case 'rect': return <svg {...S}><rect x="4" y="6" width="16" height="12" rx="1" /></svg>
    case 'text': return <svg {...S}><path d="M5 6V4h14v2M12 4v16M9 20h6" /></svg>
    case 'priceLabel': return <svg {...S}><path d="M4 8a2 2 0 012-2h12a2 2 0 012 2v6a2 2 0 01-2 2h-8l-4 4v-4a2 2 0 01-2-2z" /><path d="M8 11h8" /></svg>
  }
}

// 快捷键提示文字 / shortcut hint text
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
const ALT = isMac ? '⌥' : 'Alt+'
export function toolKeyHint(tl: Tool): string {
  const k = TOOL_HOTKEYS[tl]
  if (!k) return ''
  return `${ALT}${k.shift ? '⇧' : ''}${k.code.replace('Key', '')}`
}

const CHEVRON = <svg width="6" height="6" viewBox="0 0 6 6" aria-hidden><path d="M6 0v6H0z" fill="currentColor" /></svg>

// 分组按钮（竖轨、手机横条、全屏悬浮栏共用）/ group buttons (rail, phone strip, fullscreen bar)
export function DrawToolGroups({ drawLayerRef, bumpDraw, t, compact = false }: {
  drawLayerRef: RefObject<DrawLayerHandle>
  bumpDraw: () => void
  t: (key: string) => unknown
  compact?: boolean
}) {
  const { getPref, setPref } = usePrefs()
  const last = getPref<Record<string, Tool>>(CHART_PREFS_NS, 'drawGroupLast', {}) || {}
  const [open, setOpen] = useState<string | null>(null)
  const refs = useRef<Record<string, HTMLButtonElement | null>>({})
  const dl = drawLayerRef.current
  const cur = dl?.tool ?? 'cursor'
  const favs = dl?.favorites ?? []
  const pick = (gid: string, tl: Tool) => {
    drawLayerRef.current?.setTool(tl)
    if (last[gid] !== tl) setPref(CHART_PREFS_NS, 'drawGroupLast', { ...last, [gid]: tl })
    setOpen(null)
    bumpDraw()
  }
  return (
    <>
      {TOOL_GROUPS.map((g) => {
        const active = g.tools.includes(cur)
        const shown: Tool = active ? cur : (last[g.id] && g.tools.includes(last[g.id]) ? last[g.id] : g.tools[0])
        const hint = toolKeyHint(shown)
        return (
          <span key={g.id} className={`term-tool-grp ${compact ? 'compact' : ''}`}>
            <button
              ref={(el) => { refs.current[g.id] = el }}
              type="button"
              title={`${String(t(`charts.draw.${shown}`))}${hint ? ` (${hint})` : ''}`}
              aria-label={String(t(`charts.draw.${shown}`))}
              aria-pressed={active}
              aria-haspopup="dialog"
              onClick={() => { if (active && cur === shown) setOpen(open === g.id ? null : g.id); else pick(g.id, shown) }}
              className={`term-tool-btn ${active ? 'on' : ''}`}
            >
              <DrawToolIcon tool={shown} />
            </button>
            <button type="button" className="term-tool-more" aria-label={String(t(`charts.draw.grp_${g.id}`))} title={String(t(`charts.draw.grp_${g.id}`))} onClick={() => setOpen(open === g.id ? null : g.id)}>{CHEVRON}</button>
            <ChartPopover open={open === g.id} onClose={() => setOpen(null)} anchorRef={{ current: refs.current[g.id] }} width={248} label={String(t(`charts.draw.grp_${g.id}`))}>
              <div className="chart-iv-grp">
                <b>{String(t(`charts.draw.grp_${g.id}`))}</b>
              </div>
              {g.tools.map((tl) => (
                <div key={tl} className={`chart-pop-row ${cur === tl ? 'on' : ''}`}>
                  <button type="button" className="chart-pop-item" onClick={() => pick(g.id, tl)}>
                    <DrawToolIcon tool={tl} /><span>{String(t(`charts.draw.${tl}`))}</span>{toolKeyHint(tl) && <small>{toolKeyHint(tl)}</small>}
                  </button>
                  <button type="button" className={`chart-pop-star ${favs.includes(tl) ? 'on' : ''}`} aria-pressed={favs.includes(tl)}
                    aria-label={String(t(favs.includes(tl) ? 'charts.draw.unfav' : 'charts.draw.fav'))}
                    onClick={() => { drawLayerRef.current?.toggleFavorite(tl); bumpDraw() }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill={favs.includes(tl) ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden><path d="M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9z" /></svg>
                  </button>
                </div>
              ))}
            </ChartPopover>
          </span>
        )
      })}
    </>
  )
}

export default function DrawToolsRow({
  drawLayerRef,
  bumpDraw,
  t,
  variant = 'rail',
  measureOn,
  onMeasure,
}: {
  drawLayerRef: RefObject<DrawLayerHandle>
  bumpDraw: () => void
  t: (key: string) => unknown
  variant?: 'rail' | 'strip'
  // 测量（尺子）按钮：只有传了才显示 / the ruler button shows only when these are passed
  measureOn?: boolean
  onMeasure?: () => void
}) {
  const rail = variant === 'rail'
  const Divider = () => (rail ? <hr /> : <span className="term-toolbar-divider" />)
  const dl = drawLayerRef.current
  // 画线层挂上之前 ref 还是空的，此时按「可见」画 / before the layer mounts, treat drawings as visible
  const visible = dl?.visible ?? true
  const magnet = dl?.magnet ?? 'off'
  const allLocked = (dl?.drawCount ?? 0) > 0 && dl?.lockedCount === dl?.drawCount
  const hintRef = useOverflowHint<HTMLDivElement>()

  return (
    <div ref={rail ? undefined : hintRef} className={rail ? 'term-rail no-sb' : 'term-tools-strip no-sb'} role="group" aria-label={String(t('charts.draw.tools'))}>
      <DrawToolGroups drawLayerRef={drawLayerRef} bumpDraw={bumpDraw} t={t} />
      {onMeasure && (
        <button
          type="button"
          title={`${String(t('charts.measure.title'))} (Shift+🖱)`}
          aria-label={String(t('charts.measure.title'))}
          aria-pressed={!!measureOn}
          onClick={onMeasure}
          className={`term-tool-btn ${measureOn ? 'on' : ''}`}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M3 17L17 3l4 4L7 21z" /><path d="M7 13l2 2M10 10l2 2M13 7l2 2" /></svg>
        </button>
      )}
      <Divider />
      {COLORS.map((c) => (
        <button
          key={c}
          type="button"
          title={String(t('charts.draw.color'))}
          aria-label={String(t('charts.draw.color'))}
          onClick={() => { drawLayerRef.current?.applyColor(c); bumpDraw() }}
          className={`term-color-dot ${dl?.color === c ? 'on' : ''}`}
          style={{ background: c }}
        />
      ))}
      <Divider />
      <button
        type="button"
        title={String(t(`charts.draw.magnet_${magnet}`))}
        aria-label={String(t(`charts.draw.magnet_${magnet}`))}
        aria-pressed={magnet !== 'off'}
        onClick={() => { drawLayerRef.current?.setMagnet(magnet === 'off' ? 'weak' : magnet === 'weak' ? 'strong' : 'off'); bumpDraw() }}
        className={`term-tool-btn ${magnet !== 'off' ? 'on' : ''}`}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={magnet === 'strong' ? 2.4 : 1.8} strokeLinecap="round" strokeLinejoin="round"><path d="M6 3v8a6 6 0 0012 0V3" /><path d="M6 7h4M14 7h4" /><path d="M10 3v8a2 2 0 004 0V3" /></svg>
      </button>
      <button
        type="button"
        title={String(t('charts.draw.stayInDraw'))}
        aria-label={String(t('charts.draw.stayInDraw'))}
        aria-pressed={!!dl?.stayInDraw}
        onClick={() => { drawLayerRef.current?.setStayInDraw(!drawLayerRef.current?.stayInDraw); bumpDraw() }}
        className={`term-tool-btn ${dl?.stayInDraw ? 'on' : ''}`}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 20l4-1L19 8l-3-3L5 16z" /><path d="M14 20h6" /></svg>
      </button>
      <button
        type="button"
        title={String(allLocked ? t('charts.draw.unlockAll') : t('charts.draw.lockAll'))}
        aria-label={String(allLocked ? t('charts.draw.unlockAll') : t('charts.draw.lockAll'))}
        aria-pressed={allLocked}
        disabled={(dl?.drawCount ?? 0) === 0}
        onClick={() => { if (allLocked) drawLayerRef.current?.unlockAll(); else drawLayerRef.current?.lockAll(); bumpDraw() }}
        className={`term-tool-btn warn ${allLocked ? 'on' : ''}`}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="11" width="16" height="10" rx="2" />{allLocked ? <path d="M8 11V7a4 4 0 018 0v4" /> : <path d="M8 11V7a4 4 0 017.8-1.2" />}</svg>
      </button>
      <button
        type="button"
        title={String(visible ? t('charts.draw.hideAll') : t('charts.draw.showAll'))}
        aria-label={String(visible ? t('charts.draw.hideAll') : t('charts.draw.showAll'))}
        onClick={() => { drawLayerRef.current?.setVisible(!drawLayerRef.current?.visible); bumpDraw() }}
        className={`term-tool-btn warn ${!visible ? 'on' : ''}`}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{visible ? <><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></> : <><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24" /><line x1="1" y1="1" x2="23" y2="23" /></>}</svg>
      </button>
      <button
        type="button"
        title={String(t('charts.draw.objectTree'))}
        aria-label={String(t('charts.draw.objectTree'))}
        aria-pressed={!!dl?.treeOpen}
        onClick={() => { drawLayerRef.current?.toggleTree(); bumpDraw() }}
        className={`term-tool-btn ${dl?.treeOpen ? 'on' : ''}`}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 5h6M4 12h6M4 19h6" /><path d="M14 5h6M14 12h6M14 19h6" opacity="0.55" /></svg>
      </button>
      <button
        type="button"
        title={String(t('charts.draw.clear'))}
        aria-label={String(t('charts.draw.clear'))}
        onClick={() => { drawLayerRef.current?.clearAll(); bumpDraw() }}
        disabled={(dl?.drawCount ?? 0) === 0}
        className="term-tool-btn"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></svg>
      </button>
    </div>
  )
}
