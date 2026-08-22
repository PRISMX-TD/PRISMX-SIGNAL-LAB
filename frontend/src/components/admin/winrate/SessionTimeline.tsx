// 24 小时时段轴：按浏览者本地时区画三条时段色带 + 当前时刻游标。
// "现在在哪、离哪个盘多远"变成看位置。色带位置每次渲染按当刻时区偏移换算，
// DST 切换日会整体跳一小时——那是正确行为，不做平滑。
// A 24h axis in the viewer's clock; session bands + a "now" cursor.
import { useTranslation } from 'react-i18next'
import type { SessionWindow } from '../../../api/types'
import { SESSION_COLORS, fmtClock, localWindow, sessionStatus, zoneOffsetMinutes } from './shared'

const W = 1440 // 1 分钟 = 1 单位 / one unit per minute
const H = 46
const BAND_Y: Record<string, number> = { asia: 8, europe: 18, newyork: 28 } // 三条带错行叠放

export default function SessionTimeline({ sessions, now }: { sessions: SessionWindow[]; now: Date }) {
  const { t } = useTranslation()
  const viewerOffset = -now.getTimezoneOffset()
  const nowX = (now.getHours() * 60 + now.getMinutes())

  return (
    <div className="glass p-4">
      <div className="overflow-x-auto">
        <svg viewBox={`0 0 ${W} ${H}`} className="min-w-[560px] w-full" style={{ height: H }}
             preserveAspectRatio="none" role="img" aria-label={t('admin.winrate.timelineLabel')}>
          {/* 小时刻度线（每 3 小时）/ hour ticks every 3h */}
          {Array.from({ length: 9 }, (_, i) => i * 180).map((x) => (
            <line key={x} x1={x} y1={0} x2={x} y2={H - 8} stroke="rgba(255,255,255,0.06)"
                  strokeWidth="1" vectorEffect="non-scaling-stroke" />
          ))}
          {sessions.map((s) => {
            const delta = viewerOffset - zoneOffsetMinutes(s.tz, now)
            const start = (((s.startHour * 60 + delta) % 1440) + 1440) % 1440
            const end = (((s.endHour * 60 + delta) % 1440) + 1440) % 1440
            const y = BAND_Y[s.key] ?? 8
            const color = SESSION_COLORS[s.key] ?? '#8884'
            // 跨零点拆两段 / a window over midnight renders as two rects
            const segs = start < end ? [[start, end]] : [[start, 1440], [0, end]]
            // hover 标题：浏览者本地时区的完整窗口，两段共用同一句话（不是各段的局部时刻）
            // hover title: the full window in the viewer's local zone, shared by both
            // split segments (not each segment's own partial range)
            const win = localWindow(s, now)
            const title = t('admin.winrate.sessionWindowTitle', {
              name: t(`admin.winrate.session.${s.key}`), start: win.start, end: win.end,
            })
            return segs.map(([a, b]) => (
              <rect key={`${s.key}-${a}`} x={a} y={y} width={b - a} height={8} rx={2}
                    fill={color} opacity={0.45}>
                <title>{title}</title>
              </rect>
            ))
          })}
          {/* 当前时刻游标 / the now cursor */}
          <line x1={nowX} y1={0} x2={nowX} y2={H - 8} stroke="#fff" strokeWidth="1.5"
                vectorEffect="non-scaling-stroke" />
          <circle cx={nowX} cy={4} r={4} fill="#fff" />
          {/* 底部时刻标签 / clock labels */}
          {[0, 360, 720, 1080].map((m) => (
            <text key={m} x={m + 4} y={H - 1} fontSize="9" fill="rgba(255,255,255,0.35)">{fmtClock(m)}</text>
          ))}
        </svg>
      </div>
      {/* 状态行：每时段一枚芯片 / one status chip per session */}
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
        {sessions.map((s) => {
          const st = sessionStatus(s, now)
          const color = SESSION_COLORS[s.key] ?? '#888'
          return (
            <span key={s.key} className="flex items-center gap-1.5">
              <i className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
              <span className="text-neutral-300">{t(`admin.winrate.session.${s.key}`)}</span>
              {st.state === 'active' ? (
                <span className="text-up tabular-nums">
                  {t('admin.winrate.activeLeft', { time: fmtClock(st.minutesToEnd) })}
                </span>
              ) : (
                <span className="text-neutral-500 tabular-nums">
                  {t('admin.winrate.startsIn', { time: fmtClock(st.minutesToStart) })}
                </span>
              )}
            </span>
          )
        })}
      </div>
    </div>
  )
}
