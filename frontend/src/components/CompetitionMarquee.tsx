// 仪表盘顶部的赛事跑马灯：有比赛在报名 / 即将开赛 / 进行中时出现一行转播字幕，
// 取自比赛页头版底下那条跑马灯（.cmp-ticker）的形式——每场比赛一段，开头是状态
// 芯片与赛名；进行中的比赛滚着前三名与成绩、参赛账户数，像直播的比分条；其余比赛
// 只报倒计时。点哪一段就打开哪一场的详情。
//
// 「直播」：有比赛进行时每分钟刷新一次（后端比赛榜每 60 秒重算一次，再快也没有新
// 数据），成绩一变就闪一下。内容放不下才滚动，速度按像素恒定，悬停 / 聚焦时停住；
// 放得下就静止。
//
// 没有这类比赛、比赛入口未对该用户开放（competitionsVisible，关着时后端对普通用户
// 回 403，所以根本不请求）、或接口失败时整条不渲染。
//
// The dashboard's competition ticker: while any competition is open for
// registration, upcoming or running, a broadcast caption row appears, borrowing
// the form of the ticker under the competitions page's front page (.cmp-ticker):
// one segment per competition opening with a status chip and the name; a running
// competition rolls its top three with scores and the entrant count, like a live
// score bug; the others carry just their countdown. Clicking a segment opens that
// competition.
//
// "Live": refreshed every minute while anything is running (the backend rebuilds
// competition boards every 60s, so faster would fetch nothing new), each score
// flashing when it changes. It scrolls only when the content overflows, at a
// constant pixel speed, pausing on hover / focus; otherwise it sits still.
//
// Nothing renders with no such competition, the entry gated off for this user
// (competitionsVisible: the backend answers 403 for regular users when it's off,
// so we don't ask), or a failed request.
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

// 有比赛进行中时每分钟刷新战况（比赛接口限流 30 次 / 分钟，这里只占 1 次）；
// 否则列表变化很慢，5 分钟一次足够。都只在前台轮询，回前台补一次。
// With a competition running, refresh the standings every minute (the endpoint
// allows 30/minute; this uses one); otherwise the list changes slowly and 5
// minutes is plenty. Foreground only, with a refetch on return.
const LIVE_POLL_MS = 60_000
const IDLE_POLL_MS = 5 * 60_000
// 滚动速度（像素 / 秒）：慢到能读完一个名字和成绩。时长按 5 秒取整，倒计时文字
// 长短的细微变化不会改时长、让动画跳位。
// Scroll speed (px/s): slow enough to read a name and score. The duration is
// rounded to 5s so a countdown's text changing length doesn't alter it and make
// the animation jump.
const SPEED_PX_S = 40

type Tag = 'running' | 'regOpen' | 'upcoming'

// 进行中排最前，其次报名中（可以立刻行动），最后其余即将开始的。
// Running first, then registration open (actionable now), then the rest upcoming.
const TAG_ORDER: Record<Tag, number> = { running: 0, regOpen: 1, upcoming: 2 }

interface Seg {
  c: CompetitionSummary
  tag: Tag
  cdLabel: string
  cdValue: string
}

