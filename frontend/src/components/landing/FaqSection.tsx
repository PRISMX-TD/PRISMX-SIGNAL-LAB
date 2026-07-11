// 常见问题：原生 <details>/<summary> 手风琴，无需 JS 状态
// FAQ accordion built on native <details>/<summary>, no JS state needed
import { useTranslation } from 'react-i18next'

const FAQ_IDS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const

export default function FaqSection() {
  const { t } = useTranslation()

  return (
    <section id="faq" className="mx-auto max-w-7xl scroll-mt-20 px-4 py-20 sm:px-6">
      <div className="reveal mb-12 text-center">
        <span className="eyebrow">{t('landing.faqEyebrow')}</span>
        <h2 className="mt-3 font-display text-3xl font-bold text-slate-50 sm:text-4xl">{t('landing.faqTitle')}</h2>
      </div>
      <div className="mx-auto max-w-3xl">
        {FAQ_IDS.map((n) => (
          <details key={n} className="glass group mb-3 p-0">
            <summary className="flex list-none cursor-pointer items-center justify-between gap-3 px-6 py-4 font-medium text-slate-100 marker:content-none [&::-webkit-details-marker]:hidden">
              <span>{t(`landing.faq${n}q`)}</span>
              <span className="shrink-0 text-xl leading-none text-prism-400 transition-transform duration-200 group-open:rotate-45">+</span>
            </summary>
            <p className="px-6 pb-5 text-sm leading-relaxed text-slate-400">{t(`landing.faq${n}a`)}</p>
          </details>
        ))}
      </div>
    </section>
  )
}
