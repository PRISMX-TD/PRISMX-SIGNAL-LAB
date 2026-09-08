// 公告列表页（/announcements）：置顶优先、再按发布时间倒序，未读行带紫点。
// 与客服工单同一套账本行；样式在 styles/announcements.css（.ann-*）。
// Announcement list (/announcements): pinned first, then newest; unread rows carry
// a violet dot. Same ledger rows as support tickets; styled by announcements.css.
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import PageHead from '../components/PageHead'
import { announcementApi } from '../api/client'
import { localizeApiError, parseTime } from '../api/utils'
import { useDocumentTitle } from '../utils/useDocumentTitle'
import type { Announcement } from '../api/types'

export function fmtAnnDay(iso: string | null): string {
  const d = iso ? parseTime(iso) : null
  if (!d) return ''
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return d.toLocaleDateString(undefined, sameYear ? { month: '2-digit', day: '2-digit' } : { year: 'numeric', month: '2-digit', day: '2-digit' })
}

export default function AnnouncementsPage() {
  const { t, i18n } = useTranslation()
  const isZh = i18n.language !== 'en'
  const pick = (zh: string, en: string) => (isZh ? zh || en : en || zh)
  useDocumentTitle(t('announcements.title'))
  const [items, setItems] = useState<Announcement[] | null>(null)
  const [unread, setUnread] = useState(0)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    announcementApi
      .list()
      .then((res) => {
        if (!alive) return
        setItems(res.items)
        setUnread(res.unreadCount)
      })
      .catch((err: unknown) => {
        if (alive) setError(localizeApiError(err instanceof Error ? err.message : String(err)))
      })
    return () => { alive = false }
  }, [])

  return (
    <div className="ann-wrap">
      <PageHead
        as="h1"
        title={t('announcements.title')}
        count={unread > 0 ? unread : null}
        countUnit={t('announcements.unread')}
        subtitle={t('announcements.subtitle')}
      />
      {error && <div className="sup-msg err" role="alert">{error}</div>}

      <section className="card glass ann-list" aria-busy={items == null || undefined}>
        {items == null ? (
          [0, 1, 2].map((i) => (
            <div key={i} className="ann-skel" aria-hidden="true">
              <span />
              <span>
                <span className="skeleton" style={{ display: 'block', width: '44%', height: 14 }} />
                <span className="skeleton" style={{ display: 'block', width: '70%', height: 10, marginTop: 8 }} />
              </span>
              <span className="skeleton" style={{ display: 'block', height: 12 }} />
            </div>
          ))
        ) : items.length === 0 ? (
          <div className="ann-empty">
            <svg viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M7 17v6a2 2 0 0 0 2 2h4l12 6V9L13 15H9a2 2 0 0 0-2 2z" />
              <path d="M30 16a6 6 0 0 1 0 8M13 25v7h4" />
            </svg>
            <b>{t('announcements.empty')}</b>
            <p>{t('announcements.emptyHint')}</p>
          </div>
        ) : (
          items.map((a, i) => (
            <Link
              key={a.id}
              to={`/announcements/${a.id}`}
              className={`ann-row${a.read ? '' : ' unread'}`}
              style={{ '--i': i } as React.CSSProperties}
            >
              <i className="ann-row-dot" aria-hidden="true" />
              <span className="ann-row-main">
                <span className="ann-row-title">
                  {a.pinned && <span className="ann-pin">{t('announcements.pinned')}</span>}
                  <b>{pick(a.titleZh, a.titleEn)}</b>
                </span>
                {(a.summaryZh || a.summaryEn) && <span className="ann-row-sum">{pick(a.summaryZh, a.summaryEn)}</span>}
              </span>
              <span className="ann-row-end">
                <time className="num" dateTime={a.publishedAt ?? undefined}>{fmtAnnDay(a.publishedAt)}</time>
                <svg className="chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
              </span>
            </Link>
          ))
        )}
      </section>
    </div>
  )
}
