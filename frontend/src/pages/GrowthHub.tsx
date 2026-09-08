// 「成长」外壳：成就（等级勋章）/ 排行榜 / 交易比赛 三页共用的一个页头 + 页签。
//
// 2026-09-07 起顶栏只留一个「成长」入口，三页各自的路由（/achievements、
// /leaderboard、/competitions）全部保留，只是都套进这个壳里、由 tab 决定高亮
// 哪个页签——站内既有链接（用户菜单的等级药丸、仪表盘胜率卡）一条不用改。
// 三页原来各自的页标题已撤掉，否则会出现「壳标题 + 页签 + 页内标题」三层。
//
// 页签按三个内测开关各自显隐（与 Layout / UserMenu 的入口门控同一套判断）；
// 直接打 URL 进了一个开关未开的页，页面自己会退化成一条内测提示（各页的
// forbidden 分支），这里不拦。不足两个可见页签时不画页签条。
//
// The "Growth" shell: one header + one tab strip shared by achievements (level &
// badges), leaderboard and competitions. Since 2026-09-07 the top nav carries a
// single "Growth" entry; the three routes are kept as-is and simply render
// inside this shell, with `tab` picking the highlighted segment — so no
// existing in-app link (user-menu level chip, dashboard win-rate card) had to
// change. The pages' own titles were removed to avoid a three-deep
// shell-title / tabs / page-title stack.
//
// Tabs show or hide per the three beta switches (the same checks Layout /
// UserMenu use for entry points); a direct URL into a switched-off page is
// left to that page's own forbidden branch. Fewer than two visible tabs → no
// tab strip.
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useAuth } from '../store/auth'
import PageHead from '../components/PageHead'

export type GrowthTab = 'achievements' | 'leaderboard' | 'competitions'

const TABS: { key: GrowthTab; to: string; labelKey: string; flag: 'gamificationVisible' | 'leaderboardVisible' | 'competitionsVisible' }[] = [
  { key: 'achievements', to: '/achievements', labelKey: 'nav.growthBadges', flag: 'gamificationVisible' },
  { key: 'leaderboard', to: '/leaderboard', labelKey: 'leaderboard.title', flag: 'leaderboardVisible' },
  { key: 'competitions', to: '/competitions', labelKey: 'competition.title', flag: 'competitionsVisible' },
]

export default function GrowthHub({ tab, children }: { tab: GrowthTab; children: ReactNode }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { user } = useAuth()
  // 当前页即便开关未开也保留在页签里——否则用户明明在这一页，页签条却没有
  // 一个是亮的。The current page stays in the strip even when its switch is
  // off; otherwise the user is on a page no tab lights up for.
  const visible = TABS.filter((x) => x.key === tab || !!user?.[x.flag])

  return (
    <div className="mx-auto max-w-[1100px]">
      <PageHead
        as="h1"
        title={t('nav.growth')}
        actions={visible.length > 1 ? (
          <div className="seg-tabs w-full sm:w-fit" role="tablist" aria-label={t('nav.growth')}>
            {visible.map((x) => (
              <button
                key={x.key}
                type="button"
                role="tab"
                aria-selected={x.key === tab}
                onClick={() => {
                  if (x.key !== tab) navigate(x.to)
                }}
                className={`flex-1 sm:flex-none ${x.key === tab ? 'on' : ''}`}
              >
                {t(x.labelKey)}
              </button>
            ))}
          </div>
        ) : undefined}
      />
      {children}
    </div>
  )
}
