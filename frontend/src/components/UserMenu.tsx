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
  onLogout,
}: {
  email: string | undefined
  showUpgrade: boolean
  isAdmin: boolean
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
    "block rounded-lg px-3 py-2 text-sm text-slate-300 transition hover:bg-white/5 hover:text-slate-100"

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
            <div className="truncate px-3 py-2 text-xs text-slate-500">{email}</div>
          )}
          <Link to="/account" onClick={() => setOpen(false)} className={linkClass}>
            {t("nav.account")}
          </Link>
          {isAdmin && (
            <Link to="/strategies" onClick={() => setOpen(false)} className={linkClass}>
              {t("nav.strategies")}
            </Link>
          )}
          <Link to="/download" onClick={() => setOpen(false)} className={linkClass}>
            {t("nav.download")}
          </Link>
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
