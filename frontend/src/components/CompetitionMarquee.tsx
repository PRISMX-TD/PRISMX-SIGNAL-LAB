// 仪表盘顶部的比赛走马灯：有比赛在报名 / 即将开赛 / 进行中时滚一条横幅，每场一项
//（状态芯片 + 赛名 + 倒计时 + 奖品），点哪一项直接打开那场比赛的详情。没有这类
// 比赛、比赛入口未对该用户开放、或接口失败时整条不渲染，不占任何空间。
//
// 入口门控与侧栏一致：只认 competitionsVisible——关着时后端对普通用户回 403，
// 根本不去请求。列表变化很慢（管理员手动建赛、状态按天推进），5 分钟轮询足够，
// 只在前台轮询，回前台补一次（见 usePollWhileVisible）。
//
// The dashboard's competition marquee: while any competition is open for
// registration, about to start or running, a strip scrolls one item per
// competition (status pill + name + countdown + prize); clicking an item opens
// that competition's detail. With no such competition, the entry gated off for
// this user, or a failed request, nothing renders and no space is taken.
//
// Gated like the sidebar entry, on competitionsVisible alone: when it's off the
// backend answers 403 for regular users, so we don't even ask. The list changes
// slowly (admins create competitions by hand, states advance by the day), so a
// 5-minute poll is plenty — foreground only, with a refetch on return (see
// usePollWhileVisible).
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router-dom'
import type { TFunction } from 'i18next'
import { competitionApi } from '../api/client'
import { parseTime } from '../api/utils'
import type { CompetitionSummary } from '../api/types'
import { useAuth } from '../store/auth'
import { usePollWhileVisible } from '../utils/usePollWhileVisible'
import { fmtCountdown, regState, useNowTicker } from '../utils/competitionTime'

const POLL_MS = 5 * 60_000

type Tag = 'running' | 'regOpen' | 'upcoming'

// 每项的状态与倒计时：进行中数到结束；报名中数到报名截止（这是用户该行动的时刻，
// 比"距开赛"更有用）；报名还没开数到开放报名；其余（自动参赛、报名已截止）数到开赛。
// Each item's state and countdown: running counts to the end; registration open
// counts to its close (the moment the user must act by, more useful than "starts
// in"); registration not yet open counts to its opening; everything else
// (auto-enrolment, registration closed) counts to the start.
function itemOf(c: CompetitionSummary, nowMs: number, t: TFunction): { tag: Tag; label: string; value: string } {
  const until = (iso: string | null) => {
    const at = parseTime(iso)?.getTime()
    return at != null ? fmtCountdown(at - nowMs, t) : ''
  }
  if (c.status === 'running') return { tag: 'running', label: t('competition.cd.toEnd'), value: until(c.endsAt) }
  const reg = regState(c, nowMs)
  if (reg === 'open') return { tag: 'regOpen', label: t('competition.marquee.regCloses'), value: until(c.regClosesAt) }
  if (reg === 'notOpen') return { tag: 'upcoming', label: t('competition.marquee.regOpens'), value: until(c.regOpensAt) }
  return { tag: 'upcoming', label: t('competition.cd.toStart'), value: until(c.startsAt) }
}

// 进行中排最前，其次报名中（可以立刻行动），最后其余即将开始的。
// Running first, then registration open (actionable now), then the rest upcoming.
const TAG_ORDER: Record<Tag, number> = { running: 0, regOpen: 1, upcoming: 2 }

export default function CompetitionMarquee() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { user } = useAuth()
  const visible = !!user?.competitionsVisible
  const [list, setList] = useState<CompetitionSummary[]>([])
  const now = useNowTicker()

  usePollWhileVisible(
    (isCurrent) => {
      competitionApi.list()
        .then((r) => { if (isCurrent()) setList([...r.running, ...r.upcoming]) })
        // 失败就保持上一次的内容（首次失败即为空、不渲染），不在仪表盘上报错。
        // On failure keep what we had (empty on a first failure, so nothing
        // renders); never surface an error on the dashboard.
        .catch(() => {})
    },
    POLL_MS,
    [visible],
    { enabled: visible },
  )

  if (!visible || list.length === 0) return null

  const items = list
    .map((c) => ({ c, ...itemOf(c, now, t) }))
    .sort((a, b) => TAG_ORDER[a.tag] - TAG_ORDER[b.tag])

  // 跑马灯内容复制两份首尾相接，动画走满一份的宽度就无缝回到起点；第二份只是
  // 视觉延续，对读屏和 Tab 键隐藏，避免每场比赛被读两遍、聚焦两次。
  // The content is duplicated end to end so the animation loops seamlessly over
  // one copy's width; the second copy is visual only, hidden from screen readers
  // and the Tab order so each competition isn't read or focused twice.
  const renderCopy = (copy: number): ReactNode => (
    <div className="dash-cmq-copy" aria-hidden={copy === 1 || undefined}>
      {items.map(({ c, tag, label, value }) => (
        <button
          key={c.id}
          type="button"
          tabIndex={copy === 1 ? -1 : undefined}
          className="dash-cmq-item"
          onClick={() => navigate(`/competitions?c=${encodeURIComponent(c.id)}`)}
        >
          <span className={`dash-cmq-tag is-${tag}`}>{t(`competition.status.${tag}`)}</span>
          <b>{c.name}</b>
          {value && (
            <span className="dash-cmq-cd">
              {label} <span className="num">{value}</span>
            </span>
          )}
          {c.prizeNote && (
            <span className="dash-cmq-prize">
              {t('competition.prizeLabel')} · {c.prizeNote}
            </span>
          )}
        </button>
      ))}
    </div>
  )

  // 速度跟内容长度走：每场大约 14 秒滚过，至少 24 秒一圈，一场时也不会快到看不清。
  // Speed follows content length: about 14s per competition, at least 24s per
  // loop, so a single item never whizzes past.
  const duration = `${Math.max(24, items.length * 14)}s`

  return (
    <section className="dash-cmq" aria-label={t('competition.title')}>
      <Link to="/competitions" className="dash-cmq-label">
        <span className="dash-cmq-dot" aria-hidden />
        {t('competition.title')}
      </Link>
      <div className="dash-cmq-track">
        <div className="dash-cmq-run" style={{ animationDuration: duration }}>
          {renderCopy(0)}
          {renderCopy(1)}
        </div>
      </div>
    </section>
  )
}
