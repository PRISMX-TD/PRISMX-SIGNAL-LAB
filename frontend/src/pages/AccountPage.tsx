// 账户详情页 / Account page: profile, password, notifications
// MT5 账户资金概览不在这里展示——连接与账户信息统一放在 /bind 页维护。
// MT5 account balances are deliberately not shown here — connection and
// account info live on the /bind page.
import { useEffect, useRef, useState } from "react"
import type { ReactNode } from "react"
import { Link, useLocation } from "react-router-dom"
import { useTranslation } from "react-i18next"
import { userApi, notificationApi, setToken } from "../api/client"
import type { ProfilePatch } from "../api/types"
import { localizeApiError } from "../api/utils"
import { getSWReg } from "../utils/push"
import { detectPushEnv, PUSH_ENV_HINT_KEYS } from "../utils/pushEnv"
import PushDiagnostics from "../components/PushDiagnostics"
import { SkeletonBlock, SkeletonLine } from "../components/Skeleton"
import BadgeIcon from "../components/badges/BadgeIcon"
import Switch from "../components/Switch"
import PageHead from "../components/PageHead"
import {
  ALL_SENTINEL,
  EVENT_STRATEGY_SIGNAL,
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

  // 游戏化个人资料：昵称 + 榜单展示/退出两个开关（设计 §6/§11）。草稿值只在
  // load() 成功、以及保存成功后从服务端回填，不在本地做长度等预校验——后端
  // 校验（2-20 字/保留词）失败会带回双语错误文案，直接展示即可，不重复一份。
  // Gamification profile: nickname + the two leaderboard toggles. Drafts are
  // only seeded from the server on load() and after a successful save — no
  // client-side length pre-check duplicating the backend's (2-20 chars /
  // reserved word), whose failures already carry a ready-to-show bilingual message.
  const [nicknameDraft, setNicknameDraft] = useState("")
  const [nicknamePublicDraft, setNicknamePublicDraft] = useState(false)
  const [leaderboardOptOutDraft, setLeaderboardOptOutDraft] = useState(false)
  // 公开主页的交易画像开关（2026-09-07），与上面两个开关同一条保存路径。
  // The public-profile trading-stats switch (2026-09-07), saved on the same path as the two above.
  const [statsPublicDraft, setStatsPublicDraft] = useState(false)
  const [profileSaving, setProfileSaving] = useState(false)
  const [profileMsg, setProfileMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null)

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
  // 推送时段：开关独立于起止时间保存，取消勾选后重新勾选能回到上次填的时段。
  // 起止默认 08:00–22:00，是"白天推、夜里别吵"的直觉预设。
  // Push window: the on/off flag is tracked apart from the two times so
  // unticking and re-ticking restores the last-entered range. Defaults to
  // 08:00–22:00 — the intuitive "push by day, quiet at night" preset.
  const [notifWinOn, setNotifWinOn] = useState(false)
  const [notifWinStart, setNotifWinStart] = useState("08:00")
  const [notifWinEnd, setNotifWinEnd] = useState("22:00")
  const [notifMsg, setNotifMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null)
  const [notifLoading, setNotifLoading] = useState(false)
  const hintKey = PUSH_ENV_HINT_KEYS[detectPushEnv()]
  // 分类/品种/事件/时段偏好防抖落库 / debounce saving category, symbol, event & window prefs
  const catSaveTimer = useRef<number | undefined>(undefined)
  const symbolSaveTimer = useRef<number | undefined>(undefined)
  const eventSaveTimer = useRef<number | undefined>(undefined)
  const winSaveTimer = useRef<number | undefined>(undefined)
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
      if (winSaveTimer.current) window.clearTimeout(winSaveTimer.current)
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
    // 通知区块退化为空列表，不该把密码等其余板块也一起拖挂掉。
    // Account info is the precondition for rendering this page at all — fetch
    // it alone; on failure, show the page-level error. The three
    // notification-related calls are fetched separately: if any one fails
    // (e.g. a new endpoint the backend hasn't finished deploying yet), only
    // the notifications section degrades to empty lists — it shouldn't take
    // down the password section too.
    try {
      const acct = await userApi.me()
      setInfo(acct)
      setNicknameDraft(acct.nickname ?? "")
      setNicknamePublicDraft(acct.nicknamePublic)
      setLeaderboardOptOutDraft(acct.leaderboardOptOut)
      setStatsPublicDraft(acct.statsPublic)
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
      // 时段两头都有值才算开启；`?? null` 兜底旧后端响应里没有这些键的情况。
      // The window counts as on only with both bounds present; `?? null`
      // guards against responses from a backend without these keys yet.
      const winStart = prefsRes.push_window_start ?? null
      const winEnd = prefsRes.push_window_end ?? null
      setNotifWinOn(!!(winStart && winEnd))
      if (winStart) setNotifWinStart(winStart)
      if (winEnd) setNotifWinEnd(winEnd)
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

  // 只把实际改过的字段塞进 PATCH body——后端是按传了哪个字段局部更新，不是
  // 整份覆盖，多传等于多改一个用户没碰过的字段。昵称按 trim 后与服务端当前值
  // （null 记作空串）比较，避免"没碰过昵称输入框"也被当成一次改动提交。
  // Only the fields actually touched go into the PATCH body — the backend
  // updates per-field-present, not a full overwrite, so sending an untouched
  // field would still change it. Nickname compares the trimmed draft against
  // the server's current value (null treated as ""), so leaving the input
  // untouched never counts as a change.
  async function handleProfileSave() {
    if (!info) return
    setProfileMsg(null)
    const patch: ProfilePatch = {}
    const trimmedNick = nicknameDraft.trim()
    if (trimmedNick !== (info.nickname ?? "")) patch.nickname = trimmedNick
    if (nicknamePublicDraft !== info.nicknamePublic) patch.nicknamePublic = nicknamePublicDraft
    if (leaderboardOptOutDraft !== info.leaderboardOptOut) patch.leaderboardOptOut = leaderboardOptOutDraft
    if (statsPublicDraft !== info.statsPublic) patch.statsPublic = statsPublicDraft
    if (Object.keys(patch).length === 0) return
    setProfileSaving(true)
    try {
      const res = await userApi.updateProfile(patch)
      setInfo((prev) =>
        prev
          ? {
              ...prev,
              nickname: res.nickname,
              nicknamePublic: res.nicknamePublic,
              leaderboardOptOut: res.leaderboardOptOut,
              equippedBadge: res.equippedBadge,
              statsPublic: res.statsPublic,
            }
          : prev,
      )
      setNicknameDraft(res.nickname ?? "")
      setNicknamePublicDraft(res.nicknamePublic)
      setLeaderboardOptOutDraft(res.leaderboardOptOut)
      setStatsPublicDraft(res.statsPublic)
      setProfileMsg({ kind: "ok", text: t("gamification.profile.saved") })
    } catch (err: unknown) {
      setProfileMsg({
        kind: "err",
        text: err instanceof Error ? localizeApiError(err.message) : t("admin.saveError"),
      })
    } finally {
      setProfileSaving(false)
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

  // 推送时段落库：其余维度的防抖保存不携带时段（后端对未出现的时段字段保持
  // 原值），所以时段只由这里写；三项其余偏好照旧从 ref 取"此刻最新值"。
  // Persist the push window. The other dimensions' debounced saves don't carry
  // the window (the backend keeps absent window fields untouched), so it's only
  // ever written here; the other three prefs still come from the refs.
  function scheduleWindowSave(on: boolean, start: string, end: string, rollback: () => void) {
    if (winSaveTimer.current) window.clearTimeout(winSaveTimer.current)
    // 起止没填完整就先不落库（time 输入编辑中可能短暂为空）
    // Don't persist a half-filled range (a time input can be briefly empty mid-edit)
    if (on && (!start || !end)) return
    winSaveTimer.current = window.setTimeout(() => {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || null
      const win = on ? { start, end, tz } : { start: null, end: null, tz: null }
      notificationApi
        .putPrefs(enabledRef.current, catsRef.current, eventsRef.current, symbolsRef.current, win)
        .catch(() => {
          rollback()
          setNotifMsg({ kind: "err", text: t("account.notifError") })
        })
    }, 400)
  }

  function handleWinToggle(on: boolean) {
    setNotifMsg(null)
    const prev = notifWinOn
    setNotifWinOn(on)
    scheduleWindowSave(on, notifWinStart, notifWinEnd, () => setNotifWinOn(prev))
  }

  function handleWinTime(field: "start" | "end", value: string) {
    setNotifMsg(null)
    const prevStart = notifWinStart
    const prevEnd = notifWinEnd
    const start = field === "start" ? value : notifWinStart
    const end = field === "end" ? value : notifWinEnd
    setNotifWinStart(start)
    setNotifWinEnd(end)
    scheduleWindowSave(notifWinOn, start, end, () => {
      setNotifWinStart(prevStart)
      setNotifWinEnd(prevEnd)
    })
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 以下是渲染层。2026-09-07 重做：三张同款卡片 → 顶部「身份牌」+ 下方发丝线
  // 分区的「账本」。上面的数据与保存逻辑一行没动，只换了皮。样式见
  // styles/account.css 顶部说明。
  // Rendering below. Redesigned 2026-09-07: three identical cards → an identity
  // plate on top and a hairline-divided ledger underneath. Nothing above this
  // line (data + save logic) changed; only the skin did. See the header of
  // styles/account.css.
  // ─────────────────────────────────────────────────────────────────────────

  if (loading) {
    // 骨架与真实布局同形：左大字、右一张牌、下面三条分区。页眉常驻。
    // Skeleton shaped like the real layout: headline left, plate right, three
    // ledger rows below. The eyebrow stays put.
    return (
      <div>
        <p className="eyebrow">{t("account.title")}</p>
        <div className="acct-hero mt-3">
          <div>
            <SkeletonLine width="42%" height={40} />
            <SkeletonLine width="60%" height={14} className="mt-4" />
          </div>
          <div className="acct-plate-wrap">
            <SkeletonBlock className="acct-skel-plate" radius={24} />
          </div>
        </div>
        <div className="acct-ledger">
          {[0, 1, 2].map((i) => (
            <div key={i} className="acct-row" style={{ ["--i" as string]: i }}>
              <div>
                <SkeletonLine width="38%" height={16} />
                <SkeletonLine width="80%" height={12} className="mt-3" />
              </div>
              <div className="acct-row-body">
                <SkeletonBlock height={40} radius={999} />
                <SkeletonBlock height={40} radius={999} className="mt-3" />
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (!info) {
    return (
      <div>
        <PageHead as="h1" title={t("account.title")} />
        <div className="acct-empty">{t("account.loadError")}</div>
      </div>
    )
  }

  const displayName = info.nickname?.trim() || info.email.split("@")[0]
  const isPro = info.plan === "PRO"
  const mt5Count = info.mt5Accounts?.length ?? 0
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  const strength = pwStrength(newPw)
  const catsAll = notifCats.includes(ALL_SENTINEL)
  const symsAll = notifSymbols.includes(ALL_SENTINEL)
  const catsCount = catsAll ? allCats.length : notifCats.filter((c) => c !== ALL_SENTINEL).length
  const symsCount = symsAll ? allSymbols.length : notifSymbols.filter((s) => s !== ALL_SENTINEL).length
  const hourCells = notifWinOn ? windowHours(notifWinStart, notifWinEnd) : null
  let rowIndex = 0

  return (
    <div>
      {/* 页头用全站统一的 PageHead；下面才是姓名 + 身份牌那块 hero。
          The site-wide PageHead; the name + plate hero follows. */}
      <PageHead as="h1" title={t("account.title")} />
      {/* ── 顶部：姓名 + 身份牌 / hero ── */}
      <header className="acct-hero">
        <div className="min-w-0">
          <h1 className="font-display-xl acct-name">{displayName}</h1>
          <div className="acct-meta">
            <span className="acct-meta-email">{info.email}</span>
          </div>
          <div className="acct-meta" style={{ marginTop: 10 }}>
            <span>
              {mt5Count > 0
                ? t("account.mt5Linked", { count: mt5Count })
                : t("account.mt5None")}
            </span>
            <i className="acct-meta-dot" aria-hidden />
            <Link to="/bind" className="text-uv hover:underline">
              {t("account.goBind")}
            </Link>
          </div>
        </div>

        <PlateTilt>
          <div className="acct-plate-top">
            <span className="acct-plate-brand">
              <img src="/logo.png" alt="" draggable={false} />
              Signal Lab
            </span>
            <span className={`acct-plan ${isPro ? "pro" : "free"}`}>
              {isPro && info.planIsTrial ? t("account.planTrialTag") : info.plan}
            </span>
          </div>
          {/* 佩戴中的勋章压在光谱线右端，像盖在卡上的封印；不占底行的三列。
              The equipped badge sits on the right end of the spectral rule like a
              seal on the card, leaving the bottom row to its three columns. */}
          {info.gamificationVisible && info.equippedBadge && (
            <span className="acct-plate-badge">
              <BadgeIcon id={info.equippedBadge} tier={null} earned size={48} />
            </span>
          )}
          <div className="acct-plate-rule" aria-hidden />
          <div className="acct-plate-bottom">
            <div className="acct-plate-cols">
              <div className="min-w-0">
                <div className="acct-plate-k">{t("account.plateMemberSince")}</div>
                <div className="acct-plate-v">{fmtDay(info.createdAt)}</div>
              </div>
              <div className="min-w-0">
                <div className="acct-plate-k">{t("account.plateValidThru")}</div>
                <div className="acct-plate-v">
                  {isPro
                    ? info.planExpiresAt
                      ? fmtDay(info.planExpiresAt)
                      : t("account.neverExpires")
                    : "—"}
                </div>
              </div>
              {/* 等级称号只在游戏化对该用户可见且后端算出了等级时才印；否则这一列
                  不出现，牌上只剩两列。
                  The level column prints only when gamification is visible to
                  this user and the backend computed a level; otherwise the
                  plate has two columns. */}
              {info.gamificationVisible && info.gamificationLevel != null && (
                <div className="min-w-0">
                  <div className="acct-plate-k">{t("account.plateLevel")}</div>
                  <div className="acct-plate-v acct-plate-v-wrap">
                    <b className="acct-plate-lv">L{info.gamificationLevel}</b>
                    {info.gamificationTitle ? ` ${t(`gamification.titles.${info.gamificationTitle}`)}` : null}
                  </div>
                </div>
              )}
            </div>
          </div>
        </PlateTilt>
      </header>

      {/* ── 账本 / ledger ── */}
      <div className="acct-ledger">
        {/* 个人资料 / Profile */}
        {/* 昵称这一栏不受内测门控：它是全员必填的（进站时被守卫拦着填过），
            填完总得有个地方能改——门控住就等于逼人设一个再也改不了的名字。
            三个开关仍然只在游戏化开放后才出现：榜单展示 / 退出排行榜 / 公开
            主页，都是在描述当下并不存在的东西。管理员恒为 true，自测不受影响。
            The nickname field is outside the beta wall: it's required of everyone
            (the guard collects it on the way in), so there must be somewhere to
            change it — walling it off would force a name nobody can ever edit.
            The three switches stay behind the wall: leaderboard display, board
            opt-out and public profile all describe things that don't exist yet.
            Admins are always visible=true, so self-testing is unaffected. */}
        <section className="acct-row" style={{ ["--i" as string]: rowIndex++ }}>
            <div>
              <h2 className="font-display acct-row-h">{t("gamification.profile.sectionTitle")}</h2>
              <p className="acct-row-p">
                {info.gamificationVisible ? t("account.profileDesc") : t("account.profileDescBasic")}
              </p>
              {info.gamificationVisible && info.publicId && (
                <Link to={`/u/${info.publicId}`} className="acct-row-link">
                  {t("publicProfile.viewMine")} →
                </Link>
              )}
            </div>
            <div className="acct-row-body">
              <div className="acct-field">
                <label htmlFor="profile-nickname" className="acct-field-l">
                  {t("gamification.profile.nickname")}
                </label>
                <input
                  id="profile-nickname"
                  type="text"
                  value={nicknameDraft}
                  onChange={(e) => setNicknameDraft(e.target.value)}
                  placeholder={t("gamification.profile.nickname")}
                  maxLength={20}
                  className="input"
                />
                <span className="acct-field-help">{t("account.nicknameHelp")}</span>
              </div>
              {info.gamificationVisible && (
              <div className="acct-settings mt-5">
                <div className="acct-setting">
                  <label htmlFor="profile-nickname-public" className="acct-setting-l">
                    <div className="acct-setting-t">{t("gamification.profile.nicknamePublic")}</div>
                    <div className="acct-setting-d">{t("account.nicknamePublicDesc")}</div>
                  </label>
                  <Switch id="profile-nickname-public" checked={nicknamePublicDraft} onChange={setNicknamePublicDraft} />
                </div>
                <div className="acct-setting">
                  <label htmlFor="profile-leaderboard-opt-out" className="acct-setting-l">
                    <div className="acct-setting-t">{t("gamification.profile.leaderboardOptOut")}</div>
                    <div className="acct-setting-d">{t("account.leaderboardOptOutDesc")}</div>
                  </label>
                  <Switch id="profile-leaderboard-opt-out" checked={leaderboardOptOutDraft} onChange={setLeaderboardOptOutDraft} />
                </div>
                <div className="acct-setting">
                  <label htmlFor="profile-stats-public" className="acct-setting-l">
                    <div className="acct-setting-t">{t("account.statsPublic")}</div>
                    <div className="acct-setting-d">{t("account.statsPublicDesc")}</div>
                  </label>
                  <Switch id="profile-stats-public" checked={statsPublicDraft} onChange={setStatsPublicDraft} />
                </div>
              </div>
              )}
              <div className="acct-actions">
                <button onClick={handleProfileSave} className="btn btn-primary" disabled={profileSaving}>
                  {profileSaving ? t("common.loading") : t("gamification.profile.save")}
                </button>
                {profileMsg && <p className={`acct-msg ${profileMsg.kind}`}>{profileMsg.text}</p>}
              </div>
            </div>
        </section>

        {/* 安全 / Security */}
        <section className="acct-row" style={{ ["--i" as string]: rowIndex++ }}>
          <div>
            <h2 className="font-display acct-row-h">{t("account.securityTitle")}</h2>
            <p className="acct-row-p">{t("account.securityDesc")}</p>
          </div>
          <div className="acct-row-body">
            {info.hasPassword && (
              <div className="acct-field">
                <label htmlFor="pw-old" className="acct-field-l">{t("account.oldPassword")}</label>
                <input
                  id="pw-old"
                  type="password"
                  value={oldPw}
                  onChange={(e) => setOldPw(e.target.value)}
                  placeholder={t("account.oldPassword")}
                  className="input"
                  autoComplete="current-password"
                />
              </div>
            )}
            <div className="acct-field">
              <label htmlFor="pw-new" className="acct-field-l">{t("account.newPassword")}</label>
              <input
                id="pw-new"
                type="password"
                value={newPw}
                onChange={(e) => setNewPw(e.target.value)}
                placeholder={t("account.newPassword")}
                className="input"
                autoComplete="new-password"
              />
              <div className="acct-strength" data-level={strength} aria-hidden>
                <i /><i /><i /><i />
              </div>
              <div className="acct-strength-l">
                <span>{t("account.pwStrengthLabel")}</span>
                <b>{strength === 0 ? "—" : t(`account.pwStrength.${strength}`)}</b>
              </div>
            </div>
            <div className="acct-actions">
              <button onClick={handlePassword} className="btn btn-primary">
                {info.hasPassword ? t("account.changePassword") : t("account.setPassword")}
              </button>
              {pwMsg && <p className={`acct-msg ${pwMsg.kind}`}>{pwMsg.text}</p>}
            </div>
          </div>
        </section>

        {/* 通知设置 / Notifications */}
        <section
          id="notifications"
          ref={notifSectionRef}
          className="acct-row scroll-mt-20"
          style={{ ["--i" as string]: rowIndex++ }}
        >
          <div>
            <h2 className="font-display acct-row-h">{t("account.notifications")}</h2>
            <p className="acct-row-p">{t("account.notifDesc")}</p>
          </div>
          <div className="acct-row-body">
            <div className="acct-master">
              <label htmlFor="account-notif-enable" className="acct-setting-l">
                <div className="acct-master-t">{t("account.notifEnable")}</div>
                <div className={`acct-master-s ${notifEnabled ? "on" : ""}`}>
                  <i aria-hidden />
                  {notifLoading
                    ? t("account.notifProcessing")
                    : info.plan === "FREE"
                      ? t("account.notifStateLocked")
                      : notifEnabled
                        ? t("account.notifStateOn")
                        : t("account.notifStateOff")}
                </div>
              </label>
              <Switch
                id="account-notif-enable"
                checked={notifEnabled}
                disabled={info.plan === "FREE"}
                busy={notifLoading}
                onChange={(next) => handleNotifToggle(next)}
              />
            </div>
            {info.plan === "FREE" && (
              <p className="acct-hint">
                {t("account.notifUpgradeRequired")}{" "}
                <Link to="/upgrade" className="text-uv hover:underline">
                  {t("nav.upgrade")}
                </Link>
              </p>
            )}
            {notifEnabled && hintKey && <p className="acct-hint warn">{t(hintKey)}</p>}
            {notifEnabled && <p className="acct-hint">{t("account.notifFilterHint")}</p>}

            {notifEnabled && (
              <div className="acct-group">
                <div className="acct-group-h">
                  <span className="sec-h-title">{t("account.notifStrategyLabel")}</span>
                  {allCats.length > 0 && (
                    <span className="acct-group-n">{catsCount}/{allCats.length}</span>
                  )}
                </div>
                {allCats.length === 0 ? (
                  <p className="acct-field-help">{t("account.notifNoCategories")}</p>
                ) : (
                  <div className="acct-chips">
                    <button
                      type="button"
                      className="acct-chip acct-chip-all"
                      aria-pressed={catsAll}
                      onClick={() => handleNotifCatToggle(ALL_SENTINEL, !catsAll)}
                    >
                      {t("account.notifAll")}
                    </button>
                    {allCats.map((cat) => {
                      const on = notifCats.includes(cat)
                      return (
                        <button
                          key={cat}
                          type="button"
                          className="acct-chip"
                          aria-pressed={on}
                          data-included={catsAll || undefined}
                          disabled={catsAll}
                          onClick={() => handleNotifCatToggle(cat, !on)}
                        >
                          {cat}
                        </button>
                      )
                    })}
                    {/* 我的策略信号：数据上是事件白名单（单用户推送路径），UI 上归入
                        按策略——对用户而言它就是"我自己策略发出的信号"。不受上面
                        「全部」哨兵影响（那是平台策略类别的维度）。
                        My strategy signals: event-whitelist data (the single-user
                        push path) presented under "by strategy" — to the user it's
                        simply "signals from my own strategies". Unaffected by the
                        "全部" sentinel above (that's the platform-category
                        dimension). */}
                    <i className="acct-chip-sep" aria-hidden />
                    <button
                      type="button"
                      className="acct-chip"
                      aria-pressed={notifEvents.includes(EVENT_STRATEGY_SIGNAL)}
                      onClick={() =>
                        handleNotifEventToggle(EVENT_STRATEGY_SIGNAL, !notifEvents.includes(EVENT_STRATEGY_SIGNAL))
                      }
                    >
                      {t("account.notifEvent.strategy_signal")}
                    </button>
                  </div>
                )}
              </div>
            )}

            {notifEnabled && (
              <div className="acct-group">
                <div className="acct-group-h">
                  <span className="sec-h-title">{t("account.notifSymbolLabel")}</span>
                  {allSymbols.length > 0 && (
                    <span className="acct-group-n">{symsCount}/{allSymbols.length}</span>
                  )}
                </div>
                {allSymbols.length === 0 ? (
                  <p className="acct-field-help">{t("account.notifNoSymbols")}</p>
                ) : (
                  <div className="acct-chips">
                    <button
                      type="button"
                      className="acct-chip acct-chip-all"
                      aria-pressed={symsAll}
                      onClick={() => handleNotifSymbolToggle(ALL_SENTINEL, !symsAll)}
                    >
                      {t("account.notifAll")}
                    </button>
                    {allSymbols.map((sym) => {
                      const on = notifSymbols.includes(sym)
                      return (
                        <button
                          key={sym}
                          type="button"
                          className="acct-chip"
                          aria-pressed={on}
                          data-included={symsAll || undefined}
                          disabled={symsAll}
                          onClick={() => handleNotifSymbolToggle(sym, !on)}
                        >
                          {t(`signals.symbolNames.${sym}`, { defaultValue: "" }) || sym}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            )}

            {/* 「交易与账户提醒」「成就提醒」两组开关 2026-09-07 撤掉：这些事件在总开关
                打开后一律推送（后端 push_dispatch.ALWAYS_ON_EVENTS），不再让用户逐项勾选。
                The "trading & account" / "achievement" toggle groups were removed
                (2026-09-07): those events push whenever notifications are on
                (backend push_dispatch.ALWAYS_ON_EVENTS), no per-event opt-out. */}
            {/* 推送时段 / push window */}
            {notifEnabled && (
              <div className="acct-group">
                <div className="acct-group-h">
                  <span className="sec-h-title">{t("account.notifWindowHeading")}</span>
                  <span className="acct-group-n">
                    {notifWinOn ? `${notifWinStart} – ${notifWinEnd}` : t("account.notifWindowAllDay")}
                  </span>
                </div>
                <div className="acct-setting" style={{ padding: 0, borderTop: 0 }}>
                  <label htmlFor="account-notif-window" className="acct-setting-l">
                    <div className="acct-setting-t">{t("account.notifWindowEnable")}</div>
                  </label>
                  <Switch id="account-notif-window" checked={notifWinOn} onChange={handleWinToggle} />
                </div>
                {notifWinOn && hourCells && (
                  <>
                    <div className="acct-window">
                      <input
                        type="time"
                        value={notifWinStart}
                        onChange={(e) => handleWinTime("start", e.target.value)}
                        className="input"
                        aria-label={t("account.notifWindowHeading")}
                      />
                      <span className="acct-window-to">{t("account.notifWindowTo")}</span>
                      <input
                        type="time"
                        value={notifWinEnd}
                        onChange={(e) => handleWinTime("end", e.target.value)}
                        className="input"
                        aria-label={t("account.notifWindowHeading")}
                      />
                    </div>
                    <div className="acct-hours" aria-hidden>
                      {hourCells.map((on, h) => (
                        <i key={h} className={on ? "on" : undefined} />
                      ))}
                    </div>
                    <div className="acct-hours-ticks" aria-hidden>
                      <span>00</span><span>06</span><span>12</span><span>18</span><span>24</span>
                    </div>
                    <p className="acct-hint">{t("account.notifWindowHint", { tz })}</p>
                  </>
                )}
              </div>
            )}
            {notifMsg && <p className={`acct-msg ${notifMsg.kind} mt-4`}>{notifMsg.text}</p>}
            <PushDiagnostics />
          </div>
        </section>
      </div>
    </div>
  )
}

// ── 页内小部件 / page-local helpers ──

// 身份牌只印日期不印时分：一张牌上的「加入于 / 有效期至」是日历日，带上
// 19:23 只会把三列挤爆。时区仍按全站惯例取 UTC+8，日期不需要再打标签。
// The plate prints calendar days, not clock times: "member since / valid thru"
// are dates, and a 19:23 suffix only overflows the three columns. The zone is
// still the site-wide UTC+8; a bare date needs no label.
function fmtDay(iso: string | null | undefined): string {
  if (!iso) return "—"
  const hasTz = /[zZ]|[+-]d{2}:?d{2}$/.test(iso)
  const d = new Date(hasTz ? iso : iso + "Z")
  return d.toLocaleDateString("en-GB", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" })
}

// 密码强度：纯视觉反馈，不是校验——校验仍是 handlePassword 的「至少 8 位」和后端。
// 不足 8 位一律记「弱」，之后按长度 ≥12、字母+数字、含符号各加一档。
// Password strength: visual feedback only, not validation — that stays with
// handlePassword's 8-char floor and the backend. Under 8 is always "weak";
// then ≥12 chars, letters+digits, and a symbol each add a step.
function pwStrength(pw: string): 0 | 1 | 2 | 3 | 4 {
  if (!pw) return 0
  if (pw.length < 8) return 1
  let s = 1
  if (pw.length >= 12) s++
  if (/[A-Za-z]/.test(pw) && /\d/.test(pw)) s++
  if (/[^A-Za-z0-9]/.test(pw)) s++
  return Math.min(4, s) as 1 | 2 | 3 | 4
}

// 24 格小时条：每格取该小时的中点判断是否落在时段内；起点 ≥ 终点按跨零点处理，
// 与后端的隔夜语义一致（见 notifWindowHint 文案）。
// The 24-cell hour strip: each cell tests its hour's midpoint against the
// window; start ≥ end wraps overnight, matching the backend's semantics.
function windowHours(start: string, end: string): boolean[] {
  const toMin = (s: string) => {
    const [h, m] = s.split(":").map(Number)
    return (h || 0) * 60 + (m || 0)
  }
  const s = toMin(start)
  const e = toMin(end)
  return Array.from({ length: 24 }, (_, h) => {
    const mid = h * 60 + 30
    return s < e ? mid >= s && mid < e : mid >= s || mid < e
  })
}

// 身份牌的指针倾斜：与 badges/MedalTilt 同一套 ref + rAF 手法（不进 React
// 渲染循环），只是角度从勋章的 ±22° 收到卡片的 ±5° / ±7°——一张 400px 的牌
// 转 22° 会像在甩它。prefers-reduced-motion 下完全不动，与 CSS 那侧双保险。
// Pointer tilt for the plate: the same ref + rAF technique as badges/MedalTilt
// (outside React's render loop), with the angle pulled from the medal's ±22°
// down to ±5° / ±7° — a 400px plate at 22° looks flung. prefers-reduced-motion
// disables it entirely, doubling up with the CSS side.
function PlateTilt({ children }: { children: ReactNode }) {
  const elRef = useRef<HTMLDivElement | null>(null)
  const rafRef = useRef<number | null>(null)
  const pendingRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null)
  const reducedRef = useRef(false)

  useEffect(() => {
    reducedRef.current =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    }
  }, [])

  function apply() {
    rafRef.current = null
    const el = elRef.current
    const p = pendingRef.current
    if (!el || !p) return
    pendingRef.current = null
    const dx = p.x / p.w - 0.5
    const dy = p.y / p.h - 0.5
    el.style.transform = `rotateX(${(-dy * 5).toFixed(2)}deg) rotateY(${(dx * 7).toFixed(2)}deg)`
    el.style.setProperty("--lx", `${((p.x / p.w) * 100).toFixed(1)}%`)
    el.style.setProperty("--ly", `${((p.y / p.h) * 100).toFixed(1)}%`)
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (reducedRef.current) return
    const el = elRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    pendingRef.current = { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height }
    el.classList.add("no-transition")
    if (rafRef.current == null) rafRef.current = requestAnimationFrame(apply)
  }

  function onPointerLeave() {
    const el = elRef.current
    if (!el) return
    el.classList.remove("no-transition")
    el.style.transform = ""
  }

  return (
    <div className="acct-plate-wrap">
      <div ref={elRef} className="acct-plate" onPointerMove={onPointerMove} onPointerLeave={onPointerLeave}>
        {children}
        <div className="acct-plate-light" aria-hidden />
      </div>
    </div>
  )
}