// 每段的状态与倒计时：进行中数到结束；报名中数到报名截止（用户该行动的时刻）；
// 报名还没开数到开放报名；其余（自动参赛、报名已截止）数到开赛。
// Each segment's state and countdown: running counts to the end; registration
// open to its close (the moment to act by); registration not yet open to its
// opening; everything else (auto-enrolment, registration closed) to the start.
function segOf(c: CompetitionSummary, nowMs: number, t: TFunction): Seg {
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

// items：游客预览直接给（公开比赛数据），不轮询、不看 competitionsVisible。
// items: handed in by the guest preview (public competition data) — no polling, no
// competitionsVisible check.
export default function CompetitionMarquee({ items }: { items?: CompetitionSummary[] } = {}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { user } = useAuth()
  const visible = items !== undefined || !!user?.competitionsVisible
  const [polled, setList] = useState<CompetitionSummary[]>([])
  const list = items ?? polled
  const now = useNowTicker()
  const trackRef = useRef<HTMLDivElement>(null)
  const copyRef = useRef<HTMLDivElement>(null)
  // loop=null：还没量过（先按静止排版量一次，避免首帧先滚再停的闪动）。
  // loop=null: not measured yet (measure the static layout first so the first frame
  // never starts scrolling and then stops).
  const [loop, setLoop] = useState<{ secs: number } | null | false>(null)
  const anyRunning = list.some((c) => c.status === 'running')

  usePollWhileVisible(
    (isCurrent) => {
      competitionApi.list()
        .then((r) => { if (isCurrent()) setList([...r.running, ...r.upcoming]) })
        // 失败就保持上一次的内容（首次失败即为空、不渲染），不在仪表盘上报错。
        // On failure keep what we had (empty on a first failure, so nothing
        // renders); never surface an error on the dashboard.
        .catch(() => {})
    },
    // 间隔在每次检查时现读，有比赛开赛后下一轮就切到每分钟，不必重跑 effect。
    // Read on each check, so once a competition starts the next cycle is per-minute
    // without re-running the effect.
    () => (anyRunning ? LIVE_POLL_MS : IDLE_POLL_MS),
    [visible],
    { enabled: visible && items === undefined },
  )

  const hasItems = visible && list.length > 0

  // 量一份内容的宽度，放不下才滚；轨道或内容尺寸变化（旋转屏幕、换语言、新数据）
  // 时重算。
  // Measure one copy: scroll only if it doesn't fit; re-measure when the track or
  // the content resizes (rotation, language switch, new data).
  useLayoutEffect(() => {
    const track = trackRef.current
    const copy = copyRef.current
    if (!hasItems || !track || !copy) return
    const measure = () => {
      const w = copy.getBoundingClientRect().width
      const next = w > track.clientWidth + 1
        ? { secs: Math.max(20, Math.round(w / SPEED_PX_S / 5) * 5) }
        : false
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

  const segs = list
    .map((c) => segOf(c, now, t))
    .sort((a, b) => TAG_ORDER[a.tag] - TAG_ORDER[b.tag])

  // 滚动时内容复制两份首尾相接，动画走满一份的宽度就无缝回到起点；第二份只是视觉
  // 延续，对读屏和 Tab 键隐藏，避免每场比赛被读两遍、聚焦两次。
  // When scrolling, the content is duplicated end to end so the animation loops
  // seamlessly over one copy's width; the second copy is visual only, hidden from
  // screen readers and the Tab order so nothing is read or focused twice.
  const renderCopy = (dup: boolean) => (
    <div className="dash-tk-copy" ref={dup ? undefined : copyRef} aria-hidden={dup || undefined}>
      {segs.map(({ c, tag, cdLabel, cdValue }) => {
        const top = tag === 'running' ? (c.top ?? []).slice(0, 3) : []
        const entrants = c.participants ?? 0
        return (
          <button
            key={c.id}
            type="button"
            tabIndex={dup ? -1 : undefined}
            className={`dash-tk-seg is-${tag}`}
            onClick={() => navigate(`/competitions?c=${encodeURIComponent(c.id)}`)}
          >
            <span className="dash-tk-tag">{t(`competition.status.${tag}`)}</span>
            <span className="dash-tk-name">{c.name}</span>
            {tag === 'running' && (top.length > 0
              ? top.map((r, i) => (
                  <span key={i} className={`dash-tk-rank${i === 0 ? ' is-first' : ''}`}>
                    <i className="num">{String(i + 1).padStart(2, '0')}</i>
                    <span>{r.displayName}</span>
                    {/* 成绩用 key 绑定数值：一变就重新挂载、闪一下。
                        Keyed by value: a change remounts it and it flashes. */}
                    <b key={r.score} className={`num ${r.score < 0 ? 'is-down' : 'is-up'}`}>{fmtScorePct(r.score)}</b>
                  </span>
                ))
              : <span className="dash-tk-meta">{t('competition.ticker.empty')}</span>)}
            {tag === 'running' && entrants > 0 && (
              <span className="dash-tk-meta">{t('competition.ticker.participants', { n: entrants })}</span>
            )}
            {cdValue && (
              <span className="dash-tk-meta">
                {cdLabel} <b className="num">{cdValue}</b>
              </span>
            )}
          </button>
        )
      })}
    </div>
  )

  return (
    <section className="dash-tk content-fade" aria-label={t('competition.title')}>
      <Link to="/competitions" className="dash-tk-label">
        {/* 有比赛正在进行时才亮直播灯：它表达的是真实状态，不是装饰。
            The live light only shows while a competition is running: it states a
            real condition, it isn't decoration. */}
        {anyRunning && <span className="dash-tk-live" aria-hidden />}
        <span>{t('competition.title')}</span>
      </Link>
      <div ref={trackRef} className={`dash-tk-track${loop ? ' is-loop' : ''}`}>
        <div className="dash-tk-run" style={loop ? { animationDuration: `${loop.secs}s` } : undefined}>
          {renderCopy(false)}
          {loop && renderCopy(true)}
        </div>
      </div>
      <Link to="/competitions" className="dash-tk-more" aria-label={t('competition.enterArena')}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M5 12h14M13 6l6 6-6 6" /></svg>
      </Link>
    </section>
  )
}
