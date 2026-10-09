// 注册弹窗：游客在预览里点了任何操作，都落到这里。
//
// 文案跟着「点了什么」走（点了 XAUUSD 的下单，就说解锁这条 XAUUSD 信号），因为那一刻访客
// 想要的东西最具体。所有数字都是真的：倒计时是这条信号真实的失效时间，参赛人数来自公开
// 比赛，试用天数来自后台开关——开关关着时，承诺换成 FREE 账户真实能得到的东西，绝不许诺
// 注册后看不到的实时信号。
// The sign-up modal every gated click lands on. Copy follows what was clicked, because that
// is the moment the visitor's want is most specific. Every number is real: the countdown is
// the signal's actual expiry, entrants come from the public competition, trial days from the
// admin switch — and with the trial off the promise switches to what a FREE account really
// gets, never live signals the visitor wouldn't see after signing up.
import { useId, useRef, type FC, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { CompetitionSummary, Signal } from '../api/types'
import { displaySymbol } from '../api/utils'
import { symbolMeta } from '../utils/symbolMeta'
import { useDialogA11y } from '../utils/useDialogA11y'
import { useBackToClose } from '../utils/useBackToClose'
import LockedPx from '../components/signals/LockedPx'
import Logo from '../components/Logo'
import { ClockTtlRing } from '../components/signals/TtlRing'
import type { GateReason } from './gate'
import type { GuestOffer } from './previewData'

interface Props {
  reason: GateReason
  signal: Signal | null
  nextExpiry: string | null
  activeCount: number
  competition: CompetitionSummary | null
  offer: GuestOffer
  onClose: () => void
  onRegister: () => void
  onLogin: () => void
  onLearnMore: () => void
  onCompetition: () => void
}

const Check = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M20 6L9 17l-5-5" />
  </svg>
)

