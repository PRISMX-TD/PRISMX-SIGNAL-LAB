// 仪表盘顶部提示条：仅在通知已在账号层面开启、但"这台设备"还没法收推送时出现——
// 平时不占任何空间。本次会话内关闭后不再重复出现，但下次打开应用仍会检查。
// Dashboard top banner: only appears when notifications are enabled at the
// account level but THIS device can't receive pushes yet — otherwise it takes
// up no space at all. Dismissing it holds for this session only; the next
// app launch re-checks the condition.
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Link } from "react-router-dom"
import { notificationApi } from "../api/client"
import { pushSupported } from "../utils/push"

const DISMISS_KEY = "prismx_notif_banner_dismissed"

export default function NotifDeviceBanner() {
  const { t } = useTranslation()
  const [enabled, setEnabled] = useState(false)
  const [dismissed, setDismissed] = useState(() => sessionStorage.getItem(DISMISS_KEY) === "1")

  useEffect(() => {
    let alive = true
    notificationApi
      .getPrefs()
      .then((p) => {
        if (alive) setEnabled(p.enabled)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  const deviceOk =
    pushSupported() && typeof Notification !== "undefined" && Notification.permission === "granted"
  const shouldShow = enabled && !deviceOk

  if (!shouldShow || dismissed) return null

  const onDismiss = () => {
    sessionStorage.setItem(DISMISS_KEY, "1")
    setDismissed(true)
  }

  return (
    <div className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-2.5 text-xs text-amber-300">
      <div className="flex min-w-0 items-center gap-2">
        <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-amber-400" />
        <span className="leading-relaxed">
          {pushSupported() ? t("account.notifDeviceHint") : t("account.notifUnsupported")}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Link
          to="/account#notifications"
          className="rounded-lg bg-amber-400/20 px-2.5 py-1 font-semibold text-amber-200 transition hover:bg-amber-400/30"
        >
          {t("notifPanel.fullSettings")}
        </Link>
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t("bridgeUpdate.dismiss")}
          className="text-amber-400/70 hover:text-amber-300"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  )
}
