// 账户详情页 / Account page: profile, MT5 accounts, password, notifications
import { useEffect, useRef, useState } from "react"
import { Link, useLocation } from "react-router-dom"
import { useTranslation } from "react-i18next"
import { userApi, notificationApi, setToken } from "../api/client"
import { fmtTime, fmtDate, localizeApiError } from "../api/utils"
import { getSWReg, pushSupported } from "../utils/push"
import {
  ALL_SENTINEL,
  EVENT_TYPES,
  ENABLE_ERROR_KEYS,
  disableNotifications,
  enableNotifications,
  NotifEnableError,
} from "../utils/notifications"

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
  const location = useLocation()
  const [notifEnabled, setNotifEnabled] = useState(false)
  const [notifCats, setNotifCats] = useState<string[]>([])
  const [allCats, setAllCats] = useState<string[]>([])
  // 品种白名单：与 notifCats（策略类别）按"与"关系联合过滤——一条信号必须
  // 两边都命中才推送。列表随 EA/信号引擎实际推送过的品种变化，不写死。
  // Symbol whitelist: ANDed with notifCats (strategy categories) — a signal
  // only pushes if both match. The list tracks whatever symbols the EA/signal
  // engine has actually pushed, not a hardcoded set.
  const [notifSymbols, setNotifSymbols] = useState<string[]>([])
  const [allSymbols, setAllSymbols] = useState<string[]>([])
  // 账户/交易事件白名单：订单成交/拒绝、自动仓管触发、Bridge 掉线。此前推送
  // 只有"新信号"一种，这些账户层面的事都是静默的。与 notifCats/notifSymbols
  // （信号策略·品种白名单）是独立设置，分开落库、分开渲染。
  // Account/trading event whitelist: order fill/reject, auto-manage trigger,
  // bridge offline. Push used to only ever cover "new signal" — these
  // account-level events were all silent. Independent from notifCats/notifSymbols
  // (the signal strategy/symbol whitelists), saved and rendered independently.
  const [notifEvents, setNotifEvents] = useState<string[]>([])
  const [notifMsg, setNotifMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null)
  const [notifLoading, setNotifLoading] = useState(false)
  // 分类/品种/事件偏好防抖落库 / debounce saving category, symbol & event prefs
  const catSaveTimer = useRef<number | undefined>(undefined)
  const symbolSaveTimer = useRef<number | undefined>(undefined)
  const eventSaveTimer = useRef<number | undefined>(undefined)
  const notifSectionRef = useRef<HTMLElement | null>(null)

  // 三个防抖计时器各自的回调都要把"当前完整偏好"整份 PUT 给后端（后端是
  // 整份覆盖，不是按维度合并）。若各自直接读取闭包里捕获的 notifCats/
  // notifSymbols/notifEvents，当用户在同一个 400ms 窗口内连续切换两个不同
  // 维度时，先触发的那个计时器会用它触发那一刻捕获的、尚未包含后一次改动
  // 的旧值去覆盖后一次改动，把刚保存成功的那一项改动悄悄覆盖回去。这几个
  // ref 随每次渲染同步到最新 state，计时器触发时读它们而不是闭包变量，就
  // 总能拿到"这一刻"真正最新的值。
  // All three debounce timers' callbacks PUT the full preference set (the
  // backend fully overwrites, not merges, per dimension). If each read the
  // notifCats/notifSymbols/notifEvents captured in its own handler's
  // closure, then toggling two different dimensions within the same 400ms
  // window would let the earlier-scheduled timer fire with the value it
  // captured at handler-call time — before the later toggle — silently
  // clobbering that just-saved change back to the old value. These refs
  // stay in sync with the latest state on every render; reading them instead
  // of the closure variables at fire time always gets what's actually
  // current "right now".
  const catsRef = useRef(notifCats)
  const symbolsRef = useRef(notifSymbols)
  const eventsRef = useRef(notifEvents)
  const enabledRef = useRef(notifEnabled)
  useEffect(() => { catsRef.current = notifCats }, [notifCats])
  useEffect(() => { symbolsRef.current = notifSymbols }, [notifSymbols])
  useEffect(() => { eventsRef.current = notifEvents }, [notifEvents])
  useEffect(() => { enabledRef.current = notifEnabled }, [notifEnabled])

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
      if (symbolSaveTimer.current) window.clearTimeout(symbolSaveTimer.current)
      if (eventSaveTimer.current) window.clearTimeout(eventSaveTimer.current)
    }
  }, [])

  // 从铃铛弹层等处深链跳转过来（/account#notifications）时，定位到通知设置区块。
  // Deep-linked here from e.g. the bell popover (/account#notifications): scroll to the notifications section.
  useEffect(() => {
    if (location.hash === "#notifications" && !loading) {
      notifSectionRef.current?.scrollIntoView({ block: "start" })
    }
  }, [location.hash, loading])

  async function load() {
    setLoading(true)
    // 账户信息是这个页面能否渲染的前提，单独取、失败就整页报错。通知相关的
    // 三个接口分开取——任何一个失败（如后端刚上线新端点还没部署到位）只让
    // 通知区块退化为空列表，不该把密码/MT5 账户等其余板块也一起拖挂掉。
    // Account info is the precondition for rendering this page at all — fetch
    // it alone; on failure, show the page-level error. The three
    // notification-related calls are fetched separately: if any one fails
    // (e.g. a new endpoint the backend hasn't finished deploying yet), only
    // the notifications section degrades to empty lists — it shouldn't take
    // down the password/MT5-accounts sections too.
    try {
      setInfo(await userApi.me())
    } catch (err: unknown) {
      console.error("account load:", err)
      setLoading(false)
      return
    }
    try {
      const [prefsRes, catsRes, symsRes] = await Promise.all([
        notificationApi.getPrefs(),
        notificationApi.getIndicators(),
        notificationApi.getSymbols(),
      ])
      setNotifEnabled(prefsRes.enabled)
      setNotifCats(prefsRes.selected_categories)
      setNotifSymbols(prefsRes.selected_symbols ?? [])
      setNotifEvents(prefsRes.event_types ?? [])
      setAllCats(catsRes)
      setAllSymbols(symsRes)
    } catch (err: unknown) {
      console.error("account load (notifications):", err)
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
      const res = await userApi.changePassword(oldPw || null, newPw)
      // 改密后端会让旧 token 失效，响应带回新 token——必须立即替换本地存的
      // 那份，否则接下来的任何请求都会因为带着已失效的旧 token 被 401 踢出。
      // The backend invalidates the old token on a password change and
      // returns a new one — swap it in immediately, or the very next request
      // 401s on the now-invalidated old token.
      if (res.token) setToken(res.token)
      setPwMsg({ kind: "ok", text: t("account.pwChanged") })
      setOldPw("")
      setNewPw("")
    } catch (err: unknown) {
      setPwMsg({
        kind: "err",
        text: err instanceof Error ? localizeApiError(err.message) : t("account.pwError"),
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
      setNotifSymbols([])
      setNotifEvents([])
      void disableNotifications().catch(() => {
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
      const { cats, syms, events } = await enableNotifications(() =>
        Promise.resolve({
          selected_categories: notifCats,
          selected_symbols: notifSymbols,
          event_types: notifEvents,
        }),
      )
      setNotifEnabled(true)
      setNotifCats(cats)
      setNotifSymbols(syms)
      setNotifEvents(events)
    } catch (err: unknown) {
      // 失败回滚开关 / roll back the switch on failure
      setNotifEnabled(false)
      if (err instanceof NotifEnableError) {
        setNotifMsg({ kind: "err", text: t(ENABLE_ERROR_KEYS[err.reason]) })
      } else {
        setNotifMsg({
          kind: "err",
          text: err instanceof Error ? localizeApiError(err.message) : t("account.notifError"),
        })
      }
    } finally {
      setNotifLoading(false)
    }
  }

  // 通用的"策略/品种白名单"切换：两个维度都支持 ALL_SENTINEL（全部）——
  // 勾选"全部"清空其余具体项，勾选任意具体项则自动取消"全部"。
  // Shared toggle for the strategy/symbol whitelists: both dimensions support
  // the ALL_SENTINEL ("全部") — ticking it clears specific picks, ticking any
  // specific item automatically clears "全部".
  function toggleWhitelistValue(prev: string[], value: string, on: boolean): string[] {
    if (value === ALL_SENTINEL) return on ? [ALL_SENTINEL] : []
    const withoutAll = prev.filter((v) => v !== ALL_SENTINEL)
    return on ? [...withoutAll, value] : withoutAll.filter((v) => v !== value)
  }

  function handleNotifCatToggle(cat: string, on: boolean) {
    // 乐观更新：先即时更新 UI，再防抖落库 / optimistic UI then debounced save
    setNotifMsg(null)
    setNotifCats((prev) => {
      const next = toggleWhitelistValue(prev, cat, on)
      if (catSaveTimer.current) window.clearTimeout(catSaveTimer.current)
      catSaveTimer.current = window.setTimeout(() => {
        // 其它两个维度从 ref 取"此刻最新值"，而不是本次调用时闭包捕获的
        // notifEvents/notifSymbols——见 refs 声明处的说明。
        // The other two dimensions come from the refs ("right now"), not the
        // notifEvents/notifSymbols this call's closure captured — see the
        // refs' declaration comment.
        notificationApi.putPrefs(enabledRef.current, next, eventsRef.current, symbolsRef.current).catch(() => {
          // 落库失败则回滚该项 / roll back this toggle on failure
          setNotifCats(prev)
          setNotifMsg({ kind: "err", text: t("account.notifError") })
        })
      }, 400)
      return next
    })
  }

  function handleNotifSymbolToggle(symbol: string, on: boolean) {
    // 乐观更新：先即时更新 UI，再防抖落库 / optimistic UI then debounced save
    setNotifMsg(null)
    setNotifSymbols((prev) => {
      const next = toggleWhitelistValue(prev, symbol, on)
      if (symbolSaveTimer.current) window.clearTimeout(symbolSaveTimer.current)
      symbolSaveTimer.current = window.setTimeout(() => {
        notificationApi.putPrefs(enabledRef.current, catsRef.current, eventsRef.current, next).catch(() => {
          // 落库失败则回滚该项 / roll back this toggle on failure
          setNotifSymbols(prev)
          setNotifMsg({ kind: "err", text: t("account.notifError") })
        })
      }, 400)
      return next
    })
  }

  function handleNotifEventToggle(eventType: string, on: boolean) {
    // 乐观更新：先即时更新 UI，再防抖落库 / optimistic UI then debounced save
    setNotifMsg(null)
    setNotifEvents((prev) => {
      const next = on ? [...prev, eventType] : prev.filter((e) => e !== eventType)
      if (eventSaveTimer.current) window.clearTimeout(eventSaveTimer.current)
      eventSaveTimer.current = window.setTimeout(() => {
        notificationApi.putPrefs(enabledRef.current, catsRef.current, next, symbolsRef.current).catch(() => {
          // 落库失败则回滚该项 / roll back this toggle on failure
          setNotifEvents((cur) => (on ? cur.filter((e) => e !== eventType) : [...cur, eventType]))
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
              <span className="tag bg-prism-600/20 text-prism-300">
                {info.plan === "PRO" && info.planIsTrial ? t("account.planTrialTag") : info.plan}
              </span>
            </div>
            <div className="mt-3 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
              <div className="min-w-0">
                <span className="text-slate-500">{t("account.email")}</span>
                <div className="break-all font-mono text-slate-100">{info.email}</div>
              </div>
              <div className="min-w-0">
                <span className="text-slate-500">{t("account.registeredAt")}</span>
                <div className="font-mono text-slate-100">{fmtTime(info.createdAt)}</div>
              </div>
              {info.plan === "PRO" && (
                <div className="min-w-0">
                  <span className="text-slate-500">{t("account.expiresAt")}</span>
                  <div className="font-mono text-slate-100">
                    {info.planExpiresAt ? fmtDate(info.planExpiresAt) : t("account.neverExpires")}
                  </div>
                </div>
              )}
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
          <section id="notifications" ref={notifSectionRef} className="glass-neon scroll-mt-20 p-5">
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
                <p className="text-xs text-slate-500">
                  {t("account.notifUpgradeRequired")}{" "}
                  <Link to="/upgrade" className="text-prism-400 underline hover:text-prism-300">
                    {t("nav.upgrade")}
                  </Link>
                </p>
              )}
              {/* 账号级开关已开、但"这台设备"还没法收推送时给出设备级提示——
                  开关状态跨设备同步，很容易让人误以为手机也已生效。两种情形：
                  ① 本环境没有 Push API（iOS 未从主屏幕独立打开）；② 有 API
                  但本设备从未授权过通知权限。
                  Device-level hint when the account toggle is ON but THIS
                  device can't receive pushes yet — the toggle syncs across
                  devices, which easily reads as "the phone works too". Two
                  cases: ① no Push API here (iOS not launched standalone from
                  the Home Screen); ② API exists but this device never granted
                  notification permission. */}
              {notifEnabled && !pushSupported() && (
                <p className="text-xs text-amber-400">{t("account.notifUnsupported")}</p>
              )}
              {notifEnabled && pushSupported() && Notification.permission !== "granted" && (
                <p className="text-xs text-amber-400">{t("account.notifDeviceHint")}</p>
              )}
              {notifEnabled && (
                <p className="text-xs leading-relaxed text-slate-500">{t("account.notifFilterHint")}</p>
              )}
              {notifEnabled && (
                <div className="space-y-2 pl-1">
                  <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                    {t("account.notifStrategyLabel")}
                  </p>
                  {allCats.length === 0 ? (
                    <p className="text-xs text-slate-500">{t("account.notifNoCategories")}</p>
                  ) : (
                    <>
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={notifCats.includes(ALL_SENTINEL)}
                          onChange={(e) => handleNotifCatToggle(ALL_SENTINEL, e.target.checked)}
                          className="h-4 w-4 rounded border-white/20 bg-white/5 text-prism-500 accent-prism-500"
                        />
                        <span className="font-medium text-slate-200">{t("account.notifAll")}</span>
                      </label>
                      {allCats.map((cat) => (
                        <label key={cat} className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={notifCats.includes(cat) || notifCats.includes(ALL_SENTINEL)}
                            disabled={notifCats.includes(ALL_SENTINEL)}
                            onChange={(e) => handleNotifCatToggle(cat, e.target.checked)}
                            className="h-4 w-4 rounded border-white/20 bg-white/5 text-prism-500 accent-prism-500 disabled:opacity-50"
                          />
                          <span className="text-slate-300">{cat}</span>
                        </label>
                      ))}
                    </>
                  )}
                </div>
              )}
              {notifEnabled && (
                <div className="space-y-2 border-t border-white/5 pt-4 pl-1">
                  <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                    {t("account.notifSymbolLabel")}
                  </p>
                  {allSymbols.length === 0 ? (
                    <p className="text-xs text-slate-500">{t("account.notifNoSymbols")}</p>
                  ) : (
                    <>
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={notifSymbols.includes(ALL_SENTINEL)}
                          onChange={(e) => handleNotifSymbolToggle(ALL_SENTINEL, e.target.checked)}
                          className="h-4 w-4 rounded border-white/20 bg-white/5 text-prism-500 accent-prism-500"
                        />
                        <span className="font-medium text-slate-200">{t("account.notifAll")}</span>
                      </label>
                      {allSymbols.map((sym) => (
                        <label key={sym} className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={notifSymbols.includes(sym) || notifSymbols.includes(ALL_SENTINEL)}
                            disabled={notifSymbols.includes(ALL_SENTINEL)}
                            onChange={(e) => handleNotifSymbolToggle(sym, e.target.checked)}
                            className="h-4 w-4 rounded border-white/20 bg-white/5 text-prism-500 accent-prism-500 disabled:opacity-50"
                          />
                          <span className="text-slate-300">
                            {t(`signals.symbolNames.${sym}`, { defaultValue: "" }) || sym}
                          </span>
                        </label>
                      ))}
                    </>
                  )}
                </div>
              )}
              {notifEnabled && (
                <div className="space-y-2 border-t border-white/5 pt-4 pl-1">
                  <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                    {t("account.notifEventsHeading")}
                  </p>
                  {EVENT_TYPES.map((ev) => (
                    <label key={ev} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={notifEvents.includes(ev)}
                        onChange={(e) => handleNotifEventToggle(ev, e.target.checked)}
                        className="h-4 w-4 rounded border-white/20 bg-white/5 text-prism-500 accent-prism-500"
                      />
                      <span className="text-slate-300">{t(`account.notifEvent.${ev}`)}</span>
                    </label>
                  ))}
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
