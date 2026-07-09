// 账户详情页 / Account page: profile, MT5 accounts, password, notifications
import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { userApi, notificationApi, pushApi } from "../api/client"
import { fmtTime } from "../api/utils"
import { subscribePush, unsubscribePush, getSWReg } from "../utils/push"

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
  // 分类偏好防抖落库 / debounce saving category prefs
  const catSaveTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    load()
    // 已授权则后台预热 Service Worker，点开关时即可省去最耗时的注册等待。
    // If already granted, warm up the SW in the background so toggling is instant.
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      void getSWReg()
    }
    // 卸载时清理未触发的防抖定时器 / clear pending debounce on unmount
    return () => {
      if (catSaveTimer.current) window.clearTimeout(catSaveTimer.current)
    }
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
    if (!newPw || newPw.length < 8) {
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
    setNotifMsg(null)

    // FREE 等级不支持推送：不碰浏览器权限弹窗，直接提示升级。
    // FREE tier doesn't get push: skip the browser permission prompt entirely and prompt to upgrade.
    if (on && info?.plan === "FREE") {
      setNotifMsg({ kind: "err", text: t("account.notifUpgradeRequired") })
      return
    }

    // 关闭：乐观更新——立即关掉开关，后台并行清理订阅与落库。
    // Turn off: optimistic—flip the switch now, clean up subscription & prefs in background.
    if (!on) {
      setNotifEnabled(false)
      setNotifCats([])
      void Promise.all([
        notificationApi.putPrefs(false, []),
        (async () => {
          const reg = await getSWReg()
          const currentSub = await reg?.pushManager?.getSubscription()
          if (currentSub) {
            const json = currentSub.toJSON() as {
              endpoint: string
              keys: { p256dh: string; auth: string }
            }
            await pushApi.unsubscribe(json.endpoint!, json.keys!)
            await unsubscribePush()
          }
        })(),
      ]).catch(() => {
        // 清理失败则回滚开关 / roll back the switch on failure
        setNotifEnabled(true)
        setNotifMsg({ kind: "err", text: t("account.notifError") })
      })
      return
    }

    // 开启：权限校验后立即乐观翻转开关，落库与订阅链路并行后台执行。
    // Turn on: after permission, flip optimistically; run prefs save + push subscription in parallel.
    setNotifLoading(true)
    try {
      if (Notification.permission === "default") {
        const granted = await Notification.requestPermission()
        if (granted !== "granted") {
          setNotifMsg({ kind: "err", text: t("account.notifPermissionDenied") })
          return
        }
      } else if (Notification.permission === "denied") {
        setNotifMsg({ kind: "err", text: t("account.notifBlocked") })
        return
      }

      // 乐观翻转：开关立刻变 ON，无需等待后续网络 / flip now, don't wait on network
      setNotifEnabled(true)

      // 并行：(a) 落库通知偏好；(b) 取 VAPID + 注册 SW + 订阅 + 上报订阅。
      // Parallel: (a) save prefs; (b) fetch VAPID + warm SW + subscribe + report.
      const vapidPromise = pushApi.getVapidKey()
      await Promise.all([
        notificationApi.putPrefs(true, notifCats),
        (async () => {
          const [vapid] = await Promise.all([vapidPromise, getSWReg()])
          const sub = await subscribePush(vapid.publicKey)
          if (sub) await pushApi.subscribe(sub.endpoint, sub.keys)
        })(),
      ])
    } catch (err: unknown) {
      // 失败回滚开关 / roll back the switch on failure
      setNotifEnabled(false)
      setNotifMsg({
        kind: "err",
        text: err instanceof Error ? err.message : t("account.notifError"),
      })
    } finally {
      setNotifLoading(false)
    }
  }

  function handleNotifCatToggle(cat: string, on: boolean) {
    // 乐观更新：先即时更新 UI，再防抖落库 / optimistic UI then debounced save
    setNotifMsg(null)
    setNotifCats((prev) => {
      const next = on ? [...prev, cat] : prev.filter((c) => c !== cat)
      if (catSaveTimer.current) window.clearTimeout(catSaveTimer.current)
      catSaveTimer.current = window.setTimeout(() => {
        notificationApi.putPrefs(notifEnabled, next).catch(() => {
          // 落库失败则回滚该项 / roll back this toggle on failure
          setNotifCats((cur) => (on ? cur.filter((c) => c !== cat) : [...cur, cat]))
          setNotifMsg({ kind: "err", text: t("account.notifError") })
        })
      }, 400)
      return next
    })
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
            <div className="flex items-center justify-between">
              <h3 className="font-display text-sm font-semibold uppercase tracking-wider text-slate-300">
                {t("account.platform")}
              </h3>
              <span className="tag bg-prism-600/20 text-prism-300">{info.plan}</span>
            </div>
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
                    disabled={notifLoading || info.plan === "FREE"}
                    onChange={(e) => handleNotifToggle(e.target.checked)}
                    className="peer sr-only"
                  />
                  <div className="h-6 w-11 rounded-full bg-white/10 transition peer-checked:bg-prism-500 peer-disabled:opacity-60" />
                  <div className="absolute left-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-white shadow transition peer-checked:translate-x-5">
                    {notifLoading && (
                      <span className="h-3 w-3 animate-spin rounded-full border-2 border-prism-500/40 border-t-prism-600" />
                    )}
                  </div>
                </label>
                <span className="text-sm text-slate-100">{t("account.notifEnable")}</span>
                {notifLoading && (
                  <span className="text-xs text-slate-500">{t("account.notifProcessing")}</span>
                )}
              </div>
              {info.plan === "FREE" && (
                <p className="text-xs text-slate-500">{t("account.notifUpgradeRequired")}</p>
              )}
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
