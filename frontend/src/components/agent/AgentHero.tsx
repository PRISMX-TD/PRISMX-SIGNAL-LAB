// 推荐官中心的页头（2026-10-28 重做）：左边一张推荐官凭证卡，右边是页面标题和团队的核心数字。
//
// 卡上的东西都是真数据：头衔（一级推荐官才写「一级」——二级起后端不下发层级，见 AgentTeam）、
// 昵称、任命日期、第一条启用中链接的推荐码。数字优先取「团队」里自己那一行（与「团队」页签
// 同口径）；团队没拉到（接口失败）就退回把「我的链接」各卡加总。团队还在加载时只出骨架，
// 不先拿链接数字顶上——否则数字会先跳一个值再换成另一个。
//
// 动效都有理由：卡片进场 + 一次扫光（这是页面的主角）、数字从 0 走到实际值（第一眼读到规模），
// 桌面端指针在卡上移动时卡片微倾、反光跟手（实物感）。减弱动效时全部关掉。
//
// The Ambassador Hub head (redrawn 2026-10-28): a credential card on the left,
// the page title and the team's key figures on the right. Everything on the card
// is real: the rank (top-level only — levels are not sent below level 1), nickname,
// appointment date and the first active link's code. Figures come from the caller's
// own Team row (same definition as the Team tab), falling back to the sum of the
// link cards when the team call failed; while it loads only a skeleton shows, so
// the numbers never jump from one source to the other. Motion: card entrance with
// one sheen sweep, count-up figures, pointer tilt on desktop; all off under
// reduced motion.
import { useEffect, useLayoutEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../store/auth'
import { LOGO_SRC, LOGO_SRCSET } from '../Logo'
import { SkeletonLine } from '../Skeleton'
import type { AgentLink, AgentTeam } from '../../api/types'

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

const fmtCount = (n: number) => n.toLocaleString('en-US')

// 卡上的任命日只写日期（北京时间切天），不带时刻：卡面窄，时刻对这行字没有意义。
// The card shows the appointment day only (Beijing calendar day); the time adds nothing there.
const cardDay = (iso: string) => {
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })
}

// 数字从上一个值走到新值。直接写 textContent，不走 React state：每帧重渲染整个页头不值得。
// 首帧之前（layout effect）先写成起点，免得先闪一下终值再归零。
// Counts from the previous value to the new one by writing textContent directly
// rather than through state. The layout effect sets the start before first paint,
// so the final value never flashes first.
function CountUp({ value }: { value: number }) {
  const ref = useRef<HTMLSpanElement>(null)
  const from = useRef(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const start = from.current
    from.current = value
    if (prefersReducedMotion() || start === value) {
      el.textContent = fmtCount(value)
      return
    }
    el.textContent = fmtCount(start)
    const t0 = performance.now()
    const dur = 1100
    let raf = 0
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / dur)
      const eased = p >= 1 ? 1 : 1 - Math.pow(2, -10 * p)
      el.textContent = fmtCount(Math.round(start + (value - start) * eased))
      if (p < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      el.textContent = fmtCount(value)
    }
  }, [value])
  return <span ref={ref}>{fmtCount(value)}</span>
}

// 桌面端（能悬停的精确指针）卡片随指针微倾，反光与箔色跟着走；写 CSS 变量，不碰 React。
// Desktop-only pointer tilt: CSS variables on the card, React untouched.
function useCardTilt(ref: React.RefObject<HTMLDivElement>) {
  useEffect(() => {
    const el = ref.current
    if (!el || prefersReducedMotion() || !window.matchMedia?.('(hover: hover) and (pointer: fine)').matches) return
    let raf = 0
    const onMove = (e: PointerEvent) => {
      const r = el.getBoundingClientRect()
      const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
      const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        el.classList.add('is-tilting')
        el.style.setProperty('--rx', `${((0.5 - y) * 9).toFixed(2)}deg`)
        el.style.setProperty('--ry', `${((x - 0.5) * 12).toFixed(2)}deg`)
        el.style.setProperty('--mx', `${(x * 100).toFixed(1)}%`)
        el.style.setProperty('--my', `${(y * 100).toFixed(1)}%`)
      })
    }
    const onLeave = () => {
      cancelAnimationFrame(raf)
      el.classList.remove('is-tilting')
      for (const k of ['--rx', '--ry', '--mx', '--my']) el.style.removeProperty(k)
    }
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerleave', onLeave)
    return () => {
      cancelAnimationFrame(raf)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerleave', onLeave)
    }
  }, [ref])
}

