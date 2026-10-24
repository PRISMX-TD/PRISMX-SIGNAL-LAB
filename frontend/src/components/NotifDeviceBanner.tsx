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
import { enableNotifications } from "../utils/notifications"
import { getSharedNotifPrefs, updateSharedNotifPrefs } from "../utils/notifPrefsShared"
import { detectPushEnv, deviceNotifHint, PUSH_ENV_HINT_KEYS } from "../utils/pushEnv"
import { useDeviceSubState } from "../utils/pushDeviceState"
import { recordDiag } from "../utils/pushDiag"
import { readStorage, writeStorage } from "../utils/safeStorage"

const DISMISS_KEY = "prismx_notif_banner_dismissed"

export default function NotifDeviceBanner() {
  const { t } = useTranslation()
  const [enabled, setEnabled] = useState(false)
  // sessionStorage 走 safeStorage：这一行在 useState 的初始化器里，Safari 无痕 /
  // 禁用站点数据时裸访问会同步抛 SecurityError，而本组件渲染在仪表盘上——抛一次
  // 就是仪表盘白屏。读不到就当"没关过"，最多多显示一次横幅。
  // sessionStorage via safeStorage: this sits in a useState initialiser, where a
  // bare access throws SecurityError synchronously in Safari private mode or with
  // site data disabled — and this renders on the dashboard, so one throw blanks
  // that page. A failed read means "not dismissed", at worst one extra banner.
  const [dismissed, setDismissed] = useState(() => readStorage(DISMISS_KEY, "session") === "1")

  useEffect(() => {
    let alive = true
    // 共享读取（与 Layout / 铃铛合并成一次请求）/ shared read, deduped with Layout and the bell
    getSharedNotifPrefs()
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
  // 2026-10-24 起用 deviceNotifHint：多出「这台设备没授权过」（典型是 iPhone 重新添加主屏
  // 图标后权限回到 default，账号开关却还开着）与「订阅失败」两格——以前这两种情况横幅都
  // 不出现，铃铛还显示绿色或错误的「不支持」，用户以为开着、实际一条都收不到。
  // Since 2026-10-24 via deviceNotifHint, adding "this device never granted" (typically a
  // re-added iPhone home-screen icon, permission back to default while the account toggle
  // is still on) and "subscribe failed" — both used to show no banner at all.
  const deviceHint = deviceNotifHint(env, useDeviceSubState())
  const [busy, setBusy] = useState(false)

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
  const shouldShow = env === "ios-needs-install" ? true : enabled && deviceHint !== null

  if (!shouldShow || dismissed) return null

  // 「在本机开启 / 重试」。enableNotifications 必须是点击里的第一个调用（iOS 只认手势里
  // 同步发起的权限申请）。成功后 env 变 granted、订阅状态变 ok，横幅自己消失；被拒则 env
  // 变 denied，文案自动换成「去系统设置里打开」，不需要另写错误提示。
  // enableNotifications must be the first call in the tap (iOS gesture rule). On success
  // the banner disappears by itself; on denial the hint switches to the settings guidance.
  const onFix = () => {
    const pending = enableNotifications(() =>
      notificationApi.getPrefs().then((p) => ({
        selected_categories: p.selected_categories,
        selected_symbols: p.selected_symbols,
        event_types: p.event_types,
      })),
    )
    setBusy(true)
    pending
      .then(() => updateSharedNotifPrefs({ enabled: true }))
      .catch(() => {})
      .finally(() => setBusy(false))
  }

  const onDismiss = () => {
    writeStorage(DISMISS_KEY, "1", "session")
    setDismissed(true)
  }

  return (
    <div className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-2.5 text-xs text-amber-300">
      <div className="flex min-w-0 items-center gap-2">
        <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-amber-400" />
        <span className="leading-relaxed">
          {t(deviceHint?.key ?? PUSH_ENV_HINT_KEYS[env] ?? "account.notifUnsupported")}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {deviceHint?.action && (
          <button
            type="button"
            onClick={onFix}
            disabled={busy}
            className="rounded-lg bg-amber-400/30 px-2.5 py-1 font-semibold text-amber-100 transition hover:bg-amber-400/40 disabled:opacity-50"
          >
            {t(deviceHint.action === "enable" ? "account.notifEnableHere" : "account.notifRetryHere")}
          </button>
        )}
        <Link
          to="/account#notifications"
          className="rounded-lg bg-amber-400/20 px-2.5 py-1 font-semibold text-amber-200 transition hover:bg-amber-400/30"
        >
          {t("notifPanel.fullSettings")}
        </Link>
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t("common.close")}
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
