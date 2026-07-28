// 新用户引导卡：只在「已加载完成、且一个 MT5 账号都没绑」时出现。
//
// 为什么需要：一个刚注册、还没装桥接的人，看到的是仪表盘一堆空卡片、订单页
// 连账户横条都不渲染（activeAccount 为 undefined）、绩效页「数据还不够」。全站
// 唯一解释「下一步该干嘛」的文案，藏在他必须先点开下单弹窗才看得到的地方，而且
// 那段文案还没有链接——他得自己猜「桥接程序」在哪下。
//
// 这张卡不新增任何文案：三步说明直接复用下载页已有的 download.g1~g4，那几句
// 本来就是为这件事写的，只是从来没出现在用户会先到的地方。
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

export default function OnboardingCard() {
  const { t } = useTranslation()
  const { accounts, loaded, backendUnreachable } = useLive()

  // 后端不可达时不显示：那种情况下 accounts 为空是「取不到」而不是「没有」，
  // 弹一张「去连接 MT5」的引导只会把用户支使去做一件根本不解决问题的事，
  // 而真正的原因（服务挂了）已经由 ConnectionBanner 说清楚了。
  // Hidden while the backend is unreachable: there, an empty accounts list means
  // "couldn't fetch" rather than "none exist", and telling the user to go connect
  // MT5 would send them off doing something that can't help — while the real
  // reason (the service is down) is already stated by ConnectionBanner.
  if (!loaded || backendUnreachable || accounts.length > 0) return null

  const steps = [
    { title: t('download.g1Title'), desc: t('download.g1Desc'), to: '/download', cta: t('nav.download') },
    { title: t('download.g2Title'), desc: t('download.g2Desc'), to: '/bind', cta: t('nav.bind') },
    { title: t('download.g3Title'), desc: t('download.g3Desc'), to: null, cta: null },
    { title: t('download.g4Title'), desc: t('download.g4Desc'), to: null, cta: null },
  ]

  return (
    <section className="glass mb-5 border-prism-500/20 bg-prism-600/[0.06] p-5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="font-display text-base font-semibold text-slate-100">
          {t('onboarding.title')}
        </h3>
        <p className="text-xs text-slate-400">{t('onboarding.subtitle')}</p>
      </div>

      <ol className="mt-4 grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
        {steps.map((s, i) => (
          <li key={i} className="flex gap-3">
            <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-prism-500/40 bg-prism-600/15 font-mono text-xs font-semibold text-prism-200">
              {i + 1}
            </span>
            <div className="min-w-0">
              {/* 步骤标题里本来就带着「1. 」「2. 」这样的序号（下载页原样使用），
                  这里已经有圆圈编号了，去掉重复的前缀免得读成「1. 1. 下载并安装」。
                  The step titles already start with "1. ", "2. " (as used on the
                  download page); with the numbered circle here, strip the
                  duplicate prefix so it doesn't read "1. 1. Download and install". */}
              <span className="block text-sm font-medium text-slate-100">
                {s.title.replace(/^\s*\d+[.、]\s*/, '')}
              </span>
              <span className="mt-1 block text-xs leading-relaxed text-slate-400">{s.desc}</span>
              {s.to && (
                <Link
                  to={s.to}
                  className="mt-2 inline-block rounded-lg border border-prism-500/40 bg-prism-600/15 px-2.5 py-1 text-xs font-medium text-prism-200 transition hover:bg-prism-600/25"
                >
                  {s.cta} →
                </Link>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  )
}
