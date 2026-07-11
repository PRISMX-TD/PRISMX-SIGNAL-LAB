// 信号群 vs PRISMX 对比区：把行业乱象逐条做成我们的反义词。
// signal-group vs PRISMX comparison: the industry's dark patterns, each turned into our feature.
import { useTranslation } from 'react-i18next'

const ROWS = [1, 2, 3, 4, 5] as const

export default function ComparisonSection() {
  const { t } = useTranslation()

  return (
    <section id="compare" className="mx-auto max-w-7xl scroll-mt-20 px-4 py-20 sm:px-6">
      <div className="reveal mb-12 text-center">
        <span className="eyebrow">{t('landing.cmpEyebrow')}</span>
        <h2 className="mt-3 font-display text-3xl font-bold text-slate-50 sm:text-4xl">{t('landing.cmpTitle')}</h2>
        <p className="mx-auto mt-3 max-w-xl text-slate-400">{t('landing.cmpSubtitle')}</p>
      </div>

      <div className="reveal glass mx-auto max-w-5xl overflow-hidden">
        {/* 表头（桌面）/ header row (desktop) */}
        <div className="hidden grid-cols-2 md:grid">
          <div className="px-6 py-4 text-sm font-bold uppercase tracking-widest text-slate-500">
            {t('landing.cmpThem')}
          </div>
          <div className="border-l border-white/10 bg-prism-600/[0.07] px-6 py-4 text-sm font-bold uppercase tracking-widest text-prism-300">
            {t('landing.cmpUs')}
          </div>
        </div>

        {ROWS.map((n) => (
          <div key={n} className="grid grid-cols-1 border-t border-white/[0.06] md:grid-cols-2">
            <div className="flex items-start gap-3 px-6 py-5">
              <span className="mt-0.5 shrink-0 text-sm font-bold" style={{ color: 'var(--down)' }}>✗</span>
              <div className="min-w-0">
                <div className="mb-1 text-[10px] font-bold uppercase tracking-widest text-slate-600 md:hidden">
                  {t('landing.cmpThem')}
                </div>
                <p className="text-sm leading-relaxed text-slate-400">{t(`landing.cmpBad${n}`)}</p>
              </div>
            </div>
            <div className="flex items-start gap-3 border-t border-white/[0.06] bg-prism-600/[0.07] px-6 py-5 md:border-l md:border-t-0">
              <span className="mt-0.5 shrink-0 text-sm font-bold" style={{ color: 'var(--up)' }}>✓</span>
              <div className="min-w-0">
                <div className="mb-1 text-[10px] font-bold uppercase tracking-widest text-prism-400 md:hidden">
                  {t('landing.cmpUs')}
                </div>
                <p className="text-sm leading-relaxed text-slate-200">{t(`landing.cmpGood${n}`)}</p>
              </div>
            </div>
          </div>
        ))}
      </div>

      <p className="reveal mx-auto mt-6 max-w-3xl text-center text-xs leading-relaxed text-slate-600">
        {t('landing.cmpNote')}
      </p>
    </section>
  )
}
