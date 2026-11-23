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
//
// 2026-11-23 起同一条也放财经日历的红色（高影响）数据：公布前 5 小时出现，倒计时到点，
// 公布后半小时内显示实际值，之后消失。排在比赛前面。只给登录用户（游客预览不请求），
// 管理员关掉日历「对用户开放」时没有这些段。只有财经段时左侧标签和箭头去日历；两种都有
// 时标签写「快讯」，不再是链接，各段自己能点。
// Since 2026-11-23 the same strip also carries red (high-impact) calendar releases: they
// appear five hours ahead, count down, show the actual for half an hour after release, then
// drop off. They go before competitions. Signed-in users only (the guest preview never asks),
// and none while an admin has the calendar's "open to users" off. With only calendar
// segments the label and arrow lead to the calendar; with both, the label reads "Live" and
// is no longer a link, since every segment is clickable.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router-dom'
import type { TFunction } from 'i18next'
import { competitionApi, econApi } from '../api/client'
import type { EconGroup, EconValue } from '../api/econTypes'
import { addDays, dayKey, filled, fmtNum, rowsOf, ymd } from './admin/econ/econShared'
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

// 财经段：公布前 5 小时出现，公布后 30 分钟消失；临近（前 10 分钟到公布后还没出数）时每分钟刷新。
// Calendar segments: shown from 5h before release until 30 min after; refreshed every minute
// while one is close (10 min ahead until its figure arrives).
const ECON_LEAD_MS = 5 * 3_600_000
const ECON_TAIL_MS = 30 * 60_000
const ECON_NEAR_MS = 10 * 60_000
const ECON_POLL_MS = 5 * 60_000
const ECON_LIVE_POLL_MS = 60_000
const RED: ReadonlySet<number> = new Set([3])

interface EconSeg {
  g: EconGroup
  at: number
  label: string
  v: EconValue | null
}

// 窗口内的红色数据，按时间排。一组（同一国家同一时刻）是一段，名字最多列两个。
// Red releases inside the window, in time order. One segment per group (one country, one
// moment), naming at most two figures.
function econSegsOf(items: EconGroup[], now: number, zh: boolean): EconSeg[] {
  const out: EconSeg[] = []
  for (const g of items) {
    if (!g.at || g.allDay || g.status === 'cancelled') continue
    const at = new Date(g.at).getTime()
    if (now < at - ECON_LEAD_MS || now > at + ECON_TAIL_MS) continue
    const rows = rowsOf(g, zh, RED)
    if (!rows.length) continue
    const names = [...new Set(rows.map((r) => r.label))]
    const label = names.slice(0, 2).join(' · ') + (names.length > 2 ? ' …' : '')
    out.push({
      g,
      at,
      label,
      v: rows.find((r) => r.v && filled(r.v.actual))?.v ?? rows[0].v,
    })
  }
  return out.sort((a, b) => a.at - b.at)
}

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
  if (c.status === 'running')
    return {
      c,
      tag: 'running',
      cdLabel: t('competition.cd.toEnd'),
      cdValue: until(c.endsAt),
    }
  const reg = regState(c, nowMs)
  if (reg === 'open')
    return {
      c,
      tag: 'regOpen',
      cdLabel: t('competition.marquee.regCloses'),
      cdValue: until(c.regClosesAt),
    }
  if (reg === 'notOpen')
    return {
      c,
      tag: 'upcoming',
      cdLabel: t('competition.marquee.regOpens'),
      cdValue: until(c.regOpensAt),
    }
  return {
    c,
    tag: 'upcoming',
    cdLabel: t('competition.cd.toStart'),
    cdValue: until(c.startsAt),
  }
}

