// 公告弹窗：管理员给某条公告勾了「弹窗展示」后，用户登录进来会看到一张整图卡片，
// 点图直接进那条公告的详情页。图就是弹窗本体，所以后端只把「已发布 + 开了弹窗 +
// 有封面图」的公告当候选，没图的压根不会返回。
//
// 两种关掉的方式，语义不同：
//   × —— 这次不看。只记在 sessionStorage，浏览器标签关掉就忘，下次进来还会弹。
//   7 天不再提醒 —— 记在服务端（POST /announcements/{id}/popup-snooze）。跨设备，
//     因为同一个人在手机 App 与网页上各按一次才安静，本身就是弹窗最招人烦的形态。
// 读过（进过详情页）之后后端也不会再返回它——弹窗的目的是把人带过去，人已经去过了。
//
// Announcement popup: when an admin ticks "show as popup", users get a full-card
// image that links straight to that announcement's detail page. The image *is* the
// popup, so the backend only considers published rows that enable it and have a
// cover image; ones without never come back.
//
// Two ways to dismiss, with different meanings:
//   × — not now. sessionStorage only, forgotten when the tab closes.
//   Don't remind me for 7 days — server-side (POST …/popup-snooze), so it follows
//     the account across devices: making someone dismiss the same popup once in
//     the app and again on the web is exactly what makes a popup obnoxious.
// Opening the detail also retires it: the popup exists to send people there.
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { announcementApi } from '../api/client'
import type { AnnouncementPopup as PopupData } from '../api/types'
import { useBackToClose } from '../utils/useBackToClose'

// 本次会话已经按掉的那条。sessionStorage 在无痕窗口 / 禁用站点数据时可能直接抛，
// 读写都得包起来——拿不到存储只是"下次再弹一次"，不该让整个弹窗渲染不出来。
// The one dismissed this session. sessionStorage can throw outright in private
// windows or with site data blocked, so both sides are guarded: losing it only
// costs one extra appearance, and must never take the popup down with it.
const SESSION_KEY = 'prismx_ann_popup_closed'

function sessionClosedId(): string | null {
  try {
    return sessionStorage.getItem(SESSION_KEY)
  } catch {
    return null
  }
}

function rememberClosed(id: string): void {
  try {
    sessionStorage.setItem(SESSION_KEY, id)
  } catch {
    /* 存不下就下次再弹一次 / one more appearance is the whole cost */
  }
}

export default function AnnouncementPopup() {
  const { t, i18n } = useTranslation()
  const isZh = i18n.language !== 'en'
  const navigate = useNavigate()
  const [data, setData] = useState<PopupData | null>(null)
  const [visible, setVisible] = useState(false)
  const [busy, setBusy] = useState(false)

  // 只在挂载时问一次。弹窗是"进站时打个招呼"，跟着路由每次重问既多余又会在用户
  // 正操作时突然盖上来。/ Asked once on mount: this is a greeting on arrival, and
  // re-asking on every route change would both waste calls and drop a modal on
  // someone mid-task.
  useEffect(() => {
    let alive = true
    announcementApi
      .popup()
      .then((res) => {
        if (!alive || !res) return
        if (sessionClosedId() === res.id) return
        setData(res)
        setVisible(true)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  const close = () => {
    if (data) rememberClosed(data.id)
    setVisible(false)
  }

  useBackToClose(visible, close)

  useEffect(() => {
    if (!visible) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [visible, data])

  if (!visible || !data) return null

  const title = isZh ? data.titleZh || data.titleEn : data.titleEn || data.titleZh

  const open = () => {
    // 详情页会把这条记成已读，后端从此不再把它当候选——不需要在这里再写一次
    // 本地状态。/ The detail page marks it read and the backend stops offering
    // it, so there is nothing to record locally.
    setVisible(false)
    navigate(`/announcements/${data.id}`)
  }

  const snooze = async () => {
    if (busy) return
    setBusy(true)
    try {
      await announcementApi.snoozePopup(data.id)
    } catch {
      // 落库失败就退回"本次不看"：按钮按下去必须有反应，7 天与这一次的差别
      // 下次进来自会显现。/ Fall back to "not now" on failure: the press has to
      // do something, and the difference shows up on the next visit anyway.
    } finally {
      setBusy(false)
      close()
    }
  }

  return createPortal(
    <div className="ann-pop-overlay" onClick={close}>
      <div
        className="ann-pop"
        role="dialog"
        aria-modal="true"
        aria-label={title || t('announcements.title')}
        onClick={(e) => e.stopPropagation()}
      >
        <button type="button" className="ann-pop-x" onClick={close} aria-label={t('common.close')}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
        <button type="button" className="ann-pop-img" onClick={open}>
          {/* alt 用公告标题：这张图承载全部内容，读屏用户只有这一句可听。
              alt is the announcement title — the image carries everything, and it
              is all a screen-reader user gets. */}
          <img src={data.coverImageUrl} alt={title} />
        </button>
        <div className="ann-pop-foot">
          <button type="button" className="ann-pop-cta" onClick={open}>
            {t('announcements.popupOpen')}
          </button>
          <button type="button" className="ann-pop-snooze" onClick={snooze} disabled={busy}>
            {t('announcements.popupSnooze')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
