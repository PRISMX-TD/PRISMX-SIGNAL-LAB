// 公告详情页（/announcements/:id）：沿用策略详情的文章版式（guide.css），单栏 760px。
// GET 详情的同时后端记已读；上一条 / 下一条来自同一份已发布清单。
// Announcement detail (/announcements/:id), reusing the strategy article layout in
// one 760px column. Fetching the detail marks it read on the backend; prev/next
// come from the same published list.
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { announcementApi } from '../api/client'
import { localizeApiError, parseTime } from '../api/utils'
import { safeHttpUrl } from '../utils/safeUrl'
import { useDocumentTitle } from '../utils/useDocumentTitle'
import { StrategyBlocks } from '../components/strategyGuide'
import { SkeletonPage } from '../components/Skeleton'
import type { Announcement } from '../api/types'

function fmtStamp(iso: string | null): string {
  const d = iso ? parseTime(iso) : null
  return d ? d.toLocaleString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''
}

export default function AnnouncementPage() {
  const { t, i18n } = useTranslation()
  const isZh = i18n.language !== 'en'
  const pick = (zh: string, en: string) => (isZh ? zh || en : en || zh)
  const { id } = useParams<{ id: string }>()
  const [item, setItem] = useState<Announcement | null>(null)
  const [list, setList] = useState<Announcement[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!id) return
    let alive = true
    setLoading(true)
    setError(null)
    Promise.all([announcementApi.get(id), announcementApi.list().catch(() => null)])
      .then(([a, l]) => {
        if (!alive) return
        setItem(a)
        if (l) setList(l.items)
      })
      .catch((err: unknown) => {
        if (alive) setError(localizeApiError(err instanceof Error ? err.message : String(err)))
      })
      .finally(() => { if (alive) setLoading(false) })
    window.scrollTo({ top: 0 })
    return () => { alive = false }
  }, [id])

  const title = item ? pick(item.titleZh, item.titleEn) : ''
  useDocumentTitle(title || t('announcements.title'))

  if (loading) {
    return (
      <div className="ann-detail">
        <SkeletonPage cards={2} />
      </div>
    )
  }
  if (error || !item) {
    return (
      <div className="ann-notfound">
        <p>{error || t('announcements.notFound')}</p>
        <Link to="/announcements" className="btn btn-ghost mt-5 inline-flex">{t('announcements.back')}</Link>
      </div>
    )
  }

  const summary = pick(item.summaryZh, item.summaryEn)
  const cover = safeHttpUrl(item.coverImageUrl)
  const index = list.findIndex((a) => a.id === item.id)
  const prev = index > 0 ? list[index - 1] : null
  const next = index >= 0 && index < list.length - 1 ? list[index + 1] : null

  return (
    <div className="ann-detail">
      <Link to="/announcements" className="guide-back">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
        {t('announcements.back')}
      </Link>

      <header className="guide-detail-head">
        <h1 className="font-display-xl">{title}</h1>
        <div className="ann-meta">
          {item.pinned && <span className="ann-pin">{t('announcements.pinned')}</span>}
          <span>
            {t('announcements.publishedAt')} <time className="num" dateTime={item.publishedAt ?? undefined}>{fmtStamp(item.publishedAt ?? item.createdAt)}</time>
          </span>
        </div>
        {summary && <p className="lede">{summary}</p>}
      </header>

      <article className="guide-article ann-body">
        {cover && <img src={cover} alt={title} className="guide-hero-img" />}
        <StrategyBlocks blocks={item.blocks} isZh={isZh} />
      </article>

      {(prev || next) && (
        <nav className="guide-pager" aria-label={`${t('announcements.prev')} / ${t('announcements.next')}`}>
          {prev ? (
            <Link to={`/announcements/${prev.id}`} className="card glass prev">
              <span className="cap">{t('announcements.prev')}</span>
              <b className="font-display">{pick(prev.titleZh, prev.titleEn)}</b>
            </Link>
          ) : <span />}
          {next ? (
            <Link to={`/announcements/${next.id}`} className="card glass next">
              <span className="cap">{t('announcements.next')}</span>
              <b className="font-display">{pick(next.titleZh, next.titleEn)}</b>
            </Link>
          ) : <span />}
        </nav>
      )}
    </div>
  )
}
