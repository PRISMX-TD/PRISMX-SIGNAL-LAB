// 仪表盘顶部的比赛走马灯：有比赛在报名 / 即将开赛 / 进行中时出现一条转播式字幕条，
// 视觉语言沿用比赛页的「赛事直播」（展示字体赛名、胶囊倒计时）。每场一项，按状态给
// 最有用的那句话：进行中报领跑者与成绩，报名中报奖品与已报名数，即将开始报奖品；
// 末尾是胶囊倒计时。点哪一项直接打开那场比赛的详情。
//
// 只有内容放不下时才滚动：一两场比赛能完整摆下就静止展示，不为动而动。滚动速度按
// 像素恒定（不随场数忽快忽慢），悬停 / 键盘聚焦时停住。
//
// 没有这类比赛、比赛入口未对该用户开放（competitionsVisible，关着时后端对普通用户
// 回 403，所以根本不请求）、或接口失败时整条不渲染。列表变化很慢，前台 5 分钟轮询，
// 回前台补一次（见 usePollWhileVisible）。
//
// The dashboard's competition marquee: while any competition is open for
// registration, upcoming or running, a broadcast-style strip appears, borrowing
// the competitions page's "live event" language (display-face names, pill
// countdowns). One item per competition, each with its most useful line: the
// leader and score while running, prize and sign-ups while registration is open,
// the prize when upcoming; a pill countdown closes each item. Clicking an item
// opens that competition's detail.
//
// It only scrolls when the content doesn't fit: one or two competitions that fit
// sit still rather than moving for the sake of it. Scroll speed is constant in
// pixels (not faster or slower with the item count) and pauses on hover or
// keyboard focus.
//
// Nothing renders with no such competition, the entry gated off for this user
// (competitionsVisible: the backend answers 403 for regular users when it's off,
// so we don't ask), or a failed request. The list changes slowly: a 5-minute
// foreground poll with a refetch on return (see usePollWhileVisible).
import { useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router-dom'
import type { TFunction } from 'i18next'
import { competitionApi } from '../api/client'
import { fmtScorePct, parseTime } from '../api/utils'
import type { CompetitionSummary } from '../api/types'
import { useAuth } from '../store/auth'
import { usePollWhileVisible } from '../utils/usePollWhileVisible'
import { fmtCountdown, regState, useNowTicker } from '../utils/competitionTime'

const POLL_MS = 5 * 60_000
// 滚动速度（像素 / 秒）：慢到能读完一句赛名，又不至于等半天才轮到下一场。
// Scroll speed (px/s): slow enough to read a name, quick enough to reach the next one.
const SPEED_PX_S = 42

type Tag = 'running' | 'regOpen' | 'upcoming'

interface Item {
  c: CompetitionSummary
  tag: Tag
  cdLabel: string
  cdValue: string
}

// 每项的状态与倒计时：进行中数到结束；报名中数到报名截止（这是用户该行动的时刻，
// 比"距开赛"更有用）；报名还没开数到开放报名；其余（自动参赛、报名已截止）数到开赛。
// Each item's state and countdown: running counts to the end; registration open
// counts to its close (the moment the user must act by, more useful than "starts
// in"); registration not yet open counts to its opening; everything else
// (auto-enrolment, registration closed) counts to the start.
function itemOf(c: CompetitionSummary, nowMs: number, t: TFunction): Item {
  const until = (iso: string | null) => {
    const at = parseTime(iso)?.getTime()
    return at != null ? fmtCountdown(at - nowMs, t) : ''
  }
  if (c.status === 'running') return { c, tag: 'running', cdLabel: t('competition.cd.toEnd'), cdValue: until(c.endsAt) }
  const reg = regState(c, nowMs)
  if (reg === 'open') return { c, tag: 'regOpen', cdLabel: t('competition.marquee.regCloses'), cdValue: until(c.regClosesAt) }
  if (reg === 'notOpen') return { c, tag: 'upcoming', cdLabel: t('competition.marquee.regOpens'), cdValue: until(c.regOpensAt) }
  return { c, tag: 'upcoming', cdLabel: t('competition.cd.toStart'), cdValue: until(c.startsAt) }
}

// 进行中排最前，其次报名中（可以立刻行动），最后其余即将开始的。
// Running first, then registration open (actionable now), then the rest upcoming.
const TAG_ORDER: Record<Tag, number> = { running: 0, regOpen: 1, upcoming: 2 }

// 一场比赛的中段信息：进行中给领跑者（还没人上榜就给参赛数）；报名中 / 即将开始给
// 奖品，报名中再加已报名数（有人报了才显示，"参赛 0 账户"只会劝退）。
// The middle of an item: the leader while running (participant count if nobody has
// ranked yet); the prize for registration-open / upcoming, plus the sign-up count
// while registration is open (only once someone has signed up: "0 accounts" deters).
function Details({ c, tag, t }: { c: CompetitionSummary; tag: Tag; t: TFunction }) {
  const leader = c.top?.[0]
  const n = c.participants ?? 0
  if (tag === 'running') {
    return leader ? (
      <span className="dash-cmq-meta">
        {t('competition.marquee.leader')} <b>{leader.displayName}</b>{' '}
        <b className={`num ${leader.score < 0 ? 'text-down' : 'text-up'}`}>{fmtScorePct(leader.score)}</b>
      </span>
    ) : n > 0 ? (
      <span className="dash-cmq-meta">{t('competition.ticker.participants', { n })}</span>
    ) : null
  }
  return (
    <>
      {c.prizeNote && (
        <span className="dash-cmq-meta">
          {t('competition.prizeLabel')} <b>{c.prizeNote}</b>
        </span>
      )}
      {tag === 'regOpen' && n > 0 && (
        <span className="dash-cmq-meta is-extra">{t('competition.ticker.participants', { n })}</span>
      )}
    </>
  )
}

export default function CompetitionMarquee() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { user } = useAuth()
  const visible = !!user?.competitionsVisible
  const [list, setList] = useState<CompetitionSummary[]>([])
  const now = useNowTicker()
  const trackRef = useRef<HTMLDivElement>(null)
  const copyRef = useRef<HTMLDivElement>(null)
  // loop=null：还没量过（先按静止排版量一次，避免首帧先滚再停的闪动）。
  // loop=null: not measured yet (measure the static layout first so the first frame
  // never starts scrolling and then stops).
  const [loop, setLoop] = useState<{ secs: number } | null | false>(null)

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

  const hasItems = visible && list.length > 0

  // 量一份内容的宽度，放不下才滚；轨道或内容尺寸变化（旋转屏幕、换语言、倒计时变长）
  // 时重算。滚动时长 = 一份的宽度 / 速度，所以速度恒定。
  // Measure one copy: scroll only if it doesn't fit; re-measure when the track or the
  // content resizes (rotation, language switch, a longer countdown). Duration = copy
  // width / speed, so the speed stays constant.
  useLayoutEffect(() => {
    const track = trackRef.current
    const copy = copyRef.current
    if (!hasItems || !track || !copy) return
    const measure = () => {
      const w = copy.getBoundingClientRect().width
      const next = w > track.clientWidth + 1 ? { secs: Math.round(w / SPEED_PX_S) } : false
      setLoop((prev) => (prev && next && prev.secs === next.secs) || prev === next ? prev : next)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(track)
    ro.observe(copy)
    return () => ro.disconnect()
  }, [hasItems])

  if (!hasItems) return null

  const items = list
    .map((c) => itemOf(c, now, t))
    .sort((a, b) => TAG_ORDER[a.tag] - TAG_ORDER[b.tag])
  const anyRunning = items.some((i) => i.tag === 'running')

  // 滚动时内容复制两份首尾相接，动画走满一份的宽度就无缝回到起点；第二份只是视觉
  // 延续，对读屏和 Tab 键隐藏，避免每场比赛被读两遍、聚焦两次。
  // When scrolling, the content is duplicated end to end so the animation loops
  // seamlessly over one copy's width; the second copy is visual only, hidden from
  // screen readers and the Tab order so nothing is read or focused twice.
  const renderCopy = (dup: boolean) => (
    <div className="dash-cmq-copy" ref={dup ? undefined : copyRef} aria-hidden={dup || undefined}>
      {items.map(({ c, tag, cdLabel, cdValue }) => (
        <button
          key={c.id}
          type="button"
          tabIndex={dup ? -1 : undefined}
          className={`dash-cmq-item is-${tag}`}
          onClick={() => navigate(`/competitions?c=${encodeURIComponent(c.id)}`)}
        >
          <span className="dash-cmq-status">{t(`competition.status.${tag}`)}</span>
          <span className="dash-cmq-name">{c.name}</span>
          <Details c={c} tag={tag} t={t} />
          {cdValue && (
            <span className="dash-cmq-cd">
              <small>{cdLabel}</small>
              <b className="num">{cdValue}</b>
            </span>
          )}
        </button>
      ))}
    </div>
  )

  return (
    <section className="dash-cmq content-fade" aria-label={t('competition.title')}>
      <Link to="/competitions" className="dash-cmq-label">
        {/* 有比赛正在进行时才亮直播灯：它表达的是真实状态，不是装饰。
            The live light only shows while a competition is running: it states a
            real condition, it isn't decoration. */}
        {anyRunning && <span className="dash-cmq-live" aria-hidden />}
        <span>{t('competition.title')}</span>
        <span className="dash-cmq-count num">{items.length}</span>
      </Link>
      <div ref={trackRef} className={`dash-cmq-track${loop ? ' is-loop' : ''}`}>
        <div className="dash-cmq-run" style={loop ? { animationDuration: `${loop.secs}s` } : undefined}>
          {renderCopy(false)}
          {loop && renderCopy(true)}
        </div>
      </div>
      <Link to="/competitions" className="dash-cmq-more" aria-label={t('competition.title')}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M9 6l6 6-6 6" /></svg>
      </Link>
    </section>
  )
}
