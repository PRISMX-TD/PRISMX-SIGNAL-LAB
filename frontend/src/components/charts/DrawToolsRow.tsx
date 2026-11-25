// 画线工具：图标 + 两种排布。rail = 桌面图表左侧的竖轨；strip = 手机报价条第二行的单行横条。
// 2026-11-25（阶段 2）起工具按组排：每组一个按钮，显示该组上次用的工具，点小三角（或再点一次已选中的
// 按钮）弹出组内全部工具；列表里的星标把工具加进收藏栏。
// Draw tools: icons plus two layouts. rail = the desktop chart's left rail; strip = the phone's
// single-line bar. Since 2026-11-25 (phase 2) tools are grouped: one button per group showing the
// group's last-used tool; the corner chevron (or clicking the active button again) opens the whole
// group, and the star in that list adds a tool to the favourites bar.
import { Fragment, useRef, useState, type RefObject } from 'react'
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
    // 第二批 / batch 2
    case 'regression': return <svg {...S}><path d="M3 17L21 7" /><path d="M3 21L21 11M3 13L21 3" strokeDasharray="2 2.5" opacity="0.6" /></svg>
    case 'flatChannel': return <svg {...S}><path d="M3 18L21 6" /><path d="M3 20h18" /></svg>
    case 'disjointChannel': return <svg {...S}><path d="M3 14L21 4" /><path d="M3 10l18 10" /></svg>
    case 'pitchfork': return <svg {...S}><path d="M3 12h7" /><path d="M10 5v14" /><path d="M10 5h11M10 12h11M10 19h11" /></svg>
    case 'schiffPitchfork': return <svg {...S}><path d="M3 15l7-3" /><path d="M10 5v14" /><path d="M10 5l11-3M10 12l11-3M10 19l11-3" /></svg>
    case 'modSchiffPitchfork': return <svg {...S}><path d="M3 18l7-6" /><path d="M10 5v14" /><path d="M10 5l11-1M10 12l11-1M10 19l11-1" /></svg>
    case 'insidePitchfork': return <svg {...S}><path d="M3 12h4" /><path d="M7 8v8" /><path d="M7 8h14M7 12h14M7 16h14" /></svg>
    case 'pitchfan': return <svg {...S}><path d="M3 20L21 4M3 20l18-6M3 20l18 1M3 20L13 3" /></svg>
    case 'fibChannel': return <svg {...S}><path d="M3 12L21 4M3 16L21 8M3 20L21 12" /><path d="M3 8L21 0" opacity="0.5" /></svg>
    case 'fibTimeZone': return <svg {...S}><path d="M3 4v16M6 4v16M9 4v16M13 4v16M20 4v16" /></svg>
    case 'fibFan': return <svg {...S}><path d="M3 20L21 4M3 20l18-8M3 20l18-3M3 20L12 4" /><path d="M21 4v16" opacity="0.4" /></svg>
    case 'fibTime': return <svg {...S}><path d="M3 18l4-10 4 6" opacity="0.6" /><path d="M13 4v16M16 4v16M21 4v16" /></svg>
    case 'fibCircles': return <svg {...S}><circle cx="12" cy="12" r="3" /><circle cx="12" cy="12" r="6" /><circle cx="12" cy="12" r="9.5" /></svg>
    case 'fibArcs': return <svg {...S}><path d="M8 20a4 4 0 018 0M4 20a8 8 0 0116 0" /><path d="M2 21h20" opacity="0.5" /><path d="M12 20V6" opacity="0.6" /></svg>
    case 'gannFan': return <svg {...S}><path d="M3 21L21 3M3 21l18-9M3 21l18-3M3 21L12 3M3 21L7 3" /></svg>
    case 'gannBox': return <svg {...S}><rect x="3" y="3" width="18" height="18" rx="1" /><path d="M3 9h18M3 15h18M9 3v18M15 3v18" opacity="0.6" /><path d="M3 21L21 3" /></svg>
    case 'xabcd': return <svg {...S}><path d="M2 18l5-12 4 8 5-10 6 14" /><path d="M2 18l9-4M11 14l11 4" opacity="0.4" /></svg>
    case 'cypher': return <svg {...S}><path d="M2 16l5-10 4 6 6-8 5 14" /><path d="M2 16l15-12" opacity="0.4" /></svg>
    case 'abcd': return <svg {...S}><path d="M3 18L9 6l5 8 7-10" /><circle cx="3" cy="18" r="1.4" /><circle cx="21" cy="4" r="1.4" /></svg>
    case 'headShoulders': return <svg {...S}><path d="M2 18l4-8 3 5 3-11 3 11 3-5 4 8" /><path d="M2 15h20" strokeDasharray="2 2" opacity="0.6" /></svg>
    case 'trianglePattern': return <svg {...S}><path d="M3 4l5 16 5-12 5 8" /><path d="M3 4l19 10M8 20l14-6" opacity="0.5" /></svg>
    case 'threeDrives': return <svg {...S}><path d="M2 20l4-6 2 3 4-8 2 3 4-8 2 3" /></svg>
    case 'elliottImpulse': return <svg {...S}><path d="M2 20l4-8 3 4 5-12 3 6 5-6" /><text x="13" y="24" fontSize="7" fill="currentColor" stroke="none">5</text></svg>
    case 'elliottCorrection': return <svg {...S}><path d="M3 4l6 12 4-6 8 10" /><text x="15" y="9" fontSize="7" fill="currentColor" stroke="none">C</text></svg>
    case 'elliottTriangle': return <svg {...S}><path d="M2 4l4 16 3-12 3 9 3-6 3 4 4-3" /></svg>
    case 'elliottDouble': return <svg {...S}><path d="M3 4l6 12 4-6 8 10" /><text x="14" y="9" fontSize="7" fill="currentColor" stroke="none">Y</text></svg>
    case 'elliottTriple': return <svg {...S}><path d="M2 4l4 10 3-5 4 9 3-5 6 8" /><text x="14" y="8" fontSize="7" fill="currentColor" stroke="none">Z</text></svg>
    case 'cyclicLines': return <svg {...S}><path d="M4 3v18M10 3v18M16 3v18M22 3v18" /></svg>
    case 'timeCycles': return <svg {...S}><path d="M2 18a4 4 0 018 0 4 4 0 018 0" /><path d="M18 18a2 2 0 014 0" /><path d="M1 18h22" opacity="0.4" /></svg>
    case 'sineLine': return <svg {...S}><path d="M2 12c2.5-8 5.5-8 8 0s5.5 8 8 0 3-5 4-4" /></svg>
    case 'forecast': return <svg {...S}><path d="M4 18L18 6" /><circle cx="4" cy="18" r="2" /><circle cx="18" cy="6" r="2" /><path d="M14 4h7v4" opacity="0.6" /></svg>
    case 'highlighter': return <svg {...S}><path d="M4 17c3-1 4-6 7-6s3 5 6 5 3-6 5-8" strokeWidth="4" opacity="0.45" /></svg>
    case 'arrowMarker': return <svg {...S}><path d="M3 15l10-10 2 4 6-1-6 6 1 6-4-2-9 3z" fill="currentColor" fillOpacity="0.25" /></svg>
    case 'arrowUp': return <svg {...S}><path d="M12 3l6 7h-4v10h-4V10H6z" fill="currentColor" fillOpacity="0.25" /></svg>
    case 'arrowDown': return <svg {...S}><path d="M12 21l6-7h-4V4h-4v10H6z" fill="currentColor" fillOpacity="0.25" /></svg>
    case 'rotatedRect': return <svg {...S}><path d="M8 3l13 7-5 11L3 14z" /></svg>
    case 'path': return <svg {...S}><path d="M3 18l6-9 5 6 6-9" /><path d="M16 6h4v4" /></svg>
    case 'circle': return <svg {...S}><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="1.2" /></svg>
    case 'ellipse': return <svg {...S}><ellipse cx="12" cy="12" rx="9.5" ry="6" /></svg>
    case 'polyline': return <svg {...S}><path d="M3 18L8 6l6 8 7-9v14z" /></svg>
    case 'triangle': return <svg {...S}><path d="M12 4l9 16H3z" /></svg>
    case 'arc': return <svg {...S}><path d="M3 18C6 6 18 6 21 18z" /></svg>
    case 'curve': return <svg {...S}><path d="M3 18C6 6 18 6 21 18" /></svg>
    case 'doubleCurve': return <svg {...S}><path d="M2 14c3-9 7-9 10 0s7 9 10 0" /></svg>
    case 'sector': return <svg {...S}><path d="M5 19L5 5a14 14 0 0114 14z" /></svg>
    case 'anchoredText': return <svg {...S}><path d="M6 7V5h12v2M12 5v12M9 17h6" /><path d="M3 21h4M17 21h4" /></svg>
    case 'note': return <svg {...S}><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M8 9h8M8 12h8M8 15h5" /></svg>
    case 'priceNote': return <svg {...S}><circle cx="5" cy="19" r="1.8" /><path d="M6 18l6-7" /><rect x="11" y="5" width="11" height="6" rx="1" /></svg>
    case 'pin': return <svg {...S}><circle cx="12" cy="8" r="4.5" /><path d="M12 12.5V21" /></svg>
    case 'callout': return <svg {...S}><rect x="9" y="3" width="13" height="10" rx="1.5" /><path d="M12 13l-8 8 6-8" /></svg>
    case 'comment': return <svg {...S}><path d="M4 5h16v11H11l-5 4v-4H4z" /></svg>
    case 'signpost': return <svg {...S}><rect x="5" y="3" width="14" height="7" rx="1.5" /><path d="M12 10v11" /></svg>
    case 'flag': return <svg {...S}><path d="M6 21V4" /><path d="M6 4c4-2 7 2 12 0v8c-5 2-8-2-12 0" fill="currentColor" fillOpacity="0.25" /></svg>
    // 第三批 / batch 3
    case 'presenter': return <svg {...S}><path d="M4 20l7-7" opacity="0.5" /><circle cx="15" cy="9" r="3.5" fill="currentColor" fillOpacity="0.3" /><path d="M15 2.5v2M15 13.5v2M8.5 9h2M19.5 9h2" /></svg>
    case 'fibSpiral': return <svg {...S}><path d="M12 12a2 2 0 012 2 3.2 3.2 0 01-3.2 3.2A5.2 5.2 0 015.6 12 8.4 8.4 0 0114 3.6 13 13 0 0121 9" /></svg>
    case 'fibWedge': return <svg {...S}><path d="M4 20L20 8M4 20l14 1" /><path d="M10 15.5a7 7 0 01.6 5M14 12.5a11 11 0 011 8.5" /></svg>
    case 'gannSquareFixed': return <svg {...S}><rect x="3" y="3" width="18" height="18" rx="1" /><path d="M3 21L21 3M3 21L21 12M3 21L12 3" opacity="0.7" /><path d="M3 12a9 9 0 019 9" /></svg>
    case 'gannSquare': return <svg {...S}><rect x="3" y="5" width="18" height="14" rx="1" /><path d="M3 19L21 5M3 19L21 12M3 12h18M12 5v14" opacity="0.6" /></svg>
    case 'barsPattern': return <svg {...S}><path d="M5 6v10M9 4v12M13 8v8" opacity="0.5" /><rect x="15" y="10" width="2.5" height="6" fill="currentColor" fillOpacity="0.3" /><rect x="19" y="8" width="2.5" height="7" fill="currentColor" fillOpacity="0.3" /><path d="M16.25 8v10M20.25 6v11" /></svg>
    case 'ghostFeed': return <svg {...S}><path d="M3 18l6-8 5 5 7-9" strokeDasharray="2 2" opacity="0.6" /><rect x="5" y="11" width="2.5" height="5" /><rect x="11" y="10" width="2.5" height="4" /><rect x="17" y="6" width="2.5" height="5" /></svg>
    case 'anchoredVwap': return <svg {...S}><path d="M5 4v16" strokeDasharray="2 2" /><path d="M5 14c4-1 6-6 9-6s4 3 7 2" /><circle cx="5" cy="14" r="1.6" fill="currentColor" /></svg>
    case 'fixedRangeVP': return <svg {...S}><path d="M3 3v18M21 3v18" opacity="0.5" /><path d="M5 6h6M5 9h10M5 12h13M5 15h8M5 18h4" /></svg>
    case 'anchoredVP': return <svg {...S}><path d="M5 3v18" /><circle cx="5" cy="12" r="1.6" fill="currentColor" /><path d="M7 6h6M7 9h10M7 12h13M7 15h8M7 18h4" /></svg>
    case 'table': return <svg {...S}><rect x="3" y="5" width="18" height="14" rx="1.5" /><path d="M3 10h18M3 14.5h18M10 5v14" /></svg>
    case 'image': return <svg {...S}><rect x="3" y="5" width="18" height="14" rx="1.5" /><circle cx="8.5" cy="10" r="1.5" /><path d="M21 16l-5-5-8 8" /></svg>
    case 'emoji': return <svg {...S}><circle cx="12" cy="12" r="9" /><path d="M8 14c1 2 2.5 3 4 3s3-1 4-3" /><path d="M9 9.5h.01M15 9.5h.01" strokeWidth="2.6" /></svg>
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
              {g.tools.map((tl) => (<Fragment key={tl}>
                {g.secs?.[tl] &&<div className="chart-pop-sec">{String(t(`charts.draw.sec_${g.secs[tl]}`))}</div>}
                <div className={`chart-pop-row ${cur === tl ? 'on' : ''}`}>
                  <button type="button" className="chart-pop-item" onClick={() => pick(g.id, tl)}>
                    <DrawToolIcon tool={tl} /><span>{String(t(`charts.draw.${tl}`))}</span>{toolKeyHint(tl) && <small>{toolKeyHint(tl)}</small>}
                  </button>
                  <button type="button" className={`chart-pop-star ${favs.includes(tl) ? 'on' : ''}`} aria-pressed={favs.includes(tl)}
                    aria-label={String(t(favs.includes(tl) ? 'charts.draw.unfav' : 'charts.draw.fav'))}
                    onClick={() => { drawLayerRef.current?.toggleFavorite(tl); bumpDraw() }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill={favs.includes(tl) ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden><path d="M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9z" /></svg>
                  </button>
                </div>
              </Fragment>))}
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
