// 公开主页 /u/:publicId（2026-09-07 设计：docs/superpowers/specs/2026-09-07-public-profile-design.md）。
//
// 四块：陈列台（名字 / 等级称号 / 佩戴勋章 / 加入年月）、勋章墙（只有已获得的，
// 复用成就页的 .ach-row/.ach-item 视觉）、榜单成绩（本周本月 × 收益胜率四格 +
// 已终审比赛）、交易画像（对方开了 stats_public 才有；本人自看不论开关都有，
// 但标注"仅你可见"）。数据一次请求；404（不存在 / 已退榜）与 403（内测未开）
// 都退化成一句提示 + 返回，不区分。
//
// Public profile /u/:publicId. Four blocks: stage (name / level & title /
// equipped badges / member since), badge wall (earned only, reusing the
// achievements page's .ach-row/.ach-item look), board standings (week & month
// × return & win-rate tiles + settled competitions) and the trading profile
// (present only when the owner has stats_public on; the owner always sees it,
// labelled "only you"). One request; a 404 (unknown / opted out) or 403 (beta
// closed) both degrade to one line of copy plus a back link.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { gamificationApi } from '../api/client'
import type { PublicProfile } from '../api/types'
import { localizeApiError } from '../api/utils'
import BadgeIcon from '../components/badges/BadgeIcon'
import MedalTilt from '../components/badges/MedalTilt'
import { materialOf } from '../components/badges/medal'
import { SkeletonBlock, SkeletonLine } from '../components/Skeleton'

const TIERS = [1, 2, 3] as const

function fmtPct(score: number, signed: boolean): string {
  const v = (score * 100).toFixed(1) + '%'
  return signed && score > 0 ? '+' + v : v
}

function fmtMonth(iso: string | null): string {
  if (!iso) return '—'
  return iso.replace('-', '/')
}