export default function AgentHero({
  team,
  teamReady,
  links,
  subtitle,
}: {
  team: AgentTeam | null
  // 团队接口已经有结果（成功或失败）。/ The team call has settled, either way.
  teamReady: boolean
  links: AgentLink[] | null
  subtitle: string
}) {
  const { t } = useTranslation()
  const { user } = useAuth()
  const cardRef = useRef<HTMLDivElement>(null)
  useCardTilt(cardRef)

  const self = team?.nodes.find((n) => n.isSelf) ?? null
  const name = self?.nickname || self?.email || user?.email || ''
  const rank = team?.level === 1 ? t('agent.hero.rankTop') : t('agent.hero.role')
  // 只写启用中的推荐码：停用的码印在凭证上会被当成还能用。/ Only a live code goes on the card.
  const code = (links ?? []).find((l) => l.isActive)?.code ?? null

  const sum = (k: 'clicks' | 'registrations' | 'activeUsers7d' | 'mt5Users') =>
    (links ?? []).reduce((acc, l) => acc + l[k], 0)
  const figures = !teamReady
    ? null
    : self
      ? {
          lead: { label: t('agent.team.total'), value: self.teamCustomers },
          rest: [
            { label: t('agent.team.direct'), value: self.directCustomers },
            { label: t('agent.active7d'), value: self.activeUsers7d },
            { label: t('agent.mt5Users'), value: self.mt5Users },
            { label: t('agent.hero.downline'), value: Math.max(0, (team?.nodes.length ?? 1) - 1) },
          ],
        }
      : links
        ? {
            lead: { label: t('agent.registrations'), value: sum('registrations') },
            rest: [
              { label: t('agent.clicks'), value: sum('clicks') },
              { label: t('agent.active7d'), value: sum('activeUsers7d') },
              { label: t('agent.mt5Users'), value: sum('mt5Users') },
            ],
          }
        : null

  return (
    <header className="agt-hero">
      <div className="agt-hero-head">
        <h1 className="font-display">{t('agent.title')}</h1>
        <p>{subtitle}</p>
      </div>

      <div className="agt-card-wrap">
        <div className="agt-card" ref={cardRef}>
          <div className="agt-card-guilloche" aria-hidden="true" />
          <div className="agt-card-sheen" aria-hidden="true" />
          <div className="agt-card-body">
            <div className="agt-card-top">
              <span className="agt-card-brand">
                <img src={LOGO_SRC} srcSet={LOGO_SRCSET} sizes="26px" alt="" draggable={false} />
                <span>SIGNAL LAB</span>
              </span>
              <span className="agt-card-seal" aria-hidden="true" />
            </div>
            <p className="agt-card-role font-display">{rank}</p>
            <div className="agt-card-foot">
              <div className="min-w-0">
                <p className="agt-card-name">{name}</p>
                {self?.createdAt && cardDay(self.createdAt) && (
                  <p className="agt-card-since num">{t('agent.team.since', { date: cardDay(self.createdAt) })}</p>
                )}
              </div>
              {code && (
                <div className="agt-card-code">
                  <span>{t('agent.hero.code')}</span>
                  <b className="num">{code}</b>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="agt-stats">
        {figures ? (
          <>
            <div className="agt-stats-lead">
              <b className="num">
                <CountUp value={figures.lead.value} />
              </b>
              <span>{figures.lead.label}</span>
            </div>
            <div className="agt-stats-rule bg-spectral-rule" aria-hidden="true" />
            <dl className="agt-stats-row">
              {figures.rest.map((f, i) => (
                <div key={f.label} style={{ '--i': i } as React.CSSProperties}>
                  <dt>{f.label}</dt>
                  <dd className="num">
                    <CountUp value={f.value} />
                  </dd>
                </div>
              ))}
            </dl>
          </>
        ) : (
          <div aria-busy="true" className="space-y-4">
            <SkeletonLine width="38%" height={56} />
            <SkeletonLine height={1} />
            <SkeletonLine width="72%" height={36} />
          </div>
        )}
      </div>
    </header>
  )
}
