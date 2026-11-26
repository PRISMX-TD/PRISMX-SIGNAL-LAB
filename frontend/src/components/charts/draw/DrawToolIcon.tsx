// 画线工具图标（2026-11-26 重画）：28 格、细线、端点是空心小圆圈（线在圆圈外断开），观感对齐
// TradingView 的左工具栏；每个图标都是本项目自己画的线条，不用对方的素材。
// Draw tool icons (redrawn 2026-11-26): a 28 grid, thin strokes, hollow anchor circles with lines
// broken around them, matching the look of TradingView's left toolbar. Every glyph is drawn here,
// none are taken from TradingView.
import type { ReactNode } from 'react'
import type { Tool } from './model'

type Pt = [number, number]
// 端点圆圈半径 / 线断开的距离 / anchor radius and the gap lines leave around it
const R = 1.75
const GAP = R + 1.1

// 一段线，两端各缩进 a / b / one segment, trimmed by a at the start and b at the end
function sg(x1: number, y1: number, x2: number, y2: number, a = 0, b = 0): string {
  const len = Math.hypot(x2 - x1, y2 - y1) || 1
  const ux = (x2 - x1) / len, uy = (y2 - y1) / len
  const f = (v: number) => Math.round(v * 100) / 100
  return `M${f(x1 + ux * a)} ${f(y1 + uy * a)}L${f(x2 - ux * b)} ${f(y2 - uy * b)}`
}

const A = ({ p }: { p: Pt }) => <circle cx={p[0]} cy={p[1]} r={R} />

// 直线，at 里的位置（0–1）放端点圆圈，线在圆圈处断开 / a line with anchors at the given 0–1 positions
function L({ a, b, at = [], dash }: { a: Pt; b: Pt; at?: number[]; dash?: boolean }) {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
  const g = GAP / len
  const cuts = [...at].sort((x, y) => x - y)
  const parts: string[] = []
  let s = 0
  for (const c of cuts) {
    const e = c - g
    if (e > s + 0.001) parts.push(sg(a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, a[0] + (b[0] - a[0]) * e, a[1] + (b[1] - a[1]) * e))
    s = c + g
  }
  if (s < 0.999) parts.push(sg(a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, b[0], b[1]))
  return (
    <>
      <path d={parts.join('')} strokeDasharray={dash ? '1.6 2' : undefined} />
      {cuts.map((c, i) => <A key={i} p={[a[0] + (b[0] - a[0]) * c, a[1] + (b[1] - a[1]) * c]} />)}
    </>
  )
}

// 折线，每个拐点一个圆圈 / a polyline with an anchor at every vertex
function Z({ p, close, anchors = true }: { p: Pt[]; close?: boolean; anchors?: boolean }) {
  const pts = close ? [...p, p[0]] : p
  const g = anchors ? GAP : 0
  let d = ''
  for (let i = 0; i + 1 < pts.length; i++) d += sg(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], g, g)
  return <><path d={d} />{anchors && p.map((q, i) => <A key={i} p={q} />)}</>
}

// 从一个端点放射出去的几条线 / rays fanning out from one anchor
function Fan({ o, to }: { o: Pt; to: Pt[] }) {
  return <><path d={to.map((t) => sg(o[0], o[1], t[0], t[1], GAP)).join('')} /><A p={o} /></>
}

const TXT = { fill: 'currentColor', stroke: 'none', fontSize: 7.5, fontWeight: 600, fontFamily: 'inherit', textAnchor: 'middle' as const }

const BASE = { width: 18, height: 18, viewBox: '0 0 28 28', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true }

