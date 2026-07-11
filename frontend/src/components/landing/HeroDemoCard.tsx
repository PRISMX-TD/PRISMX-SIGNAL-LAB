// 示例信号卡：静态展示交付物长什么样，非实时数据；桌面端带 3D 微倾。
// static sample signal card (not live data) with a desktop-only 3D tilt.
import { useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'

export default function HeroDemoCard({ className = '' }: { className?: string }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const ref = useRef<HTMLDivElement>(null)

  const fine =
    typeof window !== 'undefined' &&
    window.matchMedia('(pointer: fine)').matches &&
    !window.matchMedia('(prefers-reduced-motion: reduce)').matches

  const onMove = (e: React.MouseEvent) => {
    if (!fine || !ref.current) return
    const r = ref.current.getBoundingClientRect()
    const x = (e.clientX - r.left) / r.width
    const y = (e.clientY - r.top) / r.height
    ref.current.style.transform = `perspective(900px) rotateX(${(0.5 - y) * 7}deg) rotateY(${(x - 0.5) * 9}deg)`
  }
  const onLeave = () => {
    if (ref.current) ref.current.style.transform = ''
  }

  return (
    <div
      ref={ref}
      onMouseMove={onMove}
      onMouseLeave={onLeave}
      className={`glass-neon tilt-3d animate-fade-in-up p-6 ${className}`}
    >
      <div className="flex items-center justify-between">
        <span
          className="chip"
          style={{ background: 'rgba(246, 196, 83, 0.12)', color: 'var(--gold)', border: '1px solid rgba(246, 196, 83, 0.35)' }}
        >
          {t('landing.demoBadge')}
        </span>
      </div>

      <div className="mt-4 flex items-center justify-between">
        <div>
          <div className="font-display text-xl font-bold text-slate-50">XAUUSD</div>
          <div className="text-xs text-slate-400">{t('landing.demoSymbolName')}</div>
        </div>
        <span className="chip buy">{t('landing.demoSide')}</span>
      </div>

      <div className="mt-5 grid grid-cols-3 gap-3 text-center">
        <div className="rounded-inner border border-white/10 bg-white/[0.03] px-2 py-3">
          <div className="text-[11px] text-slate-400">{t('landing.demoEntry')}</div>
          <div className="num mt-1 text-sm font-semibold text-slate-100">2350.00</div>
        </div>
        <div className="rounded-inner border border-white/10 bg-white/[0.03] px-2 py-3">
          <div className="text-[11px] text-slate-400">{t('landing.demoSl')}</div>
          <div className="num mt-1 text-sm font-semibold" style={{ color: 'var(--down)' }}>2340.60</div>
        </div>
        <div className="rounded-inner border border-white/10 bg-white/[0.03] px-2 py-3">
          <div className="text-[11px] text-slate-400">{t('landing.demoTp')}</div>
          <div className="num mt-1 text-sm font-semibold" style={{ color: 'var(--up)' }}>2368.80</div>
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between text-sm">
        <span className="text-slate-400">{t('landing.demoRr')}</span>
        <span className="num font-semibold text-slate-100">1 : 2</span>
      </div>
      <div className="mt-2 flex items-center justify-between text-sm">
        <span className="text-slate-400">{t('landing.demoRisk')}</span>
        <span className="text-right text-xs font-medium text-slate-200">{t('landing.demoRiskValue')}</span>
      </div>

      {/* 先亮出一条判输的记录：最强的信任触发器 / show a judged LOSS up front: strongest trust cue */}
      <div className="mt-5 flex items-start gap-2 rounded-inner border border-white/10 bg-white/[0.03] px-3 py-2.5">
        <span className="mt-0.5 text-xs font-bold" style={{ color: 'var(--down)' }}>✗</span>
        <div className="min-w-0">
          <div className="text-[11px] text-slate-500">{t('landing.demoPrevLabel')}</div>
          <div className="mt-0.5 text-xs text-slate-300">{t('landing.demoPrevText')}</div>
        </div>
      </div>

      <button onClick={() => navigate('/login?mode=register')} className="btn-primary mt-5 w-full py-3 text-sm">
        {t('landing.demoCta')}
      </button>
    </div>
  )
}
