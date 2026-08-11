// 新用户引导卡：只在「已加载完成、且一个 MT5 账号都没绑」时出现。
//
// 为什么需要：一个刚注册、还没装桥接的人，看到的是仪表盘一堆空卡片、订单页
// 连账户横条都不渲染（activeAccount 为 undefined）、绩效页「数据还不够」。全站
// 唯一解释「下一步该干嘛」的文案，藏在他必须先点开下单弹窗才看得到的地方，而且
// 那段文案还没有链接——他得自己猜「桥接程序」在哪下。
//
// 步骤原本直接复用下载页的 download.g1~g4，也就是「下载安装桥接 → 复制 Token
// → 开着 MT5 → 填 Token」。那是给非合作券商用户准备的兜底路径，却成了每个新
// 用户看到的第一句话——第一步就要求他装一个必须常驻运行的程序，劝退得毫无
// 必要。现在改成合作券商直连的三步（开户 → 填账号密码 → 下单），桥接降级成
// 卡片底部的一行备注。
//
// The steps used to reuse the download page's download.g1~g4 — install the
// bridge, copy the token, keep MT5 open, paste the token. That's the fallback
// path for non-partner brokers, yet it was the first thing every new user read,
// asking them to install an always-on program as step one. It's now the
// three-step direct-connect flow (open an account, enter your login, trade),
// with the bridge demoted to a single footnote line.
//
// New-user onboarding card, shown only once loading has finished and no MT5
// account is bound.
//
// Why: someone who just registered and hasn't installed the bridge sees a
// dashboard of empty cards, an orders page that doesn't even render the account
// bar (activeAccount is undefined), and "not enough data" on performance. The
// only copy in the entire app explaining what to do next is buried behind
// opening the order modal — and it carries no link, so they have to guess where
// "the bridge app" lives.
//
// This card adds no new strings: the three steps reuse the download page's
// existing download.g1~g4, which were written for exactly this and simply never
// appeared anywhere the user reaches first.
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { useLive } from '../store/live'
import { usePartnerBroker } from './PartnerBrokerCard'

export default function OnboardingCard() {
  const { t } = useTranslation()
  const { accounts, loaded, backendUnreachable } = useLive()
  const { name: brokerName, url: brokerUrl } = usePartnerBroker()

  // 后端不可达时不显示：那种情况下 accounts 为空是「取不到」而不是「没有」，
  // 弹一张「去连接 MT5」的引导只会把用户支使去做一件根本不解决问题的事，
  // 而真正的原因（服务挂了）已经由 ConnectionBanner 说清楚了。
  // Hidden while the backend is unreachable: there, an empty accounts list means
  // "couldn't fetch" rather than "none exist", and telling the user to go connect
  // MT5 would send them off doing something that can't help — while the real
  // reason (the service is down) is already stated by ConnectionBanner.
  if (!loaded || backendUnreachable || accounts.length > 0) return null

  // 第一步的按钮是外部开户链接，后两步是站内路由——所以 cta 分成 href / to
  // 两种，而不是硬塞进同一个 <Link>。没配开户链接时第一步就只剩说明文字。
  // Step one's button is an external signup link while the other two are
  // in-app routes, hence separate `href` / `to` fields rather than forcing both
  // through one <Link>. With no referral URL configured, step one is text only.
  const steps: Array<{ title: string; desc: string; to?: string; href?: string; cta?: string }> = [
    {
      title: t('onboarding.s1Title', { name: brokerName }),
      desc: t('onboarding.s1Desc'),
      href: brokerUrl || undefined,
      cta: brokerUrl ? t('partner.cta') : undefined,
    },
    { title: t('onboarding.s2Title'), desc: t('onboarding.s2Desc'), to: '/bind', cta: t('nav.bind') },
    { title: t('onboarding.s3Title'), desc: t('onboarding.s3Desc') },
  ]

  const ctaClass =
    'mt-2 inline-block rounded-lg border border-prism-500/40 bg-prism-600/15 px-2.5 py-1 text-xs font-medium text-prism-200 transition hover:bg-prism-600/25'

  return (
    <section className="glass mb-5 border-prism-500/20 bg-prism-600/[0.06] p-5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="font-display text-base font-semibold text-neutral-100">
          {t('onboarding.title')}
        </h3>
        <p className="text-xs text-neutral-400">{t('onboarding.subtitle')}</p>
      </div>

      <ol className="mt-4 grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-3">
        {steps.map((s, i) => (
          <li key={i} className="flex gap-3">
            <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-prism-500/40 bg-prism-600/15 font-mono text-xs font-semibold text-prism-200">
              {i + 1}
            </span>
            <div className="min-w-0">
              <span className="block text-sm font-medium text-neutral-100">{s.title}</span>
              <span className="mt-1 block text-xs leading-relaxed text-neutral-400">{s.desc}</span>
              {s.href && (
                <a href={s.href} target="_blank" rel="noopener noreferrer nofollow sponsored" className={ctaClass}>
                  {s.cta} →
                </a>
              )}
              {s.to && (
                <Link to={s.to} className={ctaClass}>
                  {s.cta} →
                </Link>
              )}
            </div>
          </li>
        ))}
      </ol>

      {/* 桥接程序：留一行给非合作券商的用户，但不再占据一个步骤位。
          The bridge keeps one line for non-partner-broker users, but no longer
          occupies a numbered step. */}
      <p className="mt-4 border-t border-white/10 pt-3 text-xs leading-relaxed text-neutral-500">
        {t('onboarding.bridgeNote', { name: brokerName })}{' '}
        <Link to="/download" className="text-prism-300 underline-offset-2 transition hover:underline">
          {t('onboarding.bridgeCta')} →
        </Link>
      </p>
    </section>
  )
}
