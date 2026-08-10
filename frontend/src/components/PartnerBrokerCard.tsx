// 合作券商推广卡：把后台已有的「合作券商锁」三个设置（是否启用 / 展示名 /
// 开户链接）真正用起来。
//
// 背景：brokerReferralUrl 在管理后台能填、后端也随 /bridge/accounts 一起下发，
// 但前端一直没有任何组件渲染它——填了等于没填。同时新用户的默认路径还是
// 「下载桥接程序 → 装在一台不能关机的电脑上」，那是给非合作券商用户准备的
// 兜底方案，却站在了最显眼的位置。
//
// 这张卡把顺序倒过来：先推「用我们的链接开户 → 直连 MT5 → 送 1 个月 PRO」，
// 桥接退到折叠区。两个变体：
//   · full    升级 PRO 页用，完整卖点 + 双 CTA
//   · compact 连接 MT5 页用，只保留一句话和开户按钮（直连表单就在下面，
//             再讲一遍「免安装」是废话）
//
// Partner-broker promo card, which finally renders the three settings the admin
// page has always been able to set (lock on/off, display name, referral URL).
//
// Background: brokerReferralUrl was editable in the admin page and served by
// /bridge/accounts, but no component ever rendered it — setting it did nothing.
// Meanwhile the default path for a new user was still "download the bridge app
// and keep a PC running", which is the fallback for non-partner brokers yet had
// the most prominent placement.
//
// This card inverts that: lead with "open an account through our link → connect
// MT5 directly → get a month of PRO", and demote the bridge into a collapsed
// section. Two variants: `full` for the upgrade page (full pitch, two CTAs) and
// `compact` for the connect page (one line plus the button — repeating "no
// install needed" right above the direct-connect form would be noise).
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { useLive } from '../store/live'

// 后台填的链接会原样进 href。只放行 http(s)：这个字段虽然只有管理员能写，
// 但 `javascript:` 开头的值会变成一次真正的脚本执行，把一处配置失误升级成
// XSS。协议不对就当没配，整张卡不渲染。
// The admin-entered URL goes straight into an href. Allow http(s) only: the
// field is admin-only, but a `javascript:` value would execute as script and
// turn a configuration slip into XSS. A wrong scheme means "not configured" and
// the whole card is skipped.
function safeUrl(raw: string | undefined): string {
  const url = (raw || '').trim()
  return /^https?:\/\//i.test(url) ? url : ''
}

// 合作券商展示信息。displayName 没配时回落到一个中性称呼，而不是硬编码
// "Make Capital"——换券商时后台改一个字段就够了。
// Partner-broker display info. With no displayName configured it falls back to a
// neutral label rather than a hardcoded "Make Capital", so switching brokers is
// a one-field change in the admin page.
export function usePartnerBroker() {
  const { t } = useTranslation()
  const { brokerLock } = useLive()
  return {
    name: (brokerLock?.displayName || '').trim() || t('partner.defaultName'),
    url: safeUrl(brokerLock?.referralUrl),
  }
}

function GiftIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
      <rect x="3" y="8" width="18" height="4" rx="1" />
      <path d="M12 8v13M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
      <path d="M12 8S10.5 3 8 3a2.5 2.5 0 0 0 0 5m4 0s1.5-5 4-5a2.5 2.5 0 0 1 0 5" />
    </svg>
  )
}

function BoltIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
      <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z" />
    </svg>
  )
}

function LayersIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
      <path d="m12 2 9 5-9 5-9-5 9-5z" />
      <path d="m3 12 9 5 9-5M3 17l9 5 9-5" />
    </svg>
  )
}

function ExternalIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <path d="M15 3h6v6M10 14 21 3" />
    </svg>
  )
}

const BULLETS = [
  { key: 'b1', Icon: BoltIcon },
  { key: 'b2', Icon: GiftIcon },
  { key: 'b3', Icon: LayersIcon },
]

