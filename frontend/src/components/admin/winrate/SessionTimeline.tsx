// 24 小时时段轴：按浏览者本地时区画三条时段色带 + 当前时刻游标。
// "现在在哪、离哪个盘多远"变成看位置。色带位置每次渲染按当刻时区偏移换算，
// DST 切换日会整体跳一小时——那是正确行为，不做平滑。
// A 24h axis in the viewer's clock; session bands + a "now" cursor.
import { useTranslation } from 'react-i18next'
import type { SessionWindow } from '../../../api/types'
import { SESSION_COLORS, fmtClock, fmtDurationHm, localWindow, sessionStatus, zoneOffsetMinutes } from './shared'

const W = 1440 // 1 分钟 = 1 单位 / one unit per minute
const H = 46
const BAND_Y: Record<string, number> = { asia: 8, europe: 18, newyork: 28 } // 三条带错行叠放

// 色带不透明度。原值 0.45 来自设计文档"重叠区颜色自然叠加"那句，但 BAND_Y 把
// 三条带放在互不重叠的三行上——叠加从来没发生过，那 0.45 就只剩代价没有收益：
// 合成到 --surface #1b1b21 之后三条带变成 #1E6E7D / #654A84 / #806522，跑 dataviz
// 的 validate_palette.js（--mode dark --surface #1b1b21）四项全 FAIL——三个颜色的
// OKLCH chroma 都掉到 0.10 的地板以下（读成三条灰带）、青紫两条的常规视觉 ΔE 只
// 有 12.9（硬 FAIL 线 15：全色觉的人都分不出）、deutan ΔE 4.6（远低于 6–8 底线）。
// 改成 0.70：合成色 #209cb1 / #8e65ba / #b88e23，同一条命令 ALL CHECKS PASS
// （亮度带、chroma、常规视觉 ΔE 18.1、对比度全 PASS；CVD deutan ΔE 6.9 落在 6–8
// 的 WARN 带里，按 dataviz 的规矩需要二次编码兜底——本组件恰好三重具备：三条带
// 各占一行=位置编码、下方状态芯片给每个时段直接标了名字、每条带还有 aria-label）。
// 不直接用 1.0：那会把三个色相顶出 dark 模式的亮度带（L 0.797/0.722/0.837 vs
// 上限 0.67），色带比轴上的白色游标还抢眼，游标就找不着了。
// Band opacity. The original 0.45 came from the design doc's "overlaps blend
// naturally" line — but BAND_Y puts the three bands on three non-overlapping
// rows, so that blend never happens and 0.45 was paying a cost for nothing:
// composited over --surface #1b1b21 the bands land on #1E6E7D / #654A84 /
// #806522, which fails all four measurable checks in dataviz's
// validate_palette.js (--mode dark --surface #1b1b21) — every hue's OKLCH chroma
// drops under the 0.10 floor (three grey bands), the cyan/purple pair separates
// by only ΔE 12.9 under normal vision (hard-fail line 15: full-colour readers
// can't tell them apart) and ΔE 4.6 under deutan (the floor is 6-8).
// 0.70 composites to #209cb1 / #8e65ba / #b88e23 and the same command reports
// ALL CHECKS PASS (lightness band, chroma, normal-vision ΔE 18.1 and contrast
// all PASS; deutan ΔE 6.9 sits in the 6-8 WARN band, which dataviz allows only
// with secondary encoding — this component has three: each band owns its own row
// (position), the status chips below name every session directly, and each band
// carries an aria-label).
// Not 1.0: that pushes all three hues past the dark-mode lightness band
// (L 0.797/0.722/0.837 against a 0.67 ceiling) and the bands then out-shout the
// white now-cursor drawn over them.
const BAND_OPACITY = 0.7

export default function SessionTimeline({ sessions, now }: { sessions: SessionWindow[]; now: Date }) {
  const { t } = useTranslation()
  const viewerOffset = -now.getTimezoneOffset()
  const nowX = (now.getHours() * 60 + now.getMinutes())

  return (
    <div className="glass p-4">
      <div className="overflow-x-auto">
        {/* svg 级 role 用 "group" 不用 "img"（code review Important 1，两个组件统一
            改法）：role="img" 会把子节点拍平成一张图，子节点自己的 aria-label 对
            屏幕阅读器不可见；"group" 才会把下面每条色带当独立可达节点暴露出去，
            配合色带上的 tabIndex 才有意义。
            svg-level role is "group", not "img" (code review Important 1, same fix
            applied to both components): role="img" flattens children into one
            picture, so a child's own aria-label is invisible to a screen reader;
            "group" exposes each band below as its own reachable node, which is
            what makes the bands' tabIndex meaningful. */}
        <svg viewBox={`0 0 ${W} ${H}`} className="min-w-[560px] w-full" style={{ height: H }}
             preserveAspectRatio="none" role="group" aria-label={t('admin.winrate.timelineLabel')}>
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
            // 键盘等价路径（code review Important 1）：title 只在鼠标 hover 时出现，
            // 这里给每条色带加 tabIndex+aria-label（与 title 同文案），键盘 Tab
            // 能读到和鼠标 hover 一样的窗口信息。
            // Keyboard-equivalent path (code review Important 1): title only
            // fires on mouse hover; each band also gets tabIndex + aria-label
            // (same text as the title) so keyboard Tab reaches the same window
            // info as a mouse hover would.
            return segs.map(([a, b]) => (
              <rect key={`${s.key}-${a}`} x={a} y={y} width={b - a} height={8} rx={2}
                    fill={color} opacity={BAND_OPACITY} tabIndex={0} role="img" aria-label={title}
                    className="outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-white/80">
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
              {/* 倒计时用 fmtDurationHm 而不是 fmtClock：这两个数字在本文件里只隔
                  二十行——上面轴底的 06:00 是"几点"，这里的是"还有多久"。同一个
                  `02:14` 两种意思，读者没有任何线索区分；`2h14m` 一眼就是时长，
                  也正是设计文档 §5.1 写的格式。
                  The countdown uses fmtDurationHm, not fmtClock: the two numbers
                  sit twenty lines apart in this file — the 06:00 under the axis
                  is a time of day, this one is time remaining. One `02:14`
                  meaning both leaves the reader no way to tell; `2h14m` reads as
                  a duration on sight, and is what design doc §5.1 specifies. */}
              {st.state === 'active' ? (
                <span className="text-up tabular-nums">
                  {t('admin.winrate.activeLeft', { time: fmtDurationHm(st.minutesToEnd) })}
                </span>
              ) : (
                <span className="text-neutral-500 tabular-nums">
                  {t('admin.winrate.startsIn', { time: fmtDurationHm(st.minutesToStart) })}
                </span>
              )}
            </span>
          )
        })}
      </div>
    </div>
  )
}
