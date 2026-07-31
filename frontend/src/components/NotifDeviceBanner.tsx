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
import { detectPushEnv, PUSH_ENV_HINT_KEYS } from "../utils/pushEnv"
import { recordDiag } from "../utils/pushDiag"

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
        recordDiag("prefs")
        if (alive) setEnabled(p.enabled)
      })
      .catch((err) => recordDiag("prefs", err))
    return () => {
      alive = false
    }
  }, [])

  const env = detectPushEnv()
  const hintKey = PUSH_ENV_HINT_KEYS[env]

  // iOS 16.4+ 在 Safari 标签页里的用户根本开不了账号级开关（没有 PushManager，
  // enableNotifications 会直接抛 unsupported），所以此前"enabled && !deviceOk"
  // 的条件让最需要引导的这批人永远看不到提示。这一种状态下不看 enabled。
  // 其余状态维持原条件，避免对从未打算用通知的人无谓打扰。
  //
  // Users on iOS 16.4+ in a Safari tab can't turn the account-level toggle on at
  // all (no PushManager, so enableNotifications throws unsupported), which meant
  // the previous "enabled && !deviceOk" condition hid the banner from exactly the
  // people who needed it. That one state ignores `enabled`; the rest keep the
  // original condition so anyone uninterested in notifications isn't nagged.
  const shouldShow = env === "ios-needs-install" ? true : enabled && hintKey !== null

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
          {t(hintKey ?? "account.notifUnsupported")}
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
