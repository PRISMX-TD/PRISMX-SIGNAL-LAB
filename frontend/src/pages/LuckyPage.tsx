// 幸运轮盘页（v2 多期，2026-10-22 重做界面）。可以同时有好几期：没有期 → 「暂未开放」+ 我的奖品；
// 一期 → 直接显示；多期 → 顶部切换（期名 + 该期未用券数），记住上次选的期。
// 左边是舞台：期名、开放时间、倒计时，转盘（中间的按钮就是抽奖键），下面是券叠、一句随结果变化的
// 鼓励的话和音效开关。右边是票夹（我的抽奖券）、奖品一览、我的奖品（跨期）。
// 结果由后端决定：点按钮 → POST /lucky-wheel/spin {roundId} → 转到返回的 slotIndex → 停下再弹揭晓卡。
// 按概率模式抽中已抽完的格：转盘照样停在那一格，揭晓卡说「这份奖品刚刚被抽完了」。
// 节日（站内节日日历，用户可在账户设置里关掉）只换皮：灯珠 / 轮缘 / 指针配色、问候语、中奖彩纸的图案。
// Lucky wheel page (v2, rounds side by side; UI redone 2026-10-22). None -> "not open" plus My prizes;
// one -> shown directly; several -> a switcher (name + unused-ticket badge) that remembers the pick.
// Left: the stage (name, window, countdown, the wheel whose hub is the spin button, then the ticket
// stack, an encouraging line that follows the outcome, and the sound toggle). Right: the ticket wallet,
// the prize list and the cross-round My prizes. The backend picks the result; we spin to its slotIndex,
// then show the reveal card. A festival (the site calendar; users can switch it off) only reskins:
// bulb / rim / pointer colours, a greeting and the confetti pieces.
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { luckyApi } from '../api/client'
import type { LuckyDraw, LuckySpinResult, LuckyState } from '../api/luckyTypes'
import { localizeApiError } from '../api/utils'
import { FestivalEmptyMini } from '../festival/FestivalDecor'
import { useFestivalOptional } from '../festival/FestivalProvider'
import LuckyWheel, { type LuckyWheelHandle } from '../components/lucky/LuckyWheel'
import { MyPrizes, PrizeList } from '../components/lucky/PrizeBoard'
import ResultReveal from '../components/lucky/ResultReveal'
import TicketWallet from '../components/lucky/TicketWallet'
import { playMiss, playRetry, playWin, primeAudio, setSoundEnabled, soundEnabled } from '../components/lucky/luckySound'
import { slotColor } from '../components/lucky/wheelArt'
import { useAuth } from '../store/auth'
import { countdownParts, fmtWindow } from '../utils/luckyCountdown'
import { resolveSlot } from '../utils/luckySlot'
import {
  cheerKey, isWheelClosed, openRounds, pickRound, readLastRound, revealCopy, withTicketsLeft, writeLastRound, type Outcome,
} from '../utils/luckyView'
import { newRequestId } from '../utils/luckyWheel'
import '../components/lucky/luckyPage.css'

function useCountdown(to: string | undefined) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])
  return countdownParts(to, now)
}

const pad = (n: number) => (n < 10 ? `0${n}` : String(n))

type Reveal = { draw: LuckySpinResult; color: string }