// items：游客预览直接给（公开比赛数据），不轮询、不看 competitionsVisible。
// items: handed in by the guest preview (public competition data) — no polling, no
// competitionsVisible check.
export default function CompetitionMarquee({ items }: { items?: CompetitionSummary[] } = {}) {
  const { t, i18n } = useTranslation()
  const zh = i18n.language.startsWith('zh')
  const navigate = useNavigate()
  const { user } = useAuth()
  const visible = items !== undefined || !!user?.competitionsVisible
  const [polled, setList] = useState<CompetitionSummary[]>([])
  const list = items ?? polled
  const now = useNowTicker()
  const trackRef = useRef<HTMLDivElement>(null)
  const copyRef = useRef<HTMLDivElement>(null)
  const sectionRef = useRef<HTMLElement>(null)
  // loop=null：还没量过（先按静止排版量一次，避免首帧先滚再停的闪动）。
  // loop=null: not measured yet (measure the static layout first so the first frame
  // never starts scrolling and then stops).
  const [loop, setLoop] = useState<{ secs: number } | null | false>(null)
  const anyRunning = list.some((c) => c.status === 'running')
  const econOn = items === undefined && !!user
  const [econItems, setEcon] = useState<EconGroup[]>([])
  const econSegs = econOn ? econSegsOf(econItems, now, zh) : []
  // 轮询间隔每轮现读，所以「临近」放在 ref 里 / the interval is read each round, so keep "near" in a ref
  const econNearRef = useRef(false)
  econNearRef.current = econSegs.some((s) => now >= s.at - ECON_NEAR_MS && !(s.v && filled(s.v.actual)))

  usePollWhileVisible(
    (isCurrent) => {
      // 把 Promise 交回去：失败时 usePollWhileVisible 记下，回前台立刻重拉。
      // Hand the Promise back: on failure usePollWhileVisible retries on return to the foreground.
      return competitionApi.list().then((r) => {
        if (isCurrent()) setList([...r.running, ...r.upcoming])
      })
      // 失败就保持上一次的内容（首次失败即为空、不渲染），不在仪表盘上报错。
      // On failure keep what we had (empty on a first failure, so nothing
      // renders); never surface an error on the dashboard.
    },
    // 间隔在每次检查时现读，有比赛开赛后下一轮就切到每分钟，不必重跑 effect。
    // Read on each check, so once a competition starts the next cycle is per-minute
    // without re-running the effect.
    () => (anyRunning ? LIVE_POLL_MS : IDLE_POLL_MS),
    [visible],
    { enabled: visible && items === undefined },
  )

  usePollWhileVisible(
    (isCurrent) =>
      // 从本地昨天取 3 天：本地今天和 5 小时以内的明天都在里面（后端按 UTC 切日期）
      // Three days from local yesterday cover local today and the next five hours (the backend slices by UTC)
      econApi.calendar(ymd(addDays(new Date(), -1)), 3, 3).then((r) => {
        if (isCurrent()) setEcon(r.public ? r.items : [])
      }),
    () => (econNearRef.current ? ECON_LIVE_POLL_MS : ECON_POLL_MS),
    [econOn],
    { enabled: econOn },
  )

  const compShown = visible && list.length > 0
  const hasItems = compShown || econSegs.length > 0

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
      const next = w > track.clientWidth + 1 ? { secs: Math.max(20, Math.round(w / SPEED_PX_S / 5) * 5) } : false
      setLoop((prev) => ((prev && next && prev.secs === next.secs) || prev === next ? prev : next))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(track)
    ro.observe(copy)
    return () => ro.disconnect()
  }, [hasItems])

  // 跑马灯滚出视口就暂停（.is-offscreen → animation-play-state: paused，见 dashboard.css）：
  // 仪表盘往下翻以后它还在合成器上一直滚、一直出帧。回到视口从停下的位置接着滚。没有
  // IntersectionObserver 的老内核（Safari 12.0）照旧一直滚。
  // Pause the ticker once it scrolls out of view (.is-offscreen → animation-play-state:
  // paused, see dashboard.css): after scrolling down the dashboard it kept rolling on the
  // compositor, producing frames for nothing. Back in view it resumes where it stopped.
  // Engines without IntersectionObserver (Safari 12.0) keep scrolling as before.
  const [offscreen, setOffscreen] = useState(false)
  useEffect(() => {
    const el = sectionRef.current
    if (!hasItems || !el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver((entries) => {
      const last = entries[entries.length - 1]
      if (last) setOffscreen(!last.isIntersecting)
    })
    io.observe(el)
    return () => io.disconnect()
  }, [hasItems])

  if (!hasItems) return null

  const segs = (compShown ? list : []).map((c) => segOf(c, now, t)).sort((a, b) => TAG_ORDER[a.tag] - TAG_ORDER[b.tag])

  // 滚动时内容复制两份首尾相接，动画走满一份的宽度就无缝回到起点；第二份只是视觉
  // 延续，对读屏和 Tab 键隐藏，避免每场比赛被读两遍、聚焦两次。
  // When scrolling, the content is duplicated end to end so the animation loops
  // seamlessly over one copy's width; the second copy is visual only, hidden from
  // screen readers and the Tab order so nothing is read or focused twice.
  const renderEcon = (dup: boolean) =>
    econSegs.map(({ g, at, label, v }) => (
      <button
        key={`econ:${g.key}`}
        type="button"
        tabIndex={dup ? -1 : undefined}
        className="dash-tk-seg is-econ"
        onClick={() => navigate(`/calendar?${new URLSearchParams({ day: dayKey(g), focus: g.key })}`)}
      >
        <span className="dash-tk-tag">{t('econ.ticker.high')}</span>
        <span className="dash-tk-name">
          <span className="num dash-tk-time">
            {new Date(at).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
              hour12: false,
            })}
          </span>
          {g.currency ?? g.country} {label}
        </span>
        {at > now ? (
          <span className="dash-tk-meta">
            {t('econ.ticker.in')} <b className="num">{fmtCountdown(at - now, t)}</b>
          </span>
        ) : v && filled(v.actual) ? (
          <span className="dash-tk-meta">
            {t('econ.actual')} <b className="num">{fmtNum(v.actual, v.unit)}</b>
            {filled(v.consensus) && (
              <>
                {' · '}
                {t('econ.consensus')} <b className="num">{fmtNum(v.consensus, v.unit)}</b>
              </>
            )}
          </span>
        ) : (
          <span className="dash-tk-meta">{t('econ.ticker.awaiting')}</span>
        )}
      </button>
    ))

  const renderCopy = (dup: boolean) => (
    <div className="dash-tk-copy" ref={dup ? undefined : copyRef} aria-hidden={dup || undefined}>
      {renderEcon(dup)}
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
            {tag === 'running' &&
              (top.length > 0 ? (
                top.map((r, i) => (
                  <span key={i} className={`dash-tk-rank${i === 0 ? ' is-first' : ''}`}>
                    <i className="num">{String(i + 1).padStart(2, '0')}</i>
                    <span>{r.displayName}</span>
                    {/* 成绩用 key 绑定数值：一变就重新挂载、闪一下。
                        Keyed by value: a change remounts it and it flashes. */}
                    <b key={r.score} className={`num ${r.score < 0 ? 'is-down' : 'is-up'}`}>
                      {fmtScorePct(r.score)}
                    </b>
                  </span>
                ))
              ) : (
                <span className="dash-tk-meta">{t('competition.ticker.empty')}</span>
              ))}
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

  // 只有比赛 → 比赛；只有财经 → 日历；两种都有 → 「快讯」，不做链接
  // Competitions only → the arena; calendar only → the calendar; both → "Live", not a link
  const mixed = compShown && econSegs.length > 0
  const home = compShown ? '/competitions' : '/calendar'
  const title = mixed ? t('econ.ticker.mixed') : compShown ? t('competition.title') : t('econ.ticker.label')
  // 有比赛正在进行时才亮直播灯：它表达的是真实状态，不是装饰。
  // The live light only shows while a competition is running: it states a real condition, it isn't decoration.
  const labelInner = (
    <>
      {compShown && anyRunning && <span className="dash-tk-live" aria-hidden />}
      <span>{title}</span>
    </>
  )

  return (
    <section ref={sectionRef} className={`dash-tk content-fade${offscreen ? ' is-offscreen' : ''}`} aria-label={title}>
      {mixed ? (
        <span className="dash-tk-label is-static">{labelInner}</span>
      ) : (
        <Link to={home} className="dash-tk-label">
          {labelInner}
        </Link>
      )}
      <div ref={trackRef} className={`dash-tk-track${loop ? ' is-loop' : ''}`}>
        <div className="dash-tk-run" style={loop ? { animationDuration: `${loop.secs}s` } : undefined}>
          {renderCopy(false)}
          {loop && renderCopy(true)}
        </div>
      </div>
      <Link
        to={home}
        className="dash-tk-more"
        aria-label={compShown ? t('competition.enterArena') : t('econ.today.full')}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M5 12h14M13 6l6 6-6 6" />
        </svg>
      </Link>
    </section>
  )
}
