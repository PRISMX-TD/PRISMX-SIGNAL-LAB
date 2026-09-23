// 顶栏信号强度图标：本设备到服务器的连接质量（心跳往返延迟），点开看详情。
// 与 EA 徽标分开——那个说的是 MT5 终端在不在线，这个说的是「你这台设备」连得好不好。
// Header signal-strength icon: this device's connection quality to our server
// (heartbeat round-trip latency); tap for details. Deliberately separate from the
// EA badge — that one is about the MT5 terminal, this one about *this device*.
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FAIR_MS, GOOD_MS, jitter, latestRtt, netLevel, useNetQuality } from '../store/netQuality'

const LEVEL_COLOR = ['text-down', 'text-down', 'text-orange-400', 'text-amber-300', 'text-up'] as const

function Bars({ level, connecting }: { level: number; connecting: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" className={connecting ? 'animate-pulse' : ''}>
      {[0, 1, 2, 3].map((i) => (
        <rect
          key={i}
          x={1 + i * 4.4}
          y={14 - (i + 1) * 3}
          width="3"
          height={(i + 1) * 3 + 1}
          rx="0.8"
          fill="currentColor"
          opacity={i < level ? 1 : 0.22}
        />
      ))}
    </svg>
  )
}

export default function SignalIndicator() {
  const { t } = useTranslation()
  const q = useNetQuality()
  const [open, setOpen] = useState(false)
  const [, tick] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)

  const level = netLevel(q)
  const rtt = latestRtt(q)
  const connecting = q.state === 'connecting'
  const color = connecting ? 'text-neutral-400' : LEVEL_COLOR[level]
  const quality = q.state !== 'online' ? t(connecting ? 'netSignal.connecting' : 'netSignal.offline')
    : level === 4 ? t('netSignal.good') : level === 3 ? t('netSignal.fair') : t('netSignal.poor')

  // 面板开着时每秒刷新「上次收到数据」/ tick "last data" every second while open
  useEffect(() => {
    if (!open) return
    const id = window.setInterval(() => tick((n) => n + 1), 1000)
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => {
      window.clearInterval(id)
      document.removeEventListener('mousedown', onDown)
    }
  }, [open])

  const ago = q.lastFrameAt == null ? null : Math.max(0, Math.round((Date.now() - q.lastFrameAt) / 1000))
  const jit = jitter(q)
  const Row = ({ k, v }: { k: string; v: string }) => (
    <div className="flex items-center justify-between gap-4 py-1.5 text-sm">
      <span className="text-neutral-400">{k}</span>
      <span className="num text-neutral-100">{v}</span>
    </div>
  )

  return (
    <div ref={rootRef} className="nb">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={`${t('netSignal.title')}: ${quality}`}
        aria-expanded={open}
        className={`flex items-center gap-1.5 rounded-inner border border-white/10 px-2 py-1.5 transition-colors hover:border-white/20 ${color}`}
      >
        <Bars level={connecting ? 4 : level} connecting={connecting} />
        {/* 桌面宽屏才显示数字；手机只留格子 / number only on wide screens */}
        {q.state === 'online' && rtt != null && (
          <span className="num hidden text-xs lg:inline">{rtt}ms</span>
        )}
      </button>

      {open && (
        <div className="card glass nb-panel" role="dialog" aria-label={t('netSignal.title')} style={{ width: 280 }}>
          <div className="p-4">
            <div className="mb-2 flex items-center gap-2">
              <span className={color}><Bars level={connecting ? 4 : level} connecting={connecting} /></span>
              <h3 className="text-base font-semibold text-neutral-100">{t('netSignal.title')}</h3>
              <span className={`ml-auto text-sm font-medium ${color}`}>{quality}</span>
            </div>
            <Row k={t('netSignal.latency')} v={q.state === 'online' && rtt != null ? `${rtt} ms` : '—'} />
            <Row k={t('netSignal.jitter')} v={q.state === 'online' && jit != null ? `±${jit} ms` : '—'} />
            <Row k={t('netSignal.lastData')} v={ago == null ? '—' : t('netSignal.secondsAgo', { n: ago })} />
            <Row k={t('netSignal.reconnects')} v={String(q.reconnects)} />
            <p className="mt-3 text-xs leading-relaxed text-neutral-500">
              {t('netSignal.hint', { good: GOOD_MS, fair: FAIR_MS })}
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
