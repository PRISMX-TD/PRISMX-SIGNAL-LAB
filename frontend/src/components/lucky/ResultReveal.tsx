// 抽奖结果揭晓卡。三种语气：
//   中奖（PRO / 实物）：彩纸 + 灯珠齐闪（转盘那边）+ 大标题，实物奖品直接在卡里领取；
//   再来一次：券已退回，主按钮「马上再转」；
//   没中（谢谢参与 / 刚被抽完）：不放彩纸，一句宽心的话；还有券就给「再转一次」。
// 打开即把焦点交给主按钮，Esc / 点遮罩关闭；读屏器会读出标题与说明（role=dialog + aria-describedby）。
// The reveal card, in three tones:
//   win (PRO / custom): confetti + the wheel's bulbs flash + a headline; a custom prize is claimed here;
//   spin again: the ticket was refunded, the primary button spins straight away;
//   miss (thanks / just sold out): no confetti, a reassuring line, and "Spin again" while tickets remain.
// Focus goes to the primary button on open; Escape or a backdrop click closes it.
// 挂到 body 上：页面容器带 transform（进场动效）时，position: fixed 会以它为准，遮罩盖不住顶栏、卡片也偏下。
// 外面再套一层 .lk 把节日强调色带过去。
// Portalled to body: a transformed page container (enter animation) would otherwise become the fixed
// containing block, leaving the header uncovered and the card off-centre. The .lk wrapper carries the
// festival accent along.
import { useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { LuckyDraw } from '../../api/luckyTypes'
import type { FestivalKey } from '../../festival/calendar'
import { revealCopy } from '../../utils/luckyView'
import ClaimActions from './ClaimActions'
import Confetti from './Confetti'
import PrizeArt from './PrizeArt'

export default function ResultReveal({ draw, color, festival, again, onAgain, onClose, onChange, navigate }: {
  draw: LuckyDraw
  color: string
  festival: FestivalKey | null
  // 还能再转：剩余券数（0 = 不显示「再转一次」）/ tickets left for another spin (0 hides "Spin again")
  again: number
  onAgain: () => void
  onClose: () => void
  onChange: (d: LuckyDraw) => void
  navigate: (to: string) => void
}) {
  const { t } = useTranslation()
  const titleId = useId()
  const subId = useId()
  const primary = useRef<HTMLButtonElement>(null)
  const copy = revealCopy(draw)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    primary.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const win = copy.tone === 'win'
  const claimable = draw.prize.kind === 'custom' && !draw.soldOut
  // 有实物要领：主操作是领奖，「再转一次」退为次要 / with a prize to claim, claiming is primary
  const showAgain = again > 0 && !claimable
  return createPortal(
    <div className="lk" data-fest={festival ?? undefined}>
      <div className="lk-scrim" onClick={onClose}>
        {win && <Confetti festival={festival} />}
        <div role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={copy.subKey ? subId : undefined}
          className={`lk-reveal is-${copy.tone}`} onClick={(e) => e.stopPropagation()}>
          <div className="lk-reveal-art">
            <PrizeArt kind={draw.soldOut ? 'none' : draw.prize.kind} color={color} imageUrl={draw.soldOut ? null : draw.prize.imageUrl}
              size={96} muted={copy.tone === 'miss'} />
          </div>
          {copy.eyebrowKey && <div className="lk-reveal-eyebrow">{t(copy.eyebrowKey)}</div>}
          <h2 id={titleId} className="lk-reveal-title">{copy.titleText ?? t(copy.titleKey ?? '', copy.params)}</h2>
          {copy.subKey && <p id={subId} className="lk-reveal-sub">{t(copy.subKey, copy.params)}</p>}
          {win && draw.prize.description && !draw.soldOut && <p className="lk-reveal-desc">{draw.prize.description}</p>}
          {claimable && (
            <div className="lk-reveal-claim">
              <ClaimActions draw={draw} onChange={onChange} navigate={navigate} />
            </div>
          )}
          <div className="lk-reveal-actions">
            {showAgain ? (
              <>
                <button ref={primary} type="button" className="btn-primary lk-btn" onClick={onAgain}>
                  {t(copy.tone === 'retry' ? 'lucky.reveal.spinNow' : 'lucky.reveal.again', { n: again })}
                </button>
                <button type="button" className="btn-ghost lk-btn" onClick={onClose}>{t(win ? 'lucky.reveal.keep' : 'lucky.close')}</button>
              </>
            ) : (
              <button ref={primary} type="button" className={`${claimable ? 'btn-ghost' : 'btn-primary'} lk-btn lk-btn-wide`} onClick={onClose}>
                {t(win ? 'lucky.reveal.keep' : 'lucky.close')}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