function fmtDay(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleDateString('en-GB', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
}

export default function ProfilePage() {
  const { t } = useTranslation()
  const { publicId = '' } = useParams()
  const navigate = useNavigate()
  const [data, setData] = useState<PublicProfile | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setData(null)
    setError(null)
    gamificationApi
      .profile(publicId)
      .then((res) => {
        if (!cancelled) setData(res)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? localizeApiError(err.message) : t('publicProfile.notFound'))
      })
    return () => {
      cancelled = true
    }
  }, [publicId, t])

  const back = (
    <button type="button" onClick={() => navigate(-1)} className="pf-back">
      ← {t('publicProfile.back')}
    </button>
  )

  if (error) {
    return (
      <div className="pf">
        {back}
        <div className="pf-empty">
          <p>{error}</p>
          <Link to="/leaderboard" className="text-uv hover:underline">{t('leaderboard.title')}</Link>
        </div>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="pf">
        {back}
        <div className="pf-head">
          <div>
            <SkeletonLine width="40%" height={40} />
            <SkeletonLine width="55%" height={14} className="mt-4" />
          </div>
          <SkeletonBlock height={120} radius={24} />
        </div>
        <div className="pf-boards mt-10">
          {[0, 1, 2, 3].map((i) => <SkeletonBlock key={i} height={96} radius={14} />)}
        </div>
      </div>
    )
  }

  const stats = data.stats
  return (
    <div className="pf">
      {back}

      {/* ── 陈列台 / stage ── */}
      <header className="pf-head">
        <div className="min-w-0">
          <p className="eyebrow">{t('publicProfile.title')}</p>
          <h1 className="font-display-xl pf-name">
            {data.displayName}
            {data.isSelf && <span className="pf-you">{t('leaderboard.youTag')}</span>}
          </h1>
          <div className="pf-meta">
            <span className="pf-lv"><b>L{data.level}</b>{t(`gamification.titles.${data.title}`)}</span>
            <i className="pf-dot" aria-hidden />
            <span>{t('publicProfile.memberSince')} <b className="num">{fmtMonth(data.memberSince)}</b></span>
          </div>
        </div>
        {data.equippedBadges.length > 0 && (
          <div className="pf-equipped" aria-label={t('gamification.equipSlots.title', { defaultValue: '' })}>
            {data.equippedBadges.map((b, i) => (
              <MedalTilt key={b.id} ariaLabel={t(`gamification.badges.${b.id}.name`)} className={i === 0 ? 'is-main' : ''}>
                <BadgeIcon id={b.id} tier={b.tier} earned size={i === 0 ? 104 : 72} spin={i === 0} />
              </MedalTilt>
            ))}
          </div>
        )}
      </header>

      {/* ── 勋章墙 / badge wall ── */}
      <section className="pf-sec" aria-labelledby="pf-badges">
        <div className="ach-sec-h">
          <h3 id="pf-badges"><b>{t('gamification.badgeWall')}</b></h3>
          <div className="r"><b className="num">{data.badges.length}</b></div>
        </div>
        {data.badges.length === 0 ? (
          <p className="pf-none">{t('publicProfile.badgesNone')}</p>
        ) : (
          <ul className="ach-row">
            {data.badges.map((b) => {
              const tiered = b.tier > 0
              return (
                <li key={b.id} className={`ach-item ach-m-${materialOf(b.id, b.tier)}`}>
                  <i className="ach-glow" aria-hidden />
                  <BadgeIcon id={b.id} tier={b.tier} earned size={92} />
                  <b className="ach-name">{t(`gamification.badges.${b.id}.name`)}</b>
                  {tiered && (
                    <span className="ach-tiers" aria-label={t(`gamification.tier.${b.tier}`)}>
                      {TIERS.map((tier) => (
                        <i key={tier} className={`t${tier} ${b.tier >= tier ? 'on' : ''}`} aria-hidden />
                      ))}
                      <small>{t(`gamification.tier.${b.tier}`)}</small>
                    </span>
                  )}
                  {b.awardedAt && (
                    <small className="ach-meta">{t('gamification.stage.awardedOn', { date: fmtDay(b.awardedAt) })}</small>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {/* ── 榜单成绩 / standings ── */}
      <section className="pf-sec" aria-labelledby="pf-boards">
        <div className="ach-sec-h">
          <h3 id="pf-boards"><b>{t('publicProfile.boardsTitle')}</b></h3>
        </div>
        <div className="pf-boards">
          {data.boards.map((bd) => (
            <div key={`${bd.period}-${bd.board}`} className="pf-tile">
              <div className="pf-tile-h">
                <span>{t(`leaderboard.periods.${bd.period}`)}</span>
                <b>{t(`leaderboard.boards.${bd.board}`)}</b>
              </div>
              {bd.entries.length === 0 ? (
                <p className="pf-tile-none">{t('publicProfile.notRanked')}</p>
              ) : (
                <ul className="pf-entries">
                  {bd.entries.map((e) => (
                    <li key={e.login}>
                      <b className="num">#{e.rank}</b>
                      <span className="num">{e.login}</span>
                      <em className={`num ${bd.board === 'return_pct' && e.score < 0 ? 'text-down' : 'text-up'}`}>
                        {fmtPct(e.score, bd.board === 'return_pct')}
                      </em>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
        <div className="pf-comps">
          <div className="pf-comps-h">{t('publicProfile.compsTitle')}</div>
          {data.competitions.length === 0 ? (
            <p className="pf-none">{t('publicProfile.compsNone')}</p>
          ) : (
            <ul className="pf-entries pf-entries-wide">
              {data.competitions.map((c) => (
                <li key={`${c.id}-${c.login}`}>
                  <b className="num">#{c.finalRank}</b>
                  <span className="truncate">{c.name}</span>
                  <span className="num pf-login">{c.login}</span>
                  <em className="num">{c.finalScore != null ? fmtPct(c.finalScore, true) : '—'}</em>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* ── 交易画像 / trading profile ── */}
      {stats && (
        <section className="pf-sec" aria-labelledby="pf-stats">
          <div className="ach-sec-h">
            <h3 id="pf-stats"><b>{t('publicProfile.statsTitle')}</b></h3>
            {data.isSelf && !data.statsPublic && (
              <div className="r"><span className="pf-private">{t('publicProfile.statsPrivateSelf')}</span></div>
            )}
          </div>
          <div className="pf-stats">
            <div className="pf-stat">
              <span>{t('publicProfile.winRate')}</span>
              <b className="num">{stats.winRate == null ? '—' : (stats.winRate * 100).toFixed(1) + '%'}</b>
            </div>
            <div className="pf-stat">
              <span>{t('publicProfile.trades')}</span>
              <b className="num">{stats.trades}</b>
            </div>
            <div className="pf-stat">
              <span>{t('publicProfile.window')}</span>
              <b className="num">{t('publicProfile.windowDays', { n: stats.windowDays })}</b>
            </div>
          </div>
        </section>
      )}
    </div>
  )
}
