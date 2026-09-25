// 顶栏通知铃铛：2026-09-08 重做，2026-09-16 加入「消息」段与一键已读。
// 面板三段：上段是站内通知（发生在你身上的事——工单有人回了；管理员还会收到新工单），
// 中段是最近的公告（账本行，未读点 / 置顶 ｜ 标题与摘要 ｜ 日期，点进详情页），
// 下段仍是信号推送的主开关 + 「完整设置」入口，开关逻辑原样保留。
// 角标：有未读（通知 + 公告）显示紫色数字；没有未读时才退回推送状态点（琥珀 = 需要处理）。
// 样式在 styles/announcements.css（.nb-*）。
// 两份列表在面板打开时重拉，另外各自跟着自己的 WS 计数器走：公告是广播、站内通知
// 是点对点，合用一个计数器会让每条公告都白白触发一次 feed 重拉。
// Top-bar bell, redone 2026-09-08; "messages" section and mark-all-read added
// 2026-09-16. Three sections: in-app notifications (things that happened to you —
// a reply on your ticket; admins also get new tickets), recent announcements as
// ledger rows (unread dot / pinned | title and summary | date) linking to the
// detail page, and the push master switch plus full-settings link, logic
// unchanged. Badge: a violet unread count (feed + announcements) wins; with
// nothing unread the push status dot shows (amber = needs attention). Styled by
// styles/announcements.css (.nb-*). Both lists refetch when the panel opens and
// each follows its own WS counter — announcements broadcast, notifications are
// point-to-point, so one shared counter would refetch the feed for every
// announcement.
import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Link } from "react-router-dom"
import { announcementApi, notificationApi } from "../api/client"
import { fmtDayShort } from "../api/utils"
import type { Announcement, NotificationFeedItem } from "../api/types"
import { useLive } from "../store/live"
import { detectPushEnv, PUSH_ENV_HINT_KEYS } from "../utils/pushEnv"
import { disableNotifications, enableNotifications, ENABLE_ERROR_KEYS, NotifEnableError } from "../utils/notifications"
import { useBackToClose } from "../utils/useBackToClose"
import { getSharedNotifPrefs, invalidateSharedNotifPrefs, updateSharedNotifPrefs } from "../utils/notifPrefsShared"
import Switch from "./Switch"
import { FestivalEmptyMini, FestivalTopper } from "../festival/FestivalDecor"

type Status = "off" | "on" | "attention"
const PANEL_ITEMS = 5
const PANEL_MESSAGES = 4

// 日期格式化改用 api/utils 的 fmtDayShort（本文件原来自带一份）。
// 差别在于时区：原来那份走 toLocaleDateString(undefined, …)，即**浏览器本地时区**，
// 而全站的约定是固定 UTC+8（见 api/utils 头注：不固定时区，国际用户会把它读成
// 自己的本地时间从而读错实际发生时刻）。欧美时区的管理员看这一列时日期会整天偏移。
// Date formatting now comes from api/utils' fmtDayShort; this file used to carry
// its own copy. The difference is the zone: the old copy used
// toLocaleDateString(undefined, …), i.e. the *browser's* zone, whereas the site
// fixes everything to UTC+8 (see api/utils' header: an unpinned zone reads as the
// viewer's own local time and misstates when things happened). For an admin
// outside UTC+8 this column was off by a whole day.