const GateModal: FC<Props> = ({
  reason, signal, nextExpiry, activeCount, competition, offer,
  onClose, onRegister, onLogin, onLearnMore, onCompetition,
}) => {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()
  useDialogA11y(ref, onClose)
  useBackToClose(true, onClose)

  const trialDays = offer.inviteTrialDays ?? offer.trialDays
  const pro = trialDays != null

  let title: string
  let sub: string
  let visual: ReactNode = null
  switch (reason.kind) {
    case 'trade': {
      const sym = signal ? displaySymbol(signal.symbol) : ''
      title = t('guest.gate.trade.title', { symbol: sym })
      sub = pro ? t('guest.gate.trade.subPro', { days: trialDays }) : t('guest.gate.trade.subFree')
      if (signal) {
        const meta = symbolMeta(signal.symbol)
        const isBuy = signal.side === 'BUY'
        const rr = signal.locked?.rr
        visual = (
          <div className="gst-ticket">
            <div className="gst-ticket-top">
              <span className="sym-ava" style={{ background: meta.color + '33', color: meta.ink }}>{meta.letter}</span>
              <b className="font-display">{sym}</b>
              <span className={`chip ${isBuy ? 'chip-buy' : 'chip-sell'}`}>{isBuy ? t('common.buy') : t('common.sell')}</span>
              {rr != null && <span className="gst-ticket-rr num">1:{rr.toFixed(2)}</span>}
            </div>
            <div className="gst-ticket-px">
              <div><span>{t('signals.colSl')}</span><LockedPx symbol={signal.symbol} seed={`${signal.id}:sl`} /></div>
              <div><span>{t('signals.colEntry')}</span><LockedPx symbol={signal.symbol} seed={`${signal.id}:e`} /></div>
              <div><span>{t('signals.colTp')}</span><LockedPx symbol={signal.symbol} seed={`${signal.id}:tp`} /></div>
            </div>
            {signal.status === 'ACTIVE' && (
              <div className="gst-ticket-ttl">
                <ClockTtlRing expireAt={signal.expireAt} label={t('guest.gate.trade.expires')} />
                <span>{t('guest.gate.trade.fomo')}</span>
              </div>
            )}
          </div>
        )
      }
      break
    }
    case 'nav':
      title = t(`guest.gate.nav.${reason.page}.title`)
      sub = t(`guest.gate.nav.${reason.page}.sub`)
      break
    case 'competition':
      title = competition ? t('guest.gate.comp.title', { name: competition.name }) : t('guest.gate.comp.titleNone')
      sub = competition?.participants
        ? t('guest.gate.comp.sub', { n: competition.participants })
        : t('guest.gate.comp.subNone')
      break
    case 'personal':
      title = t('guest.gate.personal.title')
      sub = t('guest.gate.personal.sub')
      break
    case 'history':
      title = t('guest.gate.history.title')
      sub = t('guest.gate.history.sub')
      break
    case 'exit':
      title = t('guest.gate.exit.title', { n: activeCount })
      sub = t('guest.gate.exit.sub')
      if (nextExpiry) {
        visual = (
          <div className="gst-ticket gst-ticket-exit">
            <ClockTtlRing expireAt={nextExpiry} label={t('guest.gate.exit.next')} />
          </div>
        )
      }
      break
    default:
      title = t('guest.gate.generic.title')
      sub = t('guest.gate.generic.sub')
  }

  const perks = pro
    ? [t('guest.gate.perkPro1'), t('guest.gate.perkPro2'), t('guest.gate.perkPro3')]
    : [t('guest.gate.perkFree1'), t('guest.gate.perkFree2'), t('guest.gate.perkFree3')]

  return createPortal(
    <div className="gst-gate-overlay" data-guest-allow onClick={onClose}>
      <div
        ref={ref}
        className="gst-gate"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <button type="button" className="gst-gate-x" onClick={onClose} aria-label={t('guest.gate.close')}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M18 6L6 18M6 6l12 12" /></svg>
        </button>
        {/* 品牌标而不是「发光方块里一把锁」：后者是模板味最重的那种装饰，锁的意思
            已经由下面那张磨砂小票说清楚了。
            The brand mark rather than a lock in a glowing tile — that tile is the most
            template-looking ornament there is, and the frosted ticket below already says "locked". */}
        <div className="gst-gate-mark" aria-hidden><Logo size={44} /></div>
        <h2 id={titleId} className="gst-gate-title">{title}</h2>
        <p className="gst-gate-sub">{sub}</p>
        {visual}
        <ul className="gst-gate-perks">
          {perks.map((p) => (
            <li key={p}><Check />{p}</li>
          ))}
        </ul>
        {pro && (
          <div className="gst-gate-offer">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <rect x="3" y="8" width="18" height="13" rx="2" /><path d="M12 8v13M3 12h18M12 8c-2-3-6-3-6 0h6zm0 0c2-3 6-3 6 0h-6z" />
            </svg>
            <div>
              <b>{offer.inviteTrialDays != null ? t('guest.gate.offerInvite', { days: trialDays }) : t('guest.gate.offerTrial', { days: trialDays })}</b>
              <span>{t('guest.gate.offerNote')}</span>
            </div>
          </div>
        )}
        <button type="button" className="btn btn-primary gst-gate-cta" onClick={onRegister}>
          {pro ? t('guest.gate.ctaPro') : t('guest.gate.cta')}
        </button>
        <p className="gst-gate-note">{t('guest.gate.ctaNote')}</p>
        {reason.kind === 'competition' && competition && (
          <button type="button" className="btn btn-ghost gst-gate-alt" onClick={onCompetition}>
            {t('guest.gate.comp.view')}
          </button>
        )}
        <div className="gst-gate-links">
          <button type="button" onClick={onLogin}>{t('guest.gate.login')}</button>
          <span aria-hidden>·</span>
          <button type="button" onClick={onLearnMore}>{t('guest.gate.learnMore')}</button>
        </div>
        {competition?.participants && reason.kind !== 'competition' ? (
          <p className="gst-gate-social">
            <i className="animate-breathe" aria-hidden />
            {t('guest.gate.social', { n: competition.participants, name: competition.name })}
          </p>
        ) : null}
      </div>
    </div>,
    document.body,
  )
}

export default GateModal
