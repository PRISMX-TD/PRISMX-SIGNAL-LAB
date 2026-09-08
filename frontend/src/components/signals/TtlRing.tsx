// 倒计时环：22px 的环 + mm:ss + 说明字。信号板牌面、仪表盘可执行信号卡、
// 其他活跃信号行三处共用一份，样式在 signals.css 的 .sig-ttl。
// 剩余不足 2 分钟（EXPIRING）时环与数字一起转跌色——真实的状态变化，不是装饰。
// 组件不自带时钟：调用方决定用共享秒钟（useClock）还是页面已有的 now。
// Countdown ring: a 22px arc, mm:ss and a caption, shared by the board card, the
// dashboard's executable-signal card and the other-active-signals rows; styled by
// .sig-ttl in signals.css. Under two minutes (EXPIRING) ring and digits turn the
// down tone — a real state change. No clock of its own: the caller passes `now`
// (the shared per-second clock or the page's existing tick).
import { memo, type FC } from 'react'
import { calcCountdown } from '../../api/utils'
import { EXPIRING_THRESHOLD_MS, SIGNAL_LIFESPAN_MS } from './SignalView'

const RING_R = 9
const RING_C = 2 * Math.PI * RING_R

const TtlRing: FC<{ expireAt: string | null; now: number; label: string }> = memo(({ expireAt, now, label }) => {
  const cd = calcCountdown(expireAt, SIGNAL_LIFESPAN_MS, now)
  const urgent = cd != null && !cd.expired && cd.remainMs <= EXPIRING_THRESHOLD_MS
  const frac = cd?.fraction ?? 0
  return (
    <div className={`sig-ttl${urgent ? ' urgent' : ''}`} aria-live="off">
      <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
        <circle className="ring-track" cx="11" cy="11" r={RING_R} fill="none" strokeWidth="2" />
        <circle
          className="ring-fill"
          cx="11" cy="11" r={RING_R} fill="none" strokeWidth="2" strokeLinecap="round"
          strokeDasharray={RING_C}
          strokeDashoffset={RING_C * (1 - frac)}
          transform="rotate(-90 11 11)"
        />
      </svg>
      <b className="num">{cd?.text ?? '--:--'}</b>
      <span>{label}</span>
    </div>
  )
})

export default TtlRing
