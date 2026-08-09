// FAQ 独立页：/faq 与 /en/faq。结构对 SEO 负责：<h1> + 每问一个 <h2>，
// 答案直接可见（刻意不做折叠——预渲染 HTML 的全文对爬虫可见，且必须与
// 注入的 FAQPage JSON-LD 一字不差）。版式与法务页一致。
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import AuroraBackground from '../components/AuroraBackground'
import PublicLanguageToggle from '../components/PublicLanguageToggle'
import Logo from '../components/Logo'
import { usePublicLang } from '../seo/PublicShell'
import { localePath } from '../seo/meta'
import { FAQ_KEYS } from '../seo/faqContent'

export default function FaqPage() {
  const { t } = useTranslation()
  const lang = usePublicLang()

  return (
    <div className="relative min-h-screen">
      <AuroraBackground />

      <header className="relative z-10 border-b border-white/[0.06]">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-5 py-4">
          <Link to={localePath(lang, '/')} className="flex items-center gap-2.5">
            <Logo size={32} />
            <span className="text-sm font-semibold tracking-tight text-slate-100">Signal Lab</span>
          </Link>
          <div className="ml-auto flex items-center gap-3">
            <PublicLanguageToggle />
            <Link
              to={localePath(lang, '/')}
              className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-300 transition hover:border-prism-400/40 hover:text-prism-200"
            >
              {t('legal.backHome')}
            </Link>
          </div>
        </div>
      </header>

      <main className="relative z-10 mx-auto max-w-3xl px-5 py-10 sm:py-14">
        <h1 className="font-display text-[clamp(1.75rem,4vw,2.5rem)] font-bold leading-tight text-slate-50">
          {t('faqPage.title')}
        </h1>
        <p className="mt-6 text-[15px] leading-relaxed text-slate-300">{t('faqPage.intro')}</p>

        <div className="mt-9 space-y-8">
          {FAQ_KEYS.map((k, i) => (
            <section key={k.q}>
              <h2 className="font-display text-lg font-semibold text-slate-100">
                <span className="mr-2 font-mono text-sm text-prism-400">{i + 1}.</span>
                {t(k.q)}
              </h2>
              <p className="mt-3 text-[14.5px] leading-relaxed text-slate-400">{t(k.a)}</p>
            </section>
          ))}
        </div>

        <nav className="mt-10 flex flex-wrap gap-x-6 gap-y-2 border-t border-white/[0.06] pt-6 text-sm">
          {(['terms', 'privacy', 'risk'] as const).map((d) => (
            <Link key={d} to={localePath(lang, `/${d}`)} className="text-slate-400 transition hover:text-prism-300">
              {t(`legal.${d}.title`)}
            </Link>
          ))}
        </nav>
      </main>
    </div>
  )
}
