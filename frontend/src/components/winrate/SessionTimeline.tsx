// 时段一览：每个盘一行（名字 + 换算到浏览者时区的钟点）+ 一条 24 小时色带轴。
// "现在是哪个盘、还剩多久"这句结论由 WatchNow 说，这里不重复——行里只放钟点，
// 位置关系交给色带和游标。色带位置按当刻时区偏移换算，DST 切换日会整体跳一小时，
// 那是正确行为。钟点标签放在 HTML 里而不是 svg 里：svg 用 preserveAspectRatio="none"
// 拉伸，文字会跟着变形。
// Session overview: one row per session (name + window in the viewer's clock)
// plus a 24h band strip. "Which session is open and how long is left" is
// WatchNow's sentence, not repeated here — rows carry only the clock, the strip
// and cursor carry position. Clock labels live in HTML, not inside the
// stretched svg.
import { useTranslation } from 'react-i18next'
import type { SessionWindow } from '../../api/types'
import { SESSION_COLORS, fmtClock, localWindow, sessionStatus, zoneOffsetMinutes } from './shared'

const W = 1440 // 1 分钟 = 1 单位 / one unit per minute

// 两套尺寸。compact 是仪表盘卡上的简化版：只剩色带和游标，去掉每盘一行的图例
// 与「现在」标签——卡上方那句「现在：亚洲盘 进行中·还剩 3h45m」已经把结论说完，
// 色带在这里只负责回答"这一天里我站在哪儿、下一段什么时候开始"。刻度线从每
// 3 小时疏成每 6 小时，300px 宽下 8 条线会糊成一片灰。
// Two sizes. `compact` is the dashboard card's version: bands and cursor only,
// without the per-session legend rows — the sentence above the card already
// states which session is open and how long is left, so here the strip only
// answers "where in the day am I, and when does the next block start". Grid
// lines thin out from every 3h to every 6h; at ~300px wide, eight of them blur
// into a grey wash.
const SIZE = {
  full: { h: 30, band: 6, y: { asia: 2, europe: 12, newyork: 22 }, gridEvery: 180, ticks: [0, 360, 720, 1080], showNow: true },
  compact: { h: 20, band: 5, y: { asia: 0, europe: 7, newyork: 14 }, gridEvery: 360, ticks: [0, 360, 720, 1080], showNow: false },
} as const
// 0.7：在 --surface 上合成后三条带色度够、又不压过白色游标（见 git 历史里的 dataviz 校验）。
// 0.7 keeps the three bands distinguishable over --surface without out-shouting the cursor.
const BAND_OPACITY = 0.7

export default function SessionTimeline({
  sessions, now, variant = 'full',
}: { sessions: SessionWindow[]; now: Date; variant?: 'full' | 'compact' }) {
  const { t } = useTranslation()
  const viewerOffset = -now.getTimezoneOffset()
  const nowX = now.getHours() * 60 + now.getMinutes()
  const sz = SIZE[variant]
  const H = sz.h
  const gridLines = Array.from({ length: Math.floor(W / sz.gridEvery) + 1 }, (_, i) => i * sz.gridEvery)

  return (
    <div>
      {variant === 'full' && (
      <ul className="space-y-2">
        {sessions.map((s) => {
          const win = localWindow(s, now)
          const color = SESSION_COLORS[s.key] ?? SESSION_COLORS.outside
          const active = sessionStatus(s, now).state === 'active'
          return (
            <li key={s.key} className="flex items-center justify-between gap-3 text-sm">
              <span className={`flex items-center gap-2 ${active ? 'text-neutral-100' : 'text-neutral-400'}`}>
                <i className={`h-2 w-2 shrink-0 rounded-full ${active ? 'animate-breathe' : ''}`}
                   style={{ backgroundColor: color }} />
                {t(`admin.winrate.session.${s.key}`)}
              </span>
              <span className="tabular-nums text-neutral-500">
                {t('admin.winrate.timeline.yourTime', { start: win.start, end: win.end })}
              </span>
            </li>
          )
        })}
      </ul>
      )}

      <div className={variant === 'full' ? 'mt-4' : ''}>
        <svg viewBox={`0 0 ${W} ${H}`} className="block w-full" style={{ height: H }}
             preserveAspectRatio="none" role="group" aria-label={t('admin.winrate.timeline.label')}>
          {gridLines.map((x) => (
            <line key={x} x1={x} y1={0} x2={x} y2={H} stroke="rgba(255,255,255,0.06)"
                  strokeWidth="1" vectorEffect="non-scaling-stroke" />
          ))}
          {sessions.map((s) => {
            const delta = viewerOffset - zoneOffsetMinutes(s.tz, now)
            const start = (((s.startHour * 60 + delta) % 1440) + 1440) % 1440
            const end = (((s.endHour * 60 + delta) % 1440) + 1440) % 1440
            const y = sz.y[s.key as keyof typeof sz.y] ?? 0
            const color = SESSION_COLORS[s.key] ?? SESSION_COLORS.outside
            // 跨零点拆两段 / a window over midnight renders as two rects
            const segs = start < end ? [[start, end]] : [[start, 1440], [0, end]]
            const win = localWindow(s, now)
            const title = t('admin.winrate.timeline.window', {
              name: t(`admin.winrate.session.${s.key}`), start: win.start, end: win.end,
            })
            return segs.map(([a, b]) => (
              <rect key={`${s.key}-${a}`} x={a} y={y} width={b - a} height={sz.band} rx={2}
                    fill={color} opacity={BAND_OPACITY} role="img" aria-label={title}>
                <title>{title}</title>
              </rect>
            ))
          })}
          {/* 当前时刻游标 / the now cursor */}
          <line x1={nowX} y1={0} x2={nowX} y2={H} stroke="#fff" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        </svg>
        <div className="relative mt-1 h-4 text-2xs tabular-nums text-neutral-500">
          {sz.ticks.map((m) => (
            <span key={m} className="absolute" style={{ left: `${(m / W) * 100}%` }}>{fmtClock(m)}</span>
          ))}
          {sz.showNow && <span className="absolute right-0">{t('admin.winrate.timeline.now')}</span>}
        </div>
      </div>
    </div>
  )
}