export default function NotificationBell() {
  const { t, i18n } = useTranslation()
  const isZh = i18n.language !== "en"
  const { announcementTick, notificationTick } = useLive()
  const [open, setOpen] = useState(false)
  // 弹层不是全屏遮罩，理论上打开时还能点穿到别的导航链接——useBackToClose
  // 内部已经对"打开期间发生了别的真实导航"这种情况做了防护（不会误把那次
  // 导航撤销掉），所以这里可以放心接入，划返回时先收起弹层而不是离开页面。
  // The panel isn't a full-screen overlay, so in principle a nav link could
  // still be clicked while it's open — useBackToClose already guards against
  // "a real navigation happened while open", so swiping back closes the panel
  // first rather than leaving the page.
  useBackToClose(open, () => setOpen(false))
  const [enabled, setEnabled] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // 与 err 分开：这一条不是失败，是"开了，但这台设备可能收不到后台通知"。
  const [note, setNote] = useState<string | null>(null)
  const [anns, setAnns] = useState<Announcement[] | null>(null)
  const [unread, setUnread] = useState(0)
  const [feed, setFeed] = useState<NotificationFeedItem[]>([])
  const [feedUnread, setFeedUnread] = useState(0)
  const [readingAll, setReadingAll] = useState(false)
  const [clearing, setClearing] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  // 共享读取：挂载时与 Layout / NotifDeviceBanner 的同一请求合并（utils/notifPrefsShared）。
  // Shared read, deduped with Layout's and NotifDeviceBanner's on mount.
  const refresh = () => {
    getSharedNotifPrefs()
      .then((p) => setEnabled(p.enabled))
      .catch(() => {})
      .finally(() => setLoaded(true))
  }
  // 两个列表各自一个自增序号，只接受最新一次的响应。
  //
  // 三个 effect 都会触发拉取（挂载、WS 计数器变化、面板打开），而"收到
  // ANNOUNCEMENT_NEW 的同一刻打开面板"会让同一份数据有两个在途请求——先发后到的
  // 那个会把后发的结果盖掉，角标可能因此少一条。用序号而不是 AbortSignal：铃铛是
  // 常驻组件，这里要挡的是"旧响应盖新响应"，不是"卸载后 setState"，而且中止一个
  // 已经在路上的请求并不会让答案更早到达。
  //
  // One monotonically increasing sequence per list; only the latest response is
  // accepted. All three effects trigger a fetch (mount, WS counter, panel open),
  // and opening the panel at the moment an ANNOUNCEMENT_NEW arrives leaves two
  // in-flight requests for the same data — the earlier one landing last
  // overwrites the later, which can drop one from the badge. A sequence rather
  // than an AbortSignal: the bell is always mounted, so the hazard is a stale
  // response overwriting a fresh one rather than setState-after-unmount, and
  // aborting a request already on the wire doesn't make the answer arrive sooner.
  const annsSeq = useRef(0)
  const feedSeq = useRef(0)

  const loadAnns = () => {
    const seq = ++annsSeq.current
    announcementApi
      .list()
      .then((res) => {
        if (seq !== annsSeq.current) return
        setAnns(res.items)
        setUnread(res.unreadCount)
      })
      .catch(() => {
        if (seq !== annsSeq.current) return
        setAnns((prev) => prev ?? [])
      })
  }
  const loadFeed = () => {
    const seq = ++feedSeq.current
    notificationApi
      .feed(PANEL_MESSAGES)
      .then((res) => {
        if (seq !== feedSeq.current) return
        setFeed(res.items)
        setFeedUnread(res.unreadCount)
      })
      .catch(() => {})
  }

  useEffect(() => {
    refresh()
  }, [])
  // 首次挂载与每次新公告广播都重拉：角标必须在不打开面板的情况下也是对的。
  // Fetch on mount and on every new-announcement broadcast: the badge has to be
  // right without the panel ever being opened.
  useEffect(() => {
    loadAnns()
  }, [announcementTick])
  useEffect(() => {
    loadFeed()
  }, [notificationTick])
  useEffect(() => {
    if (open) {
      loadAnns()
      loadFeed()
    }
  }, [open])

  // 面板打开时：点击外部关闭 / close on outside click while the panel is open
  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onClick)
    return () => document.removeEventListener("mousedown", onClick)
  }, [open])

  const env = detectPushEnv()
  const hintKey = PUSH_ENV_HINT_KEYS[env]
  // hintKey 为 null 即环境完全就绪（granted/ready），无需提示。
  // A null hintKey means the environment is fully ready (granted/ready).
  const status: Status = !enabled ? "off" : env === "granted" ? "on" : "attention"

  async function handleToggle(on: boolean) {
    setErr(null)
    setNote(null)
    setBusy(true)
    try {
      if (!on) {
        setEnabled(false)
        await disableNotifications()
        updateSharedNotifPrefs({ enabled: false })
      } else {
        // 主开关的落库是整体覆盖，取当前完整偏好再原样带上，避免把用户已选的
        // 策略/品种/事件筛选清空。这一步网络请求必须放在 enableNotifications
        // 内部、权限申请之后才做——放在权限申请之前会在权限调用前插入一次
        // await，iOS Safari 会因此不弹出系统权限框（见 enableNotifications 注释）。
        // The prefs PUT overwrites the whole object — fetch the current full
        // prefs and carry them through so this quick toggle doesn't blank out
        // whatever filters the user already picked. This fetch must happen
        // inside enableNotifications, after the permission request; an await
        // before it keeps iOS Safari from showing the permission sheet at all.
        const r = await enableNotifications(() =>
          notificationApi.getPrefs().then((prefs) => ({
            selected_categories: prefs.selected_categories,
            selected_symbols: prefs.selected_symbols,
            event_types: prefs.event_types,
          })),
        )
        setEnabled(true)
        updateSharedNotifPrefs({ enabled: true })
        // 偏好已经落库=账号层面确实开了，开关就该是「开」。这台设备没能建起推送订阅
        // 是另一件事，如实说一句，但不能把开关弹回「关」——弹回去会和服务端状态对不上，
        // 刷新一次又变回「开」；而在拿不到 Google 推送通道的网络里（中国大陆），
        // 通知其实是通的（App 走后台长连接兜底），一句"开启失败"会白白把人劝退。
        if (!r.deviceSubscribed) setNote(t("account.notifDeviceFailed"))
      }
    } catch (e: unknown) {
      setEnabled(!on)
      // 落库成没成不确定：丢掉共享值，下一个读的人重新问后端。
      // Unknown whether the PUT landed: drop the shared value so the next reader asks.
      invalidateSharedNotifPrefs()
      setErr(e instanceof NotifEnableError ? t(ENABLE_ERROR_KEYS[e.reason]) : t("account.notifError"))
    } finally {
      setBusy(false)
    }
  }

  // 一键已读：先乐观地把面板清干净，再落库。失败就把两份列表重拉回来——
  // 让界面短暂说了假话，好过让用户对着一个点了没反应的按钮再点第二次。
  // Mark-all-read: clear the panel optimistically, then persist. On failure both
  // lists are refetched — a UI that briefly lied beats a button that looks dead
  // and gets pressed again.
  async function handleReadAll() {
    if (readingAll) return
    setReadingAll(true)
    setUnread(0)
    setFeedUnread(0)
    setAnns((prev) => (prev ? prev.map((a) => ({ ...a, read: true })) : prev))
    setFeed((prev) => prev.map((n) => ({ ...n, read: true })))
    try {
      await notificationApi.readAll()
    } catch {
      loadAnns()
      loadFeed()
    } finally {
      setReadingAll(false)
    }
  }

  // 清空消息：确认后乐观清掉列表再落库，失败就重拉。只动「消息」段，公告不受影响。
  // Clear messages: confirm, clear optimistically, persist; refetch on failure.
  // Only the feed — announcements are untouched.
  async function handleClearFeed() {
    if (clearing || !window.confirm(t("notifPanel.clearConfirm"))) return
    setClearing(true)
    setFeed([])
    setFeedUnread(0)
    try {
      await notificationApi.clearFeed()
    } catch {
      loadFeed()
    } finally {
      setClearing(false)
    }
  }

  // 点开一条通知即已读。不等接口返回、也不处理失败：用户已经在跳页了，
  // 下次拉 feed 时以服务端为准。
  // Following a notification marks it read. Not awaited and failures are ignored:
  // the user is already navigating away, and the next feed fetch is authoritative.
  const followFeedItem = (item: NotificationFeedItem) => {
    setOpen(false)
    if (item.read) return
    setFeed((prev) => prev.map((n) => (n.id === item.id ? { ...n, read: true } : n)))
    setFeedUnread((n) => Math.max(0, n - 1))
    void notificationApi.markFeedRead(item.id).catch(() => {})
  }

  const pick = (zh: string, en: string) => (isZh ? zh || en : en || zh)
  const shown = (anns ?? []).slice(0, PANEL_ITEMS)
  const totalUnread = unread + feedUnread

  return (
    <div ref={rootRef} className="nb">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={t("notifPanel.title")}
        aria-expanded={open}
        className={`nb-btn ${status}${open ? " open" : ""}`}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {totalUnread > 0 ? (
          <span className="nb-count num">{totalUnread > 9 ? "9+" : totalUnread}</span>
        ) : (
          status !== "off" && <i className="nb-dot" aria-hidden="true" />
        )}
        <FestivalTopper kind="mini" />
      </button>

      {open && (
        <div className="card glass nb-panel" role="dialog" aria-label={t("notifPanel.title")}>
          <div className="nb-head">
            <h3>{t("notifPanel.title")}</h3>
            {totalUnread > 0 && (
              <>
                <b className="num">{totalUnread}</b>
                <span>{t("notifPanel.unread")}</span>
              </>
            )}
            {totalUnread > 0 && (
              <button type="button" className="nb-readall" onClick={handleReadAll} disabled={readingAll}>
                {t("notifPanel.markAllRead")}
              </button>
            )}
          </div>

          {feed.length > 0 && (
            <section aria-label={t("notifPanel.messages")}>
              <div className="nb-sec-head">
                <span className="cap">{t("notifPanel.messages")}</span>
                <button type="button" className="nb-readall" onClick={handleClearFeed} disabled={clearing}>
                  {t("notifPanel.clearMessages")}
                </button>
              </div>
              {feed.map((n) => (
                <Link
                  key={n.id}
                  to={n.link || "/support"}
                  onClick={() => followFeedItem(n)}
                  className={`nb-ann${n.read ? "" : " unread"}`}
                >
                  <i className="nb-ann-dot" aria-hidden="true" />
                  <span className="nb-ann-main">
                    <span className="nb-ann-title">
                      <b>{t(`notifFeed.${n.kind}`)}</b>
                    </span>
                    {n.text && <span className="nb-ann-sum">{n.text}</span>}
                  </span>
                  <time className="num" dateTime={n.createdAt}>{fmtDayShort(n.createdAt)}</time>
                </Link>
              ))}
            </section>
          )}

          <section aria-label={t("notifPanel.announcements")}>
            <div className="nb-sec-head">
              <span className="cap">{t("notifPanel.announcements")}</span>
              <Link to="/announcements" onClick={() => setOpen(false)}>
                {t("notifPanel.allAnnouncements")} →
              </Link>
            </div>
            {anns == null ? (
              <div className="nb-skel" aria-hidden="true">
                <span className="skeleton" style={{ display: "block", width: "60%", height: 12 }} />
                <span className="skeleton" style={{ display: "block", width: "85%", height: 10 }} />
              </div>
            ) : shown.length === 0 ? (
              <p className="nb-empty">
                <FestivalEmptyMini />
                {t("notifPanel.noAnnouncements")}
              </p>
            ) : (
              shown.map((a) => (
                <Link
                  key={a.id}
                  to={`/announcements/${a.id}`}
                  onClick={() => setOpen(false)}
                  className={`nb-ann${a.read ? "" : " unread"}`}
                >
                  <i className="nb-ann-dot" aria-hidden="true" />
                  <span className="nb-ann-main">
                    <span className="nb-ann-title">
                      {a.pinned && <span className="ann-pin">{t("announcements.pinned")}</span>}
                      <b>{pick(a.titleZh, a.titleEn)}</b>
                    </span>
                    {(a.summaryZh || a.summaryEn) && <span className="nb-ann-sum">{pick(a.summaryZh, a.summaryEn)}</span>}
                  </span>
                  <time className="num" dateTime={a.publishedAt ?? undefined}>{fmtDayShort(a.publishedAt)}</time>
                </Link>
              ))
            )}
          </section>

          <section className="nb-push" aria-label={t("notifPanel.push")}>
            <div className="nb-push-row">
              <Switch
                id="notif-bell-enable"
                checked={enabled}
                disabled={!loaded}
                busy={busy}
                onChange={(next) => handleToggle(next)}
              />
              <label htmlFor="notif-bell-enable">{t("account.notifEnable")}</label>
              <Link to="/account#notifications" onClick={() => setOpen(false)}>
                {t("notifPanel.fullSettings")} →
              </Link>
            </div>
            {status === "attention" && <p className="warn">{t(hintKey ?? "account.notifUnsupported")}</p>}
            {err && <p className="err">{err}</p>}
            {note && <p className="warn">{note}</p>}
          </section>
        </div>
      )}
    </div>
  )
}
