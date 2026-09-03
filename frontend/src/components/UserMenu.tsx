// 用户菜单：头部右侧只放一个头像入口，账户/下载桥接/升级/管理页/退出这些
// 低频项收进下拉，腾出空间给高频导航——英文标签普遍比中文长，不收进来的话
// 桌面导航栏在英文下很容易挤到超出屏幕。
// User menu: the header's right side gets a single avatar entry point;
// low-frequency items (account, download bridge, upgrade, admin, logout)
// collapse into a dropdown, freeing room for the high-frequency nav — English
// labels run longer than Chinese ones, so without this the desktop nav
// overflows the viewport in English.
import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Link } from "react-router-dom"
import { useBackToClose } from "../utils/useBackToClose"

export default function UserMenu({
  email,
  showUpgrade,
  isAdmin,
  gamificationVisible,
  leaderboardVisible,
  competitionsVisible,
  gamificationLevel,
  gamificationTitle,
  onLogout,
}: {
  email: string | undefined
  showUpgrade: boolean
  isAdmin: boolean
  gamificationVisible: boolean
  leaderboardVisible: boolean
  competitionsVisible: boolean
  // 等级/称号：随 /auth/me 一起下发（见 store/auth.tsx refreshUser），角标
  // 只在两者都有值时渲染——gamificationVisible 为假时后端本就不算，值是 null。
  // Level/title: delivered alongside /auth/me (see store/auth.tsx
  // refreshUser); the badge renders only when both are present — the backend
  // leaves them null whenever gamificationVisible is false for this user.
  gamificationLevel?: number | null
  gamificationTitle?: string | null
  onLogout: () => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  // 头部下拉不是全屏遮罩，但同样应该让划返回先收起菜单，而不是直接离开页面
  // （见 useBackToClose 的说明；NotificationBell 也是同样处理）。
  // The header dropdown isn't a full-screen overlay either, but swiping back
  // should still close the menu first rather than leaving the page (see
  // useBackToClose's comment; NotificationBell gets the same treatment).
  useBackToClose(open, () => setOpen(false))
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onClick)
    return () => document.removeEventListener("mousedown", onClick)
  }, [open])

  const initial = email?.trim()?.[0]?.toUpperCase() || "?"

  const linkClass =
    "block rounded-lg px-3 py-2 text-sm text-neutral-300 transition hover:bg-white/5 hover:text-neutral-100"

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={t("nav.account")}
        className="flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-prism-600/20 text-sm font-semibold text-prism-200 transition hover:bg-prism-600/30"
      >
        {initial}
      </button>

      {open && (
        <div className="absolute right-0 z-40 mt-2 w-64 rounded-xl border border-white/10 bg-ink-900/95 p-2 shadow-prism backdrop-blur-xl">
          {email && (
            <div className="truncate px-3 py-2 text-xs text-neutral-500">{email}</div>
          )}
          {/* 等级/称号角标（设计 §7）：随 /auth/me 一起下发，不必为它多发一次
              请求——见上面 props 的注释和 store/auth.tsx refreshUser()。点进去
              就是成就页，同下面的成就入口一致。
              Level/title chip (design §7): delivered alongside /auth/me, no
              extra request needed for it — see the props comment above and
              store/auth.tsx refreshUser(). Links to the achievements page,
              same destination as the achievements entry below. */}
          {gamificationVisible && gamificationLevel != null && (
            <Link
              to="/achievements"
              onClick={() => setOpen(false)}
              className="mx-3 mb-1 mt-0.5 flex w-fit"
            >
              <span className="tag bg-prism-600/20 text-xs text-prism-300">
                L{gamificationLevel}
                {gamificationTitle ? ` · ${t(`gamification.titles.${gamificationTitle}`)}` : ""}
              </span>
            </Link>
          )}
          <Link to="/account" onClick={() => setOpen(false)} className={linkClass}>
            {t("nav.account")}
          </Link>
          <Link to="/bind" onClick={() => setOpen(false)} className={linkClass}>
            {t("nav.bind")}
          </Link>
          <Link to="/download" onClick={() => setOpen(false)} className={linkClass}>
            {t("nav.download")}
          </Link>
          <Link to="/support" onClick={() => setOpen(false)} className={linkClass}>
            {t("nav.support")}
          </Link>
          {/* 成就页：入口按 gamificationVisible 门控，理由同 Layout.tsx「其他」
              抽屉的同名判断。
              Achievements: gated on gamificationVisible, same rationale as the
              "more" drawer's matching check in Layout.tsx. */}
          {gamificationVisible && (
            <Link to="/achievements" onClick={() => setOpen(false)} className={linkClass}>
              {t("gamification.title")}
            </Link>
          )}
          {/* 排行榜：独立于 gamificationVisible 的另一个内测开关，理由同上一条。
              Leaderboard: gated on its own beta switch, same rationale as the
              achievements link above. */}
          {leaderboardVisible && (
            <Link to="/leaderboard" onClick={() => setOpen(false)} className={linkClass}>
              {t("leaderboard.title")}
            </Link>
          )}
          {/* 比赛：又一个独立于 gamificationVisible/leaderboardVisible 的内测开关，
              理由同上两条。
              Competitions: another beta switch independent of
              gamificationVisible/leaderboardVisible, same rationale as the two
              links above. */}
          {competitionsVisible && (
            <Link to="/competitions" onClick={() => setOpen(false)} className={linkClass}>
              {t("competition.title")}
            </Link>
          )}
          {showUpgrade && (
            <Link to="/upgrade" onClick={() => setOpen(false)} className={`${linkClass} text-prism-300`}>
              {t("nav.upgrade")}
            </Link>
          )}
          {isAdmin && (
            <Link to="/admin" onClick={() => setOpen(false)} className={linkClass}>
              {t("nav.admin")}
            </Link>
          )}
          <div className="my-1 border-t border-white/5" />
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              onLogout()
            }}
            className="block w-full rounded-lg px-3 py-2 text-left text-sm text-down transition hover:bg-white/5"
          >
            {t("nav.logout")}
          </button>
        </div>
      )}
    </div>
  )
}