function glyph(tool: Tool): ReactNode {
  switch (tool) {
    case 'cursor': return <path d="M9 5.5v15.6l3.8-3.6 2.7 5.8 2.4-1.1-2.7-5.7 5.3-.3z" />
    case 'cross': return <path d="M14 4v7M14 17v7M4 14h7M17 14h7" />
    case 'presenter': return <><circle cx="14" cy="14" r="3" /><path d="M14 4.5v3M14 20.5v3M4.5 14h3M20.5 14h3" /><circle cx="14" cy="14" r="7.5" strokeDasharray="1.6 2.4" /></>
    // ── 线 / lines ──
    case 'trend': return <L a={[6, 22]} b={[22, 6]} at={[0, 1]} />
    case 'ray': return <L a={[6, 22]} b={[25, 3]} at={[0]} />
    case 'info': return <><L a={[5, 23]} b={[16, 12]} at={[0, 1]} /><rect x="16.5" y="3.5" width="8" height="5.5" rx="1" /></>
    case 'extended': return <L a={[3, 25]} b={[25, 3]} at={[0.32, 0.68]} />
    case 'angle': return <><L a={[6, 21]} b={[21, 7]} at={[0, 1]} /><path d={sg(6, 21, 24, 21, GAP)} strokeDasharray="1.6 2" /><path d="M13 21a7 7 0 00-2.1-5" /></>
    case 'hline': return <L a={[3, 14]} b={[25, 14]} at={[0.5]} />
    case 'hray': return <L a={[6, 14]} b={[25, 14]} at={[0]} />
    case 'vline': return <L a={[14, 3]} b={[14, 25]} at={[0.5]} />
    case 'crossline': return <><L a={[3, 14]} b={[25, 14]} at={[0.5]} /><path d={sg(14, 3, 14, 14, 0, GAP) + sg(14, 14, 14, 25, GAP)} /></>
    // ── 通道 / channels ──
    case 'channel': return <><L a={[4, 17]} b={[17, 4]} at={[0, 1]} /><L a={[11, 24]} b={[24, 11]} at={[0, 1]} /></>
    case 'regression': return <><L a={[4, 18]} b={[24, 9]} at={[0, 1]} /><path d={sg(4, 24, 24, 15) + sg(4, 12, 24, 3)} strokeDasharray="1.6 2" /></>
    case 'flatChannel': return <><L a={[4, 23]} b={[24, 11]} at={[0, 1]} /><L a={[4, 5]} b={[24, 5]} at={[0.5]} /></>
    case 'disjointChannel': return <><L a={[4, 12]} b={[24, 4]} at={[0, 1]} /><L a={[4, 16]} b={[24, 24]} at={[0, 1]} /></>
    // ── 音叉 / pitchforks ──
    case 'pitchfork': return <><L a={[4, 14]} b={[25, 14]} at={[0]} /><L a={[13, 6]} b={[13, 22]} at={[0, 1]} /><path d={sg(13, 6, 25, 6, GAP) + sg(13, 22, 25, 22, GAP)} /></>
    case 'schiffPitchfork': return <><L a={[4, 18]} b={[25, 12.75]} at={[0]} /><L a={[12, 8]} b={[12, 22]} at={[0, 1]} /><path d={sg(12, 8, 25, 4.75, GAP) + sg(12, 22, 25, 18.75, GAP)} /></>
    case 'modSchiffPitchfork': return <><L a={[4, 16.5]} b={[25, 13.35]} at={[0]} /><L a={[12, 8]} b={[12, 22]} at={[0, 1]} /><path d={sg(12, 8, 25, 6.05, GAP) + sg(12, 22, 25, 20.05, GAP)} /></>
    case 'insidePitchfork': return <><L a={[4, 14]} b={[25, 14]} at={[0]} /><L a={[11, 9]} b={[11, 19]} at={[0, 1]} /><path d={sg(11, 9, 25, 9, GAP) + sg(11, 19, 25, 19, GAP)} /></>
    case 'pitchfan': return <><Fan o={[4, 22]} to={[[25, 4], [25, 12], [25, 20]]} /><A p={[15, 8]} /><A p={[18, 19]} /></>
    // ── 斐波那契与江恩 / fib & gann ──
    case 'fib': return <><L a={[3, 6]} b={[25, 6]} at={[0.86]} /><path d="M3 11.3h22M3 16.6h22" /><L a={[3, 22]} b={[25, 22]} at={[0.14]} /><path d={sg(6, 22, 22, 6, GAP, GAP)} strokeDasharray="1.6 2" /></>
    case 'fibExt': return <><Z p={[[4, 23], [8, 13], [12, 19]]} /><path d="M15 5h10M15 10h10M15 15h10M15 20h10" /></>
    case 'fibChannel': return <><L a={[4, 14]} b={[24, 4]} at={[0, 1]} /><path d={sg(4, 19, 24, 9) + sg(4, 24, 24, 14)} /><path d={sg(4, 9, 14, 4)} strokeDasharray="1.6 2" /></>
    case 'fibTimeZone': return <><path d="M4 4v16.2M7 4v16.2M10 4v19M15 4v19M23 4v19" /><A p={[4, 23]} /><A p={[7, 23]} /></>
    case 'fibFan': return <><Fan o={[4, 24]} to={[[24, 4], [24, 11], [24, 17], [11, 4], [17, 4]]} /></>
    case 'fibTime': return <><Z p={[[4, 22], [8, 12], [12, 18]]} /><path d="M16 4v20M20 4v20M24 4v20" /></>
    case 'fibCircles': return <><circle cx="14" cy="14" r="5.5" /><circle cx="14" cy="14" r="10.5" /><L a={[14, 14]} b={[21.4, 6.6]} at={[0, 1]} /></>
    case 'fibArcs': return <><path d="M8.5 23a5.5 5.5 0 0111 0M4 23a10 10 0 0120 0" /><L a={[14, 23]} b={[14, 6]} at={[0, 1]} /></>
    case 'fibSpiral': return <><path d="M14 14.5a2 2 0 012 2 3.3 3.3 0 01-3.3 3.3A5.3 5.3 0 017.4 14.5 8.6 8.6 0 0116 5.9a13.2 13.2 0 0110 6" /><A p={[14, 14.5]} /></>
    case 'fibWedge': return <><Fan o={[4, 22]} to={[[24, 8], [24, 23]]} /><path d="M11 17.3a7.5 7.5 0 01.6 5M16 13.8a12.5 12.5 0 011.3 8.8" /></>
    case 'gannFan': return <Fan o={[4, 24]} to={[[24, 4], [24, 12], [24, 18], [12, 4], [18, 4]]} />
    case 'gannBox': return <><path d={`${sg(4, 24, 4, 4, GAP)}L${24 - GAP} 4${sg(24, 4, 24, 24, GAP)}${sg(24, 24, 4, 24, 0, GAP)}`} /><path d="M4 10.7h20M4 17.3h20M10.7 4v20M17.3 4v20" opacity="0.55" /><L a={[4, 24]} b={[24, 4]} at={[0, 1]} /></>
    case 'gannSquareFixed': return <><rect x="4" y="4" width="20" height="20" rx="0.5" /><path d="M4 24L24 4M4 24l20-10M4 24L14 4" opacity="0.7" /><path d="M4 14a10 10 0 0110 10" /></>
    case 'gannSquare': return <><rect x="4" y="6" width="20" height="16" rx="0.5" /><path d="M4 22L24 6M4 22l20-8M4 14h20M14 6v16" opacity="0.6" /></>
    // ── 形态 / patterns ──
    case 'xabcd': return <><Z p={[[3, 19], [8, 6], [13, 15], [18, 8], [25, 22]]} /><path d={sg(3, 19, 13, 15, GAP, GAP) + sg(13, 15, 25, 22, GAP, GAP)} strokeDasharray="1.6 2" /></>
    case 'cypher': return <><Z p={[[3, 17], [8, 6], [12, 13], [18, 4], [25, 21]]} /><path d={sg(3, 17, 18, 4, GAP, GAP)} strokeDasharray="1.6 2" /></>
    case 'abcd': return <Z p={[[4, 21], [10, 8], [16, 16], [24, 5]]} />
    case 'headShoulders': return <><path d="M3 21l4-8 3 5 4-12 4 12 3-5 4 8" /><path d="M3 18h22" strokeDasharray="1.6 2" /></>
    case 'trianglePattern': return <><Z p={[[4, 5], [9, 22], [14, 9], [19, 18]]} /><path d={sg(4, 5, 25, 14, GAP) + sg(9, 22, 25, 15, GAP)} strokeDasharray="1.6 2" /></>
    case 'threeDrives': return <path d="M3 23l4-6 2.5 3 4.5-8 2.5 3 4.5-9 2.5 3" />
    case 'elliottImpulse': return <><Z p={[[3, 23], [8, 14], [11, 18], [17, 6], [20, 11], [25, 4]]} /></>
    case 'elliottCorrection': return <><Z p={[[4, 5], [11, 18], [16, 11], [24, 23]]} /><text x="22" y="11" {...TXT}>C</text></>
    case 'elliottTriangle': return <path d="M3 5l4 18 4-14 3 11 3-8 3 6 4-4" />
    case 'elliottDouble': return <><Z p={[[4, 5], [11, 18], [16, 11], [24, 23]]} /><text x="22" y="11" {...TXT}>Y</text></>
    case 'elliottTriple': return <><Z p={[[3, 5], [8, 16], [12, 10], [17, 20], [24, 14]]} anchors={false} /><text x="21" y="9" {...TXT}>Z</text></>
    case 'cyclicLines': return <><path d="M5 4v16.2M12 4v16.2M19 4v19M26 4v19" /><A p={[5, 23]} /><A p={[12, 23]} /></>
    case 'timeCycles': return <><path d="M3 21a5.5 5.5 0 0111 0 5.5 5.5 0 0111 0" /><path d="M2 21h24" opacity="0.4" /></>
    case 'sineLine': return <path d="M3 14c1.8-5.3 3.6-8 5.5-8s3.7 2.7 5.5 8 3.6 8 5.5 8 3.7-2.7 5.5-8" />
    // ── 预测与测量 / projection & measurers ──
    case 'long': return <><L a={[5, 5.5]} b={[24, 5.5]} at={[0]} /><rect x="4" y="9.5" width="20" height="9" rx="0.5" /><text x="14" y="16.7" {...TXT}>L</text><L a={[5, 22.5]} b={[24, 22.5]} at={[0]} /></>
    case 'short': return <><L a={[5, 5.5]} b={[24, 5.5]} at={[0]} /><rect x="4" y="9.5" width="20" height="9" rx="0.5" /><text x="14" y="16.7" {...TXT}>S</text><L a={[5, 22.5]} b={[24, 22.5]} at={[0]} /></>
    case 'forecast': return <><L a={[4, 22]} b={[15, 11]} at={[0, 1]} /><path d={sg(15, 11, 24, 5, GAP)} strokeDasharray="1.6 2" /><rect x="17" y="15" width="8" height="6" rx="1" /></>
    case 'barsPattern': return <><path d="M6 7v11M10 5v11M14 9v9" opacity="0.5" /><rect x="17" y="11" width="3" height="7" /><rect x="22" y="9" width="3" height="8" /><path d="M18.5 8.5V11M18.5 18v2.5M23.5 6.5V9M23.5 17v2.5" /></>
    case 'ghostFeed': return <><path d="M3 21l7-9 5 5 9-11" strokeDasharray="1.6 2" opacity="0.6" /><rect x="6" y="13" width="3" height="6" /><rect x="13" y="12" width="3" height="5" /><rect x="20" y="7" width="3" height="6" /></>
    case 'anchoredVwap': return <><path d="M6 4v9.2M6 18.8V24" strokeDasharray="1.6 2" /><path d={sg(6, 16, 9, 15.4, GAP) + 'C13 14 15 9 18 9s5 3 7 2'} /><A p={[6, 16]} /></>
    case 'fixedRangeVP': return <><path d="M4 4v20M24 4v20" opacity="0.5" /><path d="M6 7h6M6 10.5h11M6 14h15M6 17.5h9M6 21h5" /></>
    case 'anchoredVP': return <><path d="M5 4v7.2M5 16.8V24" /><A p={[5, 14]} /><path d="M8 7h6M8 10.5h11M9 14h13M8 17.5h9M8 21h5" /></>
    case 'priceRange': return <><path d="M5 4.5h18M5 23.5h18" /><path d="M14 8v12M10.5 11.5L14 8l3.5 3.5M10.5 16.5L14 20l3.5-3.5" /></>
    case 'dateRange': return <><path d="M4.5 5v18M23.5 5v18" /><path d="M8 14h12M11.5 10.5L8 14l3.5 3.5M16.5 10.5L20 14l-3.5 3.5" /></>
    case 'datePriceRange': return <><path d={sg(5, 5, 23, 5, GAP) + sg(23, 5, 23, 23) + sg(23, 23, 5, 23, 0, GAP) + sg(5, 23, 5, 5, GAP, GAP)} /><A p={[5, 5]} /><A p={[5, 23]} /><path d="M9 14h10M16 11l3 3-3 3M14 19V9M11 12l3-3 3 3" /></>
    // ── 几何形状 / shapes ──
    case 'brush': return <><path d="M23 4.5l-8.6 9.8M12.6 12.8l3 3" /><path d="M12.4 15.2c-2-1.4-4.6-.5-5.1 2-.4 2-1.6 3.1-3.3 3.6 3.2 1.1 6.9.6 8.4-1.6 1-1.4 1-2.8 0-4z" /></>
    case 'highlighter': return <path d="M4 19c3-1 4.5-7 8-7s3.5 6 7 6 3.5-6 5.5-9" strokeWidth="4.2" opacity="0.45" />
    case 'arrowMarker': return <path d="M5.5 22.5l9.5-9.5-3-3H22v10l-3-3-9.5 9.5z" />
    case 'arrowUp': return <path d="M14 4l7.5 8.5H17V24h-6V12.5H6.5z" />
    case 'arrowDown': return <path d="M14 24l7.5-8.5H17V4h-6v11.5H6.5z" />
    case 'arrow': return <><L a={[5, 23]} b={[22, 6]} at={[0]} /><path d="M14 6h8v8" /></>
    case 'rect': return <><path d={sg(6, 7, 22, 7, GAP) + sg(22, 7, 22, 21, 0, GAP) + sg(22, 21, 6, 21, GAP) + sg(6, 21, 6, 7, 0, GAP)} /><A p={[6, 7]} /><A p={[22, 21]} /></>
    case 'rotatedRect': return <><path d={sg(9, 4, 24, 12, GAP) + sg(24, 12, 19, 24) + sg(19, 24, 4, 16, 0, GAP) + sg(4, 16, 9, 4, GAP, GAP)} /><A p={[9, 4]} /><A p={[4, 16]} /></>
    case 'path': return <><Z p={[[4, 21], [10, 10], [16, 17]]} /><path d={sg(16, 17, 23, 7, GAP)} /><path d="M18.5 7.5L23 7l.2 4.6" /></>
    case 'circle': return <><circle cx="14" cy="14" r="10" /><A p={[14, 14]} /></>
    case 'ellipse': return <><ellipse cx="14" cy="14" rx="11" ry="7" /><A p={[14, 14]} /></>
    case 'polyline': return <Z p={[[4, 20], [9, 7], [16, 15], [24, 6], [23, 22]]} close />
    case 'triangle': return <Z p={[[14, 4], [24, 22], [4, 22]]} close />
    case 'arc': return <><path d="M6 18.1Q14 2 22 18.1" /><A p={[5, 20]} /><A p={[23, 20]} /></>
    case 'curve': return <><path d="M5.6 18.1C8 7 20 7 22.4 18.1" /><A p={[5, 20]} /><A p={[23, 20]} /><A p={[14, 5]} /></>
    case 'doubleCurve': return <><path d="M4.7 17.9C7.5 7 11.5 7 14 14s6.5 7 9.3-3.9" /><A p={[4, 20]} /><A p={[24, 8]} /></>
    case 'sector': return <><path d="M6 19.2V6a16 16 0 0116 16H8.8" /><A p={[6, 22]} /></>
    // ── 文字标注 / annotations ──
    case 'text': return <path d="M7 8V6h14v2M14 6v16M11 22h6" />
    case 'anchoredText': return <><path d="M8 7V5h12v2M14 5v13M11.5 18h5" /><A p={[14, 23]} /></>
    case 'note': return <><path d="M5 5h18v12l-6 6H5z" /><path d="M17 23v-6h6M9 10h10M9 14h6" /></>
    case 'priceNote': return <><L a={[5, 23]} b={[12, 15]} at={[0]} /><rect x="12" y="5" width="12" height="9" rx="1.5" /><path d="M15 9.5h6" /></>
    case 'pin': return <><path d="M14 24.5s-6.5-6.8-6.5-11.5a6.5 6.5 0 0113 0c0 4.7-6.5 11.5-6.5 11.5z" /><circle cx="14" cy="13" r="2.2" /></>
    case 'callout': return <><rect x="10" y="4" width="14" height="11" rx="1.5" /><path d="M13 15l-5.4 6" /><A p={[6, 23]} /></>
    case 'comment': return <path d="M5 6h18v13h-9l-5 4.5V19H5z" />
    case 'signpost': return <><rect x="6" y="4" width="16" height="8" rx="1.5" /><path d="M14 12v8.2" /><A p={[14, 23]} /></>
    case 'flag': return <><path d="M7 24V4.5" /><path d="M7 5.5c4.5-2.5 8 2.5 14 0v9c-6 2.5-9.5-2.5-14 0" /></>
    case 'priceLabel': return <><path d="M10 5h12.5a1.5 1.5 0 011.5 1.5v8a1.5 1.5 0 01-1.5 1.5H13l-4 4" /><path d="M10 5a1.5 1.5 0 00-1.5 1.5v6" /><A p={[7, 22]} /></>
    case 'table': return <><rect x="4" y="6" width="20" height="16" rx="1.5" /><path d="M4 11.5h20M4 16.8h20M11.5 6v16" /></>
    case 'image': return <><rect x="4" y="6" width="20" height="16" rx="1.5" /><circle cx="10" cy="11.5" r="2" /><path d="M24 18.5l-6-6-9.5 9.5" /></>
    case 'emoji': return <><circle cx="14" cy="14" r="10" /><path d="M9.5 16.5c1.1 2 2.7 3 4.5 3s3.4-1 4.5-3" /><path d="M10.5 11h.01M17.5 11h.01" strokeWidth="2.6" /></>
  }
}

// size / sw：外壳按需放大（专业版左栏 26px）；sw 是 28 格里的线宽，渲染出来约 1px
// size / sw: shells scale it (the pro rail uses 26px); sw is the stroke in the 28 grid, about 1px on screen
export function DrawToolIcon({ tool, size, sw }: { tool: Tool; size?: number; sw?: number }) {
  const s = size ?? BASE.width
  return <svg {...BASE} width={s} height={s} strokeWidth={sw ?? Math.max(1, Math.round((28 / s) * 1.05 * 100) / 100)}>{glyph(tool)}</svg>
}