export default function PartnerBrokerCard({
  variant = 'full',
  className = '',
}: {
  variant?: 'full' | 'compact'
  className?: string
}) {
  const { t } = useTranslation()
  const { name, url } = usePartnerBroker()

  // 没配开户链接就整张卡不出现。宁可少一块内容，也不要一个点了没反应的
  // 「立即开户」按钮。
  // No referral URL configured → no card at all. Better a missing block than an
  // "Open an account" button that does nothing when clicked.
  if (!url) return null

  // rel 里的 sponsored 是给搜索引擎的声明：这是一条商业合作链接，别把它当
  // 自然推荐计入权重。nofollow 同理，noopener 防新标签页反向操作本页。
  // `sponsored` in rel declares this as a paid/partner link so search engines
  // don't count it as an editorial endorsement; nofollow likewise, and noopener
  // keeps the new tab from touching this page.
  const linkRel = 'noopener noreferrer nofollow sponsored'

  if (variant === 'compact') {
    return (
      <section className={`glass relative overflow-hidden p-5 ring-1 ring-amber-400/25 ${className}`}>
        <div className="pointer-events-none absolute -right-16 -top-16 h-40 w-40 rounded-full bg-amber-400/15 blur-[70px]" />
        <div className="relative flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-[16rem] flex-1">
            <span className="chip bg-amber-400/15 text-amber-200 ring-1 ring-amber-400/30">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-300 animate-breathe" />
              {t('partner.badge')}
            </span>
            <h3 className="mt-3 font-display text-lg font-bold text-slate-50">
              {t('partner.compactTitle', { name })}
            </h3>
            <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-slate-400">
              {t('partner.compactDesc')}
            </p>
          </div>
          <a
            href={url}
            target="_blank"
            rel={linkRel}
            className="btn btn-primary group h-11 shrink-0 px-6 text-sm"
          >
            {t('partner.cta')}
            <span className="transition group-hover:translate-x-0.5"><ExternalIcon /></span>
          </a>
        </div>
        <p className="relative mt-3 text-xs leading-relaxed text-slate-500">
          {t('partner.claimNote')}{' '}
          <Link to="/support" className="text-prism-300 underline-offset-2 transition hover:underline">
            {t('partner.claimCta')} →
          </Link>
        </p>
      </section>
    )
  }

  return (
    <section className={`glass relative overflow-hidden p-6 ring-1 ring-amber-400/25 sm:p-7 ${className}`}>
      {/* 双色光晕：金色点「福利」，紫色把这张卡拉回品牌色系，免得像块广告贴片。
          Two-tone glow: gold reads as "bonus", purple ties the card back to the
          brand palette so it doesn't look like a pasted-in ad. */}
      <div className="pointer-events-none absolute -right-20 -top-24 h-56 w-56 rounded-full bg-amber-400/15 blur-[90px]" />
      <div className="pointer-events-none absolute -bottom-24 -left-20 h-56 w-56 rounded-full bg-prism-600/20 blur-[90px]" />

      <div className="relative text-center sm:text-left">
        <span className="chip bg-amber-400/15 text-amber-200 ring-1 ring-amber-400/30">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-300 animate-breathe" />
          {t('partner.badge')}
        </span>
        <h3 className="mt-4 font-display text-2xl font-black leading-tight tracking-tight text-slate-50 sm:text-[28px]">
          {t('partner.title', { name })}
        </h3>
        <p className="mx-auto mt-3 max-w-2xl text-sm leading-relaxed text-slate-400 sm:mx-0">
          {t('partner.desc', { name })}
        </p>
      </div>

      <ul className="relative mt-6 grid gap-3 sm:grid-cols-3">
        {BULLETS.map(({ key, Icon }) => (
          <li key={key} className="rounded-xl border border-white/10 bg-white/[0.04] p-4 transition hover:border-amber-400/25">
            <div className="flex items-center gap-2 text-amber-200">
              <Icon />
              <span className="font-display text-sm font-semibold text-slate-100">{t(`partner.${key}Title`)}</span>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-slate-400">{t(`partner.${key}Desc`)}</p>
          </li>
        ))}
      </ul>

      <div className="relative mt-6 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
        <a
          href={url}
          target="_blank"
          rel={linkRel}
          className="btn btn-primary group h-12 flex-1 px-6 text-[15px] sm:flex-none"
        >
          {t('partner.cta')}
          <span className="transition group-hover:translate-x-0.5"><ExternalIcon /></span>
        </a>
        <Link to="/bind" className="btn btn-ghost h-12 flex-1 px-6 text-sm sm:flex-none">
          {t('partner.haveAccount')}
        </Link>
        <span className="text-xs leading-relaxed text-slate-500 sm:ml-1">{t('partner.ctaNote', { name })}</span>
      </div>

      <p className="relative mt-5 border-t border-white/10 pt-4 text-xs leading-relaxed text-slate-500">
        {t('partner.claimNote')}{' '}
        <Link to="/support" className="text-prism-300 underline-offset-2 transition hover:underline">
          {t('partner.claimCta')} →
        </Link>
      </p>
    </section>
  )
}
