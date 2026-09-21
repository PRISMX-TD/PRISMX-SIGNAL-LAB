// 公告详情页（/announcements/:id）：单栏 760px 的文章版式。
// GET 详情的同时后端记已读；上一条 / 下一条来自同一份已发布清单。
//
// 正文是后台富文本框的产物，交给 RichText 按白名单解成 React 节点；2026-09-21
// 之前写的公告还是四种内容块，在 announcementRichBody 里现转成同一种形态，
// 详情页不必同时养两套渲染路径。
//
// 图片一律不裁切：封面图与正文里的图都按原图比例完整展示，最多缩到栏宽。
// 公告配图往往是一整张海报，切掉下半截等于把活动细则切掉。
//
// Announcement detail (/announcements/:id) as one 760px article column. Fetching
// the detail marks it read on the backend; prev/next come from the same published
// list.
//
// The body is what the admin's rich-text box produced, handed to RichText to be
// parsed into React nodes against a whitelist. Posts written before 2026-09-21 are
// still four kinds of content block and are converted on the fly by
// announcementRichBody, so this page keeps only one rendering path.
//
// No image is ever cropped: the cover and any image in the body show in full at
// their own aspect ratio, scaled down only to fit the column. Announcement art is
// usually a whole poster, and cutting the bottom off cuts the terms off with it.
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { announcementApi } from '../api/client'
import { localizeApiError, parseTime } from '../api/utils'
import { safeHttpUrl } from '../utils/safeUrl'
import { useDocumentTitle } from '../utils/useDocumentTitle'
import RichText from '../components/RichText'
import { announcementRichBody } from '../utils/richText'
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

      <article className="ann-body">
        {cover && <img src={cover} alt={title} className="ann-cover" />}
        <RichText html={announcementRichBody(item.blocks, isZh ? 'zh' : 'en')} />
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
