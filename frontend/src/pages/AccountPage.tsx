// 账户详情页 / Account page: profile, MT5 accounts, password, notifications
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { userApi, notificationApi, pushApi } from "../api/client"
import { fmtTime } from "../api/utils"
import { subscribePush, unsubscribePush } from "../utils/push"

type AccountInfo = Awaited<ReturnType<typeof userApi.me>>

export default function AccountPage() {
  const { t } = useTranslation()
  const [info, setInfo] = useState<AccountInfo | null>(null)
  const [loading, setLoading] = useState(true)

  // 密码 / password
  const [oldPw, setOldPw] = useState("")
  const [newPw, setNewPw] = useState("")
  const [pwMsg, setPwMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null)

  // 通知 / notifications
  const [notifEnabled, setNotifEnabled] = useState(false)
  const [notifCats, setNotifCats] = useState<string[]>([])
  const [allCats, setAllCats] = useState<string[]>([])
  const [notifMsg, setNotifMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null)
  const [notifLoading, setNotifLoading] = useState(false)

  useEffect(() => {
    load()
  }, [])

  async function load() {
    setLoading(true)
    try {
      const [infoRes, prefsRes, catsRes] = await Promise.all([
        userApi.me(),
        notificationApi.getPrefs(),
        notificationApi.getIndicators(),
      ])
      setInfo(infoRes)
      setNotifEnabled(prefsRes.enabled)
      setNotifCats(prefsRes.selected_categories)
      setAllCats(catsRes)
    } catch (err: unknown) {
      console.error("account load:", err)
    } finally {
      setLoading(false)
    }
  }

  async function handlePassword() {
    if (!newPw || newPw.length < 6) {
      setPwMsg({ kind: "err", text: t("account.pwTooShort") })
      return
    }
    try {
      await userApi.changePassword(oldPw || null, newPw)
      setPwMsg({ kind: "ok", text: t("account.pwChanged") })
      setOldPw("")
      setNewPw("")
    } catch (err: unknown) {
      setPwMsg({
        kind: "err",
        text: err instanceof Error ? err.message : t("account.pwError"),
      })
    }
  }

  async function handleNotifToggle(on: boolean) {
    setNotifLoading(true)
    setNotifMsg(null)
    try {
      if (on) {
        // 请求通知权限 / request notification permission
        if (Notification.permission === "default") {
          const granted = await Notification.requestPermission()
          if (granted !== "granted") {
            setNotifMsg({ kind: "err", text: t("account.notifPermissionDenied") })
            setNotifLoading(false)
            return
          }
        } else if (Notification.permission === "denied") {
          setNotifMsg({ kind: "err", text: t("account.notifBlocked") })
          setNotifLoading(false)
          return
        }
        // 注册 Service Worker + 推送订阅 / sw + push sub
        const vapid = await pushApi.getVapidKey()
        const sub = await subscribePush(vapid.publicKey)
        if (sub) {
          await pushApi.subscribe(sub.endpoint, sub.keys)
        }
      } else {
        // 取消推送 / unsubscribe
        const currentSub = await (
          await navigator.serviceWorker?.ready
        )?.pushManager?.getSubscription()
        if (currentSub) {
          const json = currentSub.toJSON() as {
            endpoint: string
            keys: { p256dh: string; auth: string }
          }
          await pushApi.unsubscribe(json.endpoint!, json.keys!)
          await unsubscribePush()
        }
      }

      const cats = on ? notifCats : []
      await notificationApi.putPrefs(on, cats)
      setNotifEnabled(on)
      setNotifCats(cats)
    } catch (err: unknown) {
      setNotifMsg({
        kind: "err",
        text: err instanceof Error ? err.message : t("account.notifError"),
      })
    } finally {
      setNotifLoading(false)
    }
  }

  async function handleNotifCatToggle(cat: string, on: boolean) {
    const next = on ? [...notifCats, cat] : notifCats.filter((c) => c !== cat)
    try {
      await notificationApi.putPrefs(notifEnabled, next)
      setNotifCats(next)
    } catch {
      // ignore
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-prism-600/30 border-t-prism-500" />
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h2 className="font-display text-2xl font-bold text-slate-100">
        <span className="neon-text">{t("account.title")}</span>
      </h2>
      {!info ? (
        <div className="glass p-6 text-center text-sm text-slate-400">{t("account.loadError")}</div>
      ) : (
        <>
          {/* 平台账户 / Platform account */}
          <section className="glass-neon p-5">
            <h3 className="font-display text-sm font-semibold uppercase tracking-wider text-slate-300">
              {t("account.platform")}
            </h3>
            <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
              <div>
                <span className="text-slate-500">{t("account.email")}</span>
                <div className="font-mono text-slate-100">{info.email}</div>
              </div>
              <div>
                <span className="text-slate-500">{t("account.registeredAt")}</span>
                <div className="font-mono text-slate-100">{fmtTime(info.createdAt)}</div>
              </div>
            </div>
          </section>

          {/* MT5 账号概览 / MT5 accounts */}
          {info.mt5Accounts.length > 0 && (
            <section className="glass-neon p-5">
              <h3 className="font-display text-sm font-semibold uppercase tracking-wider text-slate-300">
                {t("account.mt5Accounts")}
              </h3>
              <div className="mt-3 space-y-3">
                {info.mt5Accounts.map((a, i) => (
                  <div key={i} className="rounded-lg border border-white/5 bg-white/[0.03] p-3">
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-sm text-slate-100">
                        {a.login}
                        {a.server ? ` @${a.server}` : ""}
                      </span>
                      <span
                        className={`tag text-xs ${a.online ? "bg-up/15 text-up" : "bg-white/5 text-slate-500"}`}
                      >
                        {a.online ? t("common.online") : t("common.offline")}
                      </span>
                    </div>
                    <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
                      <div>
                        <span className="text-slate-500">{t("account.balance")}</span>
                        <div className="font-mono text-slate-100">{a.balance?.toFixed(2) ?? "-"}</div>
                      </div>
                      <div>
                        <span className="text-slate-500">{t("account.equity")}</span>
                        <div className="font-mono text-slate-100">{a.equity?.toFixed(2) ?? "-"}</div>
                      </div>
                      <div>
                        <span className="text-slate-500">{t("account.leverage")}</span>
                        <div className="font-mono text-slate-100">{a.leverage ? `1:${a.leverage}` : "-"}</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* 密码管理 / Password */}
          <section className="glass-neon p-5">
            <h3 className="font-display text-sm font-semibold uppercase tracking-wider text-slate-300">
              {info.hasPassword ? t("account.changePassword") : t("account.setPassword")}
            </h3>
            <div className="mt-3 space-y-3">
              {info.hasPassword && (
                <input
                  type="password"
                  value={oldPw}
                  onChange={(e) => setOldPw(e.target.value)}
                  placeholder={t("account.oldPassword")}
                  className="input w-full"
                  autoComplete="current-password"
                />
              )}
              <input
                type="password"
                value={newPw}
                onChange={(e) => setNewPw(e.target.value)}
                placeholder={t("account.newPassword")}
                className="input w-full"
                autoComplete="new-password"
              />
              <button onClick={handlePassword} className="btn-primary px-5 py-2">
                {info.hasPassword ? t("account.changePassword") : t("account.setPassword")}
              </button>
              {pwMsg && (
                <p className={`text-sm ${pwMsg.kind === "err" ? "text-down" : "text-up"}`}>
                  {pwMsg.text}
                </p>
              )}
            </div>
          </section>

          {/* 通知设置 / Notifications */}
          <section className="glass-neon p-5">
            <h3 className="font-display text-sm font-semibold uppercase tracking-wider text-slate-300">
              {t("account.notifications")}
            </h3>
            <div className="mt-3 space-y-4">
              <div className="flex items-center gap-3">
                <label className="relative inline-flex cursor-pointer items-center">
                  <input
                    type="checkbox"
                    checked={notifEnabled}
                    disabled={notifLoading}
                    onChange={(e) => handleNotifToggle(e.target.checked)}
                    className="peer sr-only"
                  />
                  <div className="h-6 w-11 rounded-full bg-white/10 transition peer-checked:bg-prism-500" />
                  <div className="absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition peer-checked:translate-x-5" />
                </label>
                <span className="text-sm text-slate-100">{t("account.notifEnable")}</span>
              </div>
              {notifEnabled && (
                <div className="space-y-2 pl-1">
                  {allCats.length === 0 ? (
                    <p className="text-xs text-slate-500">{t("account.notifNoCategories")}</p>
                  ) : (
                    allCats.map((cat) => (
                      <label key={cat} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={notifCats.includes(cat)}
                          onChange={(e) => handleNotifCatToggle(cat, e.target.checked)}
                          className="h-4 w-4 rounded border-white/20 bg-white/5 text-prism-500 accent-prism-500"
                        />
                        <span className="text-slate-300">{cat}</span>
                      </label>
                    ))
                  )}
                </div>
              )}
              {notifMsg && (
                <p className={`text-sm ${notifMsg.kind === "err" ? "text-down" : "text-up"}`}>
                  {notifMsg.text}
                </p>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  )
}