export default function LuckyPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { refreshUser } = useAuth()
  const festival = useFestivalOptional()?.festival ?? null
  const [state, setState] = useState<LuckyState | null>(null)
  const [draws, setDraws] = useState<LuckyDraw[]>([])
  const [err, setErr] = useState('')
  const [spinning, setSpinning] = useState(false)
  const [reveal, setReveal] = useState<Reveal | null>(null)
  const [sound, setSound] = useState(soundEnabled)
  const [last, setLast] = useState<Outcome>(null)
  const [missStreak, setMissStreak] = useState(0)
  // 每抽一次 +1：券叠顶上那张飞走一次 / bumped per spin: the top ticket on the stack flies off once
  const [tear, setTear] = useState(0)
  // 结果回来、剩余张数真正变了才让数字跳一下（撕券在点下去时就播了）/ pops the count once the new total
  // arrives (the tear itself plays on the tap)
  const [bump, setBump] = useState(0)
  // 上次选的期（localStorage，读不到就是 null）/ the last picked round (null when storage is unavailable)
  const [selId, setSelId] = useState<string | null>(() => readLastRound())
  const wheel = useRef<LuckyWheelHandle>(null)
  // 同步锁：state 更新是异步的，连点两下时 spinning 还没变 true，靠它挡住第二个请求。
  // Synchronous lock: `spinning` only flips after a render, so a fast double-click would slip a second
  // request through; this ref closes that gap.
  const spinLock = useRef(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])
  const errText = (e: unknown) => (e instanceof Error ? localizeApiError(e.message) : t('common.error'))

  const load = () => Promise.all([luckyApi.state(), luckyApi.draws()])
    .then(([s, d]) => { setState(s); setDraws(d.draws) })
    .catch((e) => setErr(errText(e)))
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const rounds = state ? openRounds(state) : []
  const cur = pickRound(rounds, selId)
  const round = cur?.round
  const target = round?.phase === 'upcoming' ? round.startsAt : round?.endsAt
  const cd = useCountdown(target)

  // 倒计时走到 0（开始 / 结束）时重新拉一次状态，阶段才会自己翻过去；每个目标时间只拉一次，
  // 万一服务器时钟略慢、阶段还没翻，也不会每秒重拉。切到另一期时按那一期的时间算。
  // When the countdown reaches zero (start / end) reload once so the phase flips by itself; once per
  // target time, so a server clock a hair behind can't turn this into a once-a-second refetch.
  const reloadedFor = useRef<string | null>(null)
  const cdDone = !!cd?.done
  useEffect(() => {
    if (!cdDone || !target || reloadedFor.current === target) return
    reloadedFor.current = target
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cdDone, target])

  const select = (id: string) => {
    // 转动中不许换期：转盘画的是这一期的格子 / no switching mid-spin: the wheel shows this round's slots
    if (spinning || spinLock.current) return
    setSelId(id)
    writeLastRound(id)
    setErr('')
    setLast(null)
    setMissStreak(0)
  }

  const toggleSound = () => {
    setSound((on) => {
      setSoundEnabled(!on)
      if (!on) primeAudio()
      return !on
    })
  }

  const onSpin = async () => {
    if (!state || !cur || spinning || spinLock.current) return
    const roundId = cur.round.id
    spinLock.current = true
    // 必须在点击这一下里唤醒声音（iOS / Chrome 的自动播放规则）/ wake audio inside the tap (autoplay rules)
    primeAudio()
    setErr('')
    setReveal(null)
    setSpinning(true)
    setTear((n) => n + 1)
    const finish = (r: LuckySpinResult, color: string) => {
      const tone = revealCopy(r).tone
      setSpinning(false)
      setReveal({ draw: r, color })
      setLast(tone)
      setMissStreak((n) => (tone === 'miss' ? n + 1 : 0))
      // 转到一半离开了这页就不出声，免得结果音在别的页面响 / left mid-spin: no result sound on another page
      if (alive.current) {
        if (tone === 'win') { wheel.current?.celebrate(); playWin() } else if (tone === 'retry') playRetry(); else playMiss()
      }
      setState((s) => s && withTicketsLeft(s, r.round?.id ?? roundId, r.ticketsLeft))
      setBump((n) => n + 1)
      void luckyApi.draws().then((d) => setDraws(d.draws)).catch(() => {})
      void refreshUser?.()
      spinLock.current = false
    }
    try {
      const r = await luckyApi.spin(roundId, newRequestId())
      // 后端的 slotIndex 按它此刻这一期的上架顺序算；本地奖品列表可能已被管理员改过。对不上就先拉新状态
      // （转盘按新格子重画），再按新列表算要停的格；这一期不见了或仍找不到就不转，直接出结果。
      // The backend's slotIndex follows this round's current listing; our cached prizes may be stale.
      // On a mismatch refetch state first (the wheel redraws with the new slots), then resolve against
      // it; if the round is gone or there is still nowhere to land, skip the animation and show the result.
      let prizes = cur.prizes
      let slot = resolveSlot(prizes, r.prize.id, r.slotIndex)
      if (!slot.consistent) {
        try {
          const fresh = await luckyApi.state()
          setState(fresh)
          prizes = fresh.rounds.find((x) => x.round.id === roundId)?.prizes ?? []
          slot = resolveSlot(prizes, r.prize.id, r.slotIndex)
        } catch { /* 拉不到就按现有列表尽力而为 / best effort with what we have */ }
      }
      const color = slotColor(r.prize.color, Math.max(slot.index, 0))
      // 页面中途被卸掉时 spinTo 会立刻 resolve，finish 照常补拉账户（首页券数不会停在旧值）。
      // If the page unmounts mid-spin, spinTo resolves at once and finish still refreshes the account.
      // 格数按这份（可能刚拉的）列表传进去：setState(fresh) 还没重画，转盘自己记的仍是旧格数。
      // Aim with this (possibly just fetched) list's count: setState(fresh) hasn't re-rendered the wheel yet.
      if (slot.index >= 0 && wheel.current) await wheel.current.spinTo(slot.index, prizes.length)
      finish(r, color)
    } catch (e) {
      setSpinning(false)
      spinLock.current = false
      setErr(errText(e))
      void load()
    }
  }

  if (!state) {
    return (
      <div className="lk">
        {err ? <div className="card lk-closed"><p className="lk-closed-sub">{err}</p></div> : (
          <div className="lk-grid" aria-busy="true">
            <section className="card lk-stage"><div className="lk-skel-wheel" /></section>
            <aside className="lk-side"><div className="card lk-skel-panel" /><div className="card lk-skel-panel" /></aside>
          </div>
        )}
      </div>
    )
  }

  // 揭晓卡在两个分支里都要画：倒计时归零、重载后这一期不见了（关闭）时，不能把还没看的结果卸掉。
  // The reveal is rendered in both branches: if the reload at zero drops the round, an unseen result stays.
  const unusedNow = cur?.tickets.unused ?? 0
  const modal = reveal && (
    <ResultReveal draw={reveal.draw} color={reveal.color} festival={festival}
      again={round?.phase === 'active' && reveal.draw.round?.id === round.id ? unusedNow : 0}
      onAgain={() => { setReveal(null); void onSpin() }}
      onClose={() => setReveal(null)}
      onChange={(d) => {
        setDraws((xs) => xs.map((x) => (x.id === d.id ? d : x)))
        setReveal((cur0) => (cur0 ? { ...cur0, draw: { ...cur0.draw, ...d } } : cur0))
      }} navigate={navigate} />
  )

  if (isWheelClosed(state) || !cur || !round) {
    // 关闭时仍显示「我的奖品」：奖品没有系统领取期限，期结束后用户还要能领奖。
    // Still show "My prizes" while closed: no system claim deadline, winners claim after the round.
    return (
      <div className="lk mx-auto max-w-xl space-y-5">
        <div className="card lk-closed">
          <div className="lk-closed-mark" aria-hidden />
          <p className="lk-closed-title">{t('lucky.closed')}</p>
          <p className="lk-closed-sub">{t('lucky.closedSub')}</p>
        </div>
        {draws.length > 0 && <MyPrizes draws={draws} onChange={setDraws} navigate={navigate} />}
        {modal}
      </div>
    )
  }

  const active = round.phase === 'active'
  const unused = cur.tickets.unused
  const hadTickets = cur.tickets.batches.length > 0
  const cheer = cheerKey({ phase: round.phase, spinning, unused, hadTickets, last, missStreak })
  const hubSub = !active ? t('lucky.hub.soon') : unused > 0 ? t('lucky.hub.left', { n: unused }) : t('lucky.hub.none')

  return (
    <div className="lk" data-fest={festival ?? undefined}>
      {rounds.length > 1 && (
        <div role="tablist" aria-label={t('lucky.rounds')} className="lk-rounds">
          {rounds.map((r) => {
            const on = r.round.id === round.id
            return (
              <button key={r.round.id} type="button" role="tab" aria-selected={on} disabled={spinning && !on}
                onClick={() => select(r.round.id)} className={`lk-round ${on ? 'is-on' : ''}`}>
                <span className="lk-round-name">{r.round.name}</span>
                {r.round.phase === 'upcoming' && <span className="lk-round-soon">{t('lucky.notStarted')}</span>}
                {r.tickets.unused > 0 && (
                  <span className="lk-round-badge" aria-label={t('lucky.ticketsBadge', { n: r.tickets.unused })}>{r.tickets.unused}</span>
                )}
              </button>
            )
          })}
        </div>
      )}

      <div className="lk-grid">
        <section className="card lk-stage">
          <header className="lk-stage-head">
            <div className="min-w-0">
              {festival && (
                <div className="lk-fest">
                  <FestivalEmptyMini />
                  <span>{t(`festival.greeting.${festival}`)}</span>
                </div>
              )}
              <h1 className="lk-title">{round.name}</h1>
              <p className="lk-window">{fmtWindow(round.startsAt, round.endsAt)}</p>
            </div>
            {cd && !cd.done && (
              <div className="lk-cd" role="timer" aria-label={`${t(active ? 'lucky.endsLabel' : 'lucky.startsLabel')} ${cd.d} ${t('lucky.unitD')} ${pad(cd.h)}:${pad(cd.m)}:${pad(cd.s)}`}>
                <span className="lk-cd-label">{t(active ? 'lucky.endsLabel' : 'lucky.startsLabel')}</span>
                <span className="lk-cd-cells" aria-hidden>
                  {([['d', cd.d], ['h', cd.h], ['m', cd.m], ['s', cd.s]] as const).map(([u, v]) => (
                    <span key={u} className="lk-cd-cell"><b>{u === 'd' ? v : pad(v)}</b><i>{t(`lucky.unit${u.toUpperCase()}`)}</i></span>
                  ))}
                </span>
              </div>
            )}
          </header>

          <div className="lk-wheel-wrap">
            <LuckyWheel ref={wheel} prizes={cur.prizes} festival={festival} sound={sound}
              hub={{
                label: t('lucky.hub.go'),
                sub: spinning ? undefined : hubSub,
                ariaLabel: t('lucky.hub.aria', { n: unused }),
                disabled: !active || unused <= 0,
                busy: spinning,
                invite: active && unused > 0,
                onPress: () => void onSpin(),
              }} />
          </div>

          <div className="lk-stage-foot">
            <div className={`lk-stack ${unused > 0 ? '' : 'is-empty'}`}>
              {/* data-n：剩 1–2 张时只叠 1–2 张；0 张时三张灰色空白券 / data-n: 1–2 left shows 1–2 cards; 0 shows three grey blanks */}
              <span className="lk-stack-cards" data-n={Math.min(unused, 3)} aria-hidden>
                <i /><i /><i />
                {tear > 0 && <i key={tear} className="lk-stack-fly" />}
              </span>
              <span className="lk-stack-n">
                {t('lucky.available')} <b key={bump} className={bump > 0 ? 'is-bump' : undefined}>{unused}</b>
              </span>
            </div>
            <p className="lk-cheer" aria-live="polite">{t(cheer)}</p>
            <button type="button" className={`lk-sound ${sound ? 'is-on' : ''}`} aria-pressed={sound}
              aria-label={t(sound ? 'lucky.sound.mute' : 'lucky.sound.unmute')} title={t(sound ? 'lucky.sound.mute' : 'lucky.sound.unmute')}
              onClick={toggleSound}>
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" />
                {sound
                  ? <><path d="M15.5 9a4.2 4.2 0 0 1 0 6" /><path d="M18 6.5a7.8 7.8 0 0 1 0 11" /></>
                  : <path d="M16 9.5l5 5M21 9.5l-5 5" />}
              </svg>
            </button>
          </div>
          {err && <p className="lk-err" role="alert">{err}</p>}
          <p className="lk-void">{t('lucky.voidNotice')}</p>
        </section>

        <aside className="lk-side">
          <TicketWallet unused={unused} batches={cur.tickets.batches} />
          <PrizeList prizes={cur.prizes} />
          <MyPrizes draws={draws} onChange={setDraws} navigate={navigate} />
        </aside>
      </div>

      {modal}
    </div>
  )
}
