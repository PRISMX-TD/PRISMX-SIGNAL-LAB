// 顶栏通知铃铛：常驻展示通知状态 + 主开关快捷入口，详细的策略/品种/事件筛选
// 仍留在账户页，这里只放"够用又不打乱布局"的一小块。
// Top-bar notification bell: an always-visible status indicator plus a quick
// master-switch entry point. Detailed strategy/symbol/event filtering stays
// on the account page — this only holds the small slice that's "enough
// without disrupting layout".
import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Link } from "react-router-dom"
import { notificationApi } from "../api/client"
import { pushSupported } from "../utils/push"
import { disableNotifications, enableNotifications, ENABLE_ERROR_KEYS, NotifEnableError } from "../utils/notifications"

type Status = "off" | "on" | "attention"

export default function NotificationBell() {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [enabled, setEnabled] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)

  const refresh = () => {
    notificationApi
      .getPrefs()
      .then((p) => setEnabled(p.enabled))
      .catch(() => {})
      .finally(() => setLoaded(true))
  }

  useEffect(() => {
    refresh()
  }, [])

  // 面板打开时：点击外部关闭 / close on outside click while the panel is open
  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onClick)
    return () => document.removeEventListener("mousedown", onClick)
  }, [open])

  const deviceOk =
    pushSupported() && typeof Notification !== "undefined" && Notification.permission === "granted"
  const status: Status = !enabled ? "off" : deviceOk ? "on" : "attention"

  async function handleToggle(on: boolean) {
    setErr(null)
    setBusy(true)
    try {
      if (!on) {
        setEnabled(false)
        await disableNotifications()
      } else {
        // 主开关的落库是整体覆盖，取当前完整偏好再原样带上，避免把用户已选的
        // 策略/品种/事件筛选清空。这一步网络请求必须放在 enableNotifications
        // 内部、权限申请之后才做——放在权限申请之前会在权限调用前插入一次
        // await，iOS Safari 会因此不弹出系统权限框（见 enableNotifications 注释）。
        // The prefs PUT overwrites the whole object — fetch the current full
        // prefs and carry them through so this quick toggle doesn't blank out
        // whatever strategy/symbol/event filters the user already picked. This
        // fetch must happen inside enableNotifications, after the permission
        // request — doing it beforehand inserts an await ahead of the
        // permission call, which keeps iOS Safari from showing the system
        // permission sheet at all (see enableNotifications' comment).
        await enableNotifications(() =>
          notificationApi.getPrefs().then((prefs) => ({
            selected_categories: prefs.selected_categories,
            selected_symbols: prefs.selected_symbols,
            event_types: prefs.event_types,
          })),
        )
        setEnabled(true)
      }
    } catch (e: unknown) {
      setEnabled(!on)
      setErr(e instanceof NotifEnableError ? t(ENABLE_ERROR_KEYS[e.reason]) : t("account.notifError"))
    } finally {
      setBusy(false)
    }
  }

  const dotClass =
    status === "attention" ? "bg-amber-400" : status === "on" ? "bg-prism-400" : "bg-transparent"
  const iconClass =
    status === "attention" ? "text-amber-400" : status === "on" ? "text-prism-300" : "text-slate-400"

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={t("notifPanel.title")}
        className={`relative rounded-lg border border-white/10 bg-white/[0.04] p-2 transition hover:text-slate-100 ${iconClass}`}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {status !== "off" && (
          <span className={`absolute right-1 top-1 h-2 w-2 rounded-full ${dotClass}`} />
        )}
      </button>

      {open && (
        // 铃铛在头部右侧一组图标里并不是最靠右的那个（语言切换、退出登录还在它
        // 右边），"贴右边缘"的 right-0 只是相对铃铛自己这个 40px 宽的容器，不是
        // 相对屏幕——288px 宽的面板会整体往左边探出容器，在手机宽度下直接探出
        // 屏幕左边。窄屏（<sm）改用 fixed + 左右内边距，与铃铛位置无关，永远贴着
        // 屏幕内侧；sm 及以上视口更宽，退回原来贴按钮右边缘的样式。
        // The bell isn't the rightmost icon in the header's right-hand cluster
        // (language toggle and logout sit to its right), so "hug the right
        // edge" via right-0 is relative to the bell's own ~40px wrapper, not
        // the screen — a 288px panel spills leftward past that wrapper, which
        // runs off the left edge of the screen on phone widths. Below sm, use
        // fixed positioning with side insets instead, independent of where the
        // bell sits, always flush inside the viewport; sm and up revert to the
        // original button-anchored dropdown where there's room to spare.
        <div className="fixed inset-x-3 top-[60px] z-40 rounded-xl border border-white/10 bg-ink-900/95 p-4 shadow-prism backdrop-blur-xl sm:absolute sm:inset-x-auto sm:top-auto sm:right-0 sm:mt-2 sm:w-72">
          <div className="text-sm font-bold text-white">{t("notifPanel.title")}</div>

          <div className="mt-3 flex items-center gap-3">
            <label className="relative inline-flex cursor-pointer items-center">
              <input
                type="checkbox"
                checked={enabled}
                disabled={!loaded || busy}
                onChange={(e) => handleToggle(e.target.checked)}
                className="peer sr-only"
              />
              <div className="h-6 w-11 rounded-full bg-white/10 transition peer-checked:bg-prism-500 peer-disabled:opacity-60" />
              <div className="absolute left-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-white shadow transition peer-checked:translate-x-5">
                {busy && <span className="h-3 w-3 animate-spin rounded-full border-2 border-prism-500/40 border-t-prism-600" />}
              </div>
            </label>
            <span className="text-sm text-slate-100">{t("account.notifEnable")}</span>
          </div>

          {status === "attention" && (
            <p className="mt-2 text-xs leading-relaxed text-amber-400">
              {pushSupported() ? t("account.notifDeviceHint") : t("account.notifUnsupported")}
            </p>
          )}
          {err && <p className="mt-2 text-xs leading-relaxed text-down">{err}</p>}

          <Link
            to="/account#notifications"
            onClick={() => setOpen(false)}
            className="mt-3 inline-block text-xs font-medium text-prism-400 underline hover:text-prism-300"
          >
            {t("notifPanel.fullSettings")}
          </Link>
        </div>
      )}
    </div>
  )
}
