// 法务文本页：服务条款 / 隐私政策 / 风险披露三份文档共用一个组件。
//
// 为什么三份共用一个组件而不是三个页面文件：三份文档的结构完全相同（标题 +
// 引言 + 若干「小标题 + 段落」+ 联系方式），差别只在内容，而内容全部来自 i18n。
// 拆成三个文件只会把同一份排版抄三遍，以后调一次字号要改三处。
//
// 这三个路由必须**公开可访问**（不在 Protected 之下）：
//   ① 未登录的访客要能在注册前读到条款，这是「注册即视为同意」能成立的前提；
//   ② Google OAuth 的正式验证流程要求提供一个可公开访问的隐私政策 URL，放在
//      登录墙后面会直接卡住验证；
//   ③ 搜索引擎与合规审查方都拿不到 token。
//
// Legal text page: terms of service / privacy policy / risk disclosure share one
// component. They have identical structure (title + intro + a list of
// "heading + paragraphs" + contact), differing only in content, and all content
// comes from i18n — three separate files would just triplicate the same layout
// and turn one type-scale tweak into three edits.
//
// These three routes must be **publicly reachable** (outside Protected):
//   1. a visitor has to be able to read the terms before registering, which is
//      what makes "registering constitutes acceptance" meaningful;
//   2. Google OAuth's verification process requires a publicly accessible
//      privacy-policy URL, and hiding it behind the login wall blocks it;
//   3. neither search engines nor compliance reviewers have a token.
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import AuroraBackground from '../components/AuroraBackground'
import PublicLanguageToggle from '../components/PublicLanguageToggle'
import Logo from '../components/Logo'
import { LEGAL_UPDATED, SUPPORT_EMAIL } from '../config/site'
import { usePublicLang } from '../seo/PublicShell'
import { localePath } from '../seo/meta'

export type LegalDoc = 'terms' | 'privacy' | 'risk'

interface Section {
  h: string
  p: string[]
}

export default function LegalPage({ doc }: { doc: LegalDoc }) {
  const { t } = useTranslation()
  const lang = usePublicLang()

  const title = t(`legal.${doc}.title`)

  // returnObjects 让一个 key 直接返回结构化数组，省掉「sectionCount + 循环拼
  // key」这类需要两处同步的写法——加一节只改 json，不动这个文件。
  // returnObjects returns the structured array from a single key, avoiding a
  // "sectionCount + build key names in a loop" pattern that needs two files kept
  // in sync — adding a section is a json-only change.
  const sections = t(`legal.${doc}.sections`, { returnObjects: true }) as Section[]
  const safeSections = Array.isArray(sections) ? sections : []

  return (
    <div className="relative min-h-[100dvh]">
      <AuroraBackground />

      <header className="relative z-10 border-b border-white/[0.06]">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-5 py-4">
          <Link to={localePath(lang, '/')} className="flex items-center gap-2.5">
            <Logo size={32} />
            <span className="text-sm font-semibold tracking-tight text-neutral-100">Signal Lab</span>
          </Link>
          <div className="ml-auto flex items-center gap-3">
            <PublicLanguageToggle />
            <Link
              to={localePath(lang, '/')}
              className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-neutral-300 transition hover:border-prism-400/40 hover:text-prism-200"
            >
              {t('legal.backHome')}
            </Link>
          </div>
        </div>
      </header>

      <main className="relative z-10 mx-auto max-w-3xl px-5 py-10 sm:py-14">
        <h1 className="font-display text-[clamp(1.75rem,4vw,2.5rem)] font-bold leading-tight text-neutral-50">
          {title}
        </h1>
        <p className="mt-2 text-xs text-neutral-500">
          {t('legal.lastUpdated')} {LEGAL_UPDATED}
        </p>

        <p className="mt-6 text-[15px] leading-relaxed text-neutral-300">{t(`legal.${doc}.intro`)}</p>

        <div className="mt-9 space-y-8">
          {safeSections.map((s, i) => (
            <section key={i}>
              <h2 className="font-display text-lg font-semibold text-neutral-100">
                <span className="mr-2 font-mono text-sm text-prism-400">{i + 1}.</span>
                {s.h}
              </h2>
              <div className="mt-3 space-y-3">
                {s.p.map((para, j) => (
                  <p key={j} className="text-[14.5px] leading-relaxed text-neutral-400">
                    {para}
                  </p>
                ))}
              </div>
            </section>
          ))}
        </div>

        {/* 联系方式独立成块并放在最后：三份文档都以「有疑问找谁」收尾，读者读到
            末尾正是最可能有疑问的时刻。邮箱来自常量而不是译文，见 config/site.ts。
            SUPPORT_EMAIL 留空时整块不渲染——与其给出一个收不到信的地址，不如先
            不给。译文键保留在 i18n 里，填回地址即自动恢复。
            Contact is its own block at the end: all three documents close with
            "who to ask", which is exactly when a reader is most likely to have a
            question. The address comes from a constant, not a translation — see
            config/site.ts. With SUPPORT_EMAIL empty the whole block is skipped:
            better no address than one that can't receive mail. The translations
            stay in i18n, so restoring the address restores the block. */}
        {SUPPORT_EMAIL && (
          <section className="mt-12 rounded-xl border border-white/10 bg-white/[0.03] p-5">
            <h2 className="font-display text-base font-semibold text-neutral-100">
              {t('legal.contactTitle')}
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-neutral-400">{t('legal.contactBody')}</p>
            <a
              href={`mailto:${SUPPORT_EMAIL}`}
              className="mt-3 inline-block font-mono text-sm text-prism-300 underline underline-offset-4 transition hover:text-prism-200"
            >
              {SUPPORT_EMAIL}
            </a>
          </section>
        )}

        <nav className="mt-10 flex flex-wrap gap-x-6 gap-y-2 border-t border-white/[0.06] pt-6 text-sm">
          {(['terms', 'privacy', 'risk'] as LegalDoc[])
            .filter((d) => d !== doc)
            .map((d) => (
              <Link
                key={d}
                to={localePath(lang, `/${d}`)}
                className="text-neutral-400 transition hover:text-prism-300"
              >
                {t(`legal.${d}.title`)}
              </Link>
            ))}
        </nav>
      </main>
    </div>
  )
}
