// 「现在是什么盘」：三行文字状态 + 一条 24 小时色带轴（按浏览者本地时区）。
// 新手先读字（"欧洲盘 进行中 · 剩 1h22m"），色带只是给个空间感；色带位置按
// 当刻时区偏移换算，DST 切换日会整体跳一小时——那是正确行为。
// 钟点标签放在 HTML 里而不是 svg 里：svg 用 preserveAspectRatio="none" 拉伸，
// 文字会跟着变形。
// "Which session is open now": three text rows plus a 24h band strip in the
// viewer's clock. Newcomers read the words first; the strip only adds a sense
// of position. Clock labels live in HTML, not inside the stretched svg.
import { useTranslation } from 'react-i18next'
import type { SessionWindow } from '../../../api/types'
import { SESSION_COLORS, fmtClock, fmtDurationHm, localWindow, sessionStatus, zoneOffsetMinutes } from './shared'

const W = 1440 // 1 分钟 = 1 单位 / one unit per minute
const H = 30
const BAND_Y: Record<string, number> = { asia: 2, europe: 12, newyork: 22 }
// 0.7：在 --surface 上合成后三条带色度够、又不压过白色游标（见 git 历史里的 dataviz 校验）。
// 0.7 keeps the three bands distinguishable over --surface without out-shouting the cursor.
const BAND_OPACITY = 0.7

export default function SessionTimeline({ sessions, now }: { sessions: SessionWindow[]; now: Date }) {
  const { t } = useTranslation()
  const viewerOffset = -now.getTimezoneOffset()
  const nowX = now.getHours() * 60 + now.getMinutes()

  return (
    <div>
      <ul className="space-y-2.5">
        {sessions.map((s) => {
          const st = sessionStatus(s, now)
          const win = localWindow(s, now)
          const color = SESSION_COLORS[s.key] ?? SESSION_COLORS.outside
          const active = st.state === 'active'
          return (
            <li key={s.key} className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2 text-sm text-neutral-200">
                <i className={`h-2 w-2 shrink-0 rounded-full ${active ? 'animate-breathe' : ''}`}
                   style={{ backgroundColor: color }} />
                {t(`admin.winrate.session.${s.key}`)}
              </span>
              <span className="text-right">
                <span className={`block text-sm tabular-nums ${active ? 'font-medium' : 'text-neutral-400'}`}
                      style={active ? { color: 'var(--up)' } : undefined}>
                  {active
                    ? t('admin.winrate.timeline.activeLeft', { time: fmtDurationHm(st.minutesToEnd) })
                    : t('admin.winrate.timeline.startsIn', { time: fmtDurationHm(st.minutesToStart) })}
                </span>
                <span className="block text-2xs tabular-nums text-neutral-500">
                  {t('admin.winrate.timeline.yourTime', { start: win.start, end: win.end })}
                </span>
              </span>
            </li>
          )
        })}
      </ul>

      <div className="mt-4">
        <svg viewBox={`0 0 ${W} ${H}`} className="block w-full" style={{ height: H }}
             preserveAspectRatio="none" role="group" aria-label={t('admin.winrate.timeline.label')}>
          {Array.from({ length: 9 }, (_, i) => i * 180).map((x) => (
            <line key={x} x1={x} y1={0} x2={x} y2={H} stroke="rgba(255,255,255,0.06)"
                  strokeWidth="1" vectorEffect="non-scaling-stroke" />
          ))}
          {sessions.map((s) => {
            const delta = viewerOffset - zoneOffsetMinutes(s.tz, now)
            const start = (((s.startHour * 60 + delta) % 1440) + 1440) % 1440
            const end = (((s.endHour * 60 + delta) % 1440) + 1440) % 1440
            const y = BAND_Y[s.key] ?? 2
            const color = SESSION_COLORS[s.key] ?? SESSION_COLORS.outside
            // 跨零点拆两段 / a window over midnight renders as two rects
            const segs = start < end ? [[start, end]] : [[start, 1440], [0, end]]
            const win = localWindow(s, now)
            const title = t('admin.winrate.timeline.window', {
              name: t(`admin.winrate.session.${s.key}`), start: win.start, end: win.end,
            })
            return segs.map(([a, b]) => (
              <rect key={`${s.key}-${a}`} x={a} y={y} width={b - a} height={6} rx={2}
                    fill={color} opacity={BAND_OPACITY} role="img" aria-label={title}>
                <title>{title}</title>
              </rect>
            ))
          })}
          {/* 当前时刻游标 / the now cursor */}
          <line x1={nowX} y1={0} x2={nowX} y2={H} stroke="#fff" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        </svg>
        <div className="relative mt-1 h-4 text-2xs tabular-nums text-neutral-500">
          {[0, 360, 720, 1080].map((m) => (
            <span key={m} className="absolute" style={{ left: `${(m / W) * 100}%` }}>{fmtClock(m)}</span>
          ))}
          <span className="absolute right-0">{t('admin.winrate.timeline.now')}</span>
        </div>
      </div>
    </div>
  )
}
