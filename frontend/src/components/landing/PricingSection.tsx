// 定价区：FREE（监督员身份）vs PRO（全部火力）；价格实时拉取，失败回退静态值。
// pricing: FREE (auditor tier) vs PRO (full firepower); live prices with static fallback.
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { paymentApi } from '../../api/client'

function Check() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  )
}

export default function PricingSection() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [monthly, setMonthly] = useState(49)
  const [yearly, setYearly] = useState(470)
  const [saleBadge, setSaleBadge] = useState<string | null>(null)

  useEffect(() => {
    paymentApi
      .getPlans()
      .then((r) => {
        const m = r.plans.find((p) => p.days === 30)
        const y = r.plans.find((p) => p.days === 365)
        if (m) setMonthly(m.price_usd)
        if (y) setYearly(y.price_usd)
        if (r.sale?.badge) setSaleBadge(`${r.sale.badge} · ${r.sale.percent}% OFF`)
      })
      .catch(() => {})
  }, [])

  const freeFeats = [1, 2, 3, 4] as const
  const proFeats = [1, 2, 3, 4, 5, 6, 7] as const

  return (
    <section id="pricing" className="mx-auto max-w-7xl scroll-mt-20 px-4 py-20 sm:px-6">
      <div className="reveal mb-12 text-center">
        <span className="eyebrow">{t('landing.prEyebrow')}</span>
        <h2 className="mt-3 font-display text-3xl font-bold text-slate-50 sm:text-4xl">{t('landing.prTitle')}</h2>
        <p className="mx-auto mt-3 max-w-xl text-slate-400">{t('landing.prSubtitle')}</p>
        {saleBadge && (
          <span className="chip mt-4" style={{ background: 'rgba(139,92,246,0.18)', color: 'var(--purple-hi)', border: '1px solid rgba(139,92,246,0.4)' }}>
            {saleBadge}
          </span>
        )}
      </div>

      <div className="mx-auto grid max-w-4xl grid-cols-1 gap-5 md:grid-cols-2">
        {/* FREE：监督员身份 / the auditor tier */}
        <div className="reveal glass flex flex-col p-7">
          <div className="flex items-center justify-between">
            <span className="font-display text-lg font-bold text-slate-200">{t('landing.prFreeName')}</span>
            <span className="chip dim">{t('landing.prFreeTag')}</span>
          </div>
          <div className="mt-4">
            <span className="font-display text-5xl font-black text-slate-100">$0</span>
          </div>
          <div className="my-5 h-px bg-white/10" />
          <ul className="flex flex-col gap-3">
            {freeFeats.map((n) => (
              <li key={n} className="flex items-start gap-3 text-sm text-slate-400">
                <span className="mt-0.5 flex h-5 w-5 flex-none items-center justify-center rounded-full bg-white/5 text-slate-500">
                  <Check />
                </span>
                {t(`landing.prFreeF${n}`)}
              </li>
            ))}
          </ul>
        </div>

        {/* PRO：高亮卡 / highlighted card */}
        <div className="reveal reveal-d1 glass-neon relative flex flex-col overflow-hidden p-7 ring-1 ring-prism-500/40">
          <div className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-prism-600/25 blur-[90px]" />
          <div className="relative flex items-center justify-between">
            <span className="font-display text-lg font-bold text-prism-200">{t('landing.prProName')}</span>
            <span className="chip" style={{ background: 'rgba(139,92,246,0.2)', color: 'var(--purple-hi)', border: '1px solid rgba(139,92,246,0.4)' }}>
              {t('landing.prProTag')}
            </span>
          </div>
          <div className="relative mt-4 flex items-baseline gap-2">
            <span className="font-display text-5xl font-black text-white">${monthly}</span>
            <span className="text-sm text-slate-400">{t('landing.prMo')}</span>
          </div>
          <p className="relative mt-1.5 text-sm text-prism-300">
            {t('landing.prYrHint', { yearly, permo: Math.round(yearly / 12) })}
          </p>
          <div className="relative my-5 h-px bg-prism-500/20" />
          <ul className="relative flex flex-col gap-3">
            {proFeats.map((n) => (
              <li key={n} className="flex items-start gap-3 text-sm text-slate-200">
                <span className="mt-0.5 flex h-5 w-5 flex-none items-center justify-center rounded-full bg-prism-600/25 text-prism-300 ring-1 ring-prism-500/40">
                  <Check />
                </span>
                {t(`landing.prProF${n}`)}
              </li>
            ))}
          </ul>
          <button onClick={() => navigate('/login?mode=register')} className="btn-primary relative mt-7 w-full py-3 text-sm">
            {t('landing.prCta')}
          </button>
        </div>
      </div>

      <p className="reveal mx-auto mt-6 max-w-2xl text-center text-xs leading-relaxed text-slate-500">
        {t('landing.prNote')}
      </p>
    </section>
  )
}
