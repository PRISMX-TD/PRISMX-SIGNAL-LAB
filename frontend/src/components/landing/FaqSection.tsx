// 常见问题：原生 <details>/<summary> 手风琴，无需 JS 状态
// FAQ accordion built on native <details>/<summary>, no JS state needed
//
// 此前九个问题是九张独立的玻璃卡，卡与卡之间还有 12px 间隙。九个悬浮容器叠在
// 一起既没有表达任何层级（它们是同一份清单里的九个平级条目），又把一段本该
// 安静的收尾内容做成了页面上最吵的一块。现在改成单一列表 + 逐行发丝线：
// 容器只剩一个，条目靠分隔线区分，视觉重量降到与内容重要性相称。
//
// The nine questions used to be nine separate glass cards with 12px gaps. Nine
// floating containers expressed no hierarchy at all (they are nine peer items in
// one list) while making a section that should read quietly the loudest block on
// the page. It is now a single list with per-row hairlines: one container,
// separators doing the dividing, and visual weight proportional to importance.
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { usePublicLang } from '../../seo/PublicShell'
import { localePath } from '../../seo/meta'

const FAQ_IDS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const

export default function FaqSection() {
  const { t } = useTranslation()
  const lang = usePublicLang()

  return (
    <section id="faq" className="mx-auto w-full max-w-[1240px] scroll-mt-24 px-5 py-20 sm:px-8 sm:py-28">
      <div className="grid grid-cols-1 gap-12 lg:grid-cols-12 lg:gap-8">
        <div className="lg:col-span-4">
          <h2 className="font-display-xl text-[clamp(1.75rem,3.6vw,2.75rem)] text-white">{t('landing.faqTitle')}</h2>
        </div>

        <div className="lg:col-span-7 lg:col-start-6">
          <div className="border-t border-white/[0.07]">
            {FAQ_IDS.map((n) => (
              <details key={n} className="group border-b border-white/[0.07]">
                <summary className="flex cursor-pointer list-none items-start justify-between gap-6 py-5 text-[14.5px] font-medium leading-snug text-neutral-200 transition-colors marker:content-none hover:text-white [&::-webkit-details-marker]:hidden">
                  <span>{t(`landing.faq${n}q`)}</span>
                  {/* 加号旋转 45° 变叉：一个字符承担开合两种状态，比换图标少一次
                      重排，也比箭头旋转更明确地表达「关闭」。
                      A plus rotating 45° into a cross: one glyph covering both
                      states costs less layout than swapping icons and reads as
                      "close" more explicitly than a rotating chevron. */}
                  <span className="mt-0.5 shrink-0 text-[18px] leading-none text-neutral-500 transition-transform duration-200 group-open:rotate-45">
                    +
                  </span>
                </summary>
                <p className="max-w-[62ch] pb-6 pr-10 text-[13.5px] leading-relaxed text-neutral-400">
                  {t(`landing.faq${n}a`)}
                </p>
              </details>
            ))}
          </div>

          <Link
            to={localePath(lang, '/faq')}
            className="mt-5 inline-block py-2.5 text-[13.5px] text-prism-400 underline underline-offset-4 transition-colors hover:text-prism-300"
          >
            {t('landing.faqViewAll')}
          </Link>
        </div>
      </div>
    </section>
  )
}
