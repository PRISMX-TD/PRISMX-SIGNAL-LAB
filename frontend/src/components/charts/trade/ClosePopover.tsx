// 持仓线上点「×」弹出的平仓小窗：选平多少（25% / 50% / 75% / 全部），手数按品种步长向下吸附，
// 不够最小手数的比例直接禁用。它本身就是确认这一步：桌面点按钮，手机滑动确认。
// The close popover from a position line's "×": pick how much (25 / 50 / 75% / all), lots
// floored onto the symbol's step, ratios below a minimum lot disabled. It is itself the
// confirmation: a button on desktop, slide-to-confirm on phones.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Position } from '../../../api/types'
import { baseSymbol, lotDecimals } from '../../../api/utils'
import SlideToConfirm from '../../order/SlideToConfirm'
import { partialVolume } from './tradeMath'

const RATIOS = [0.25, 0.5, 0.75, 1] as const

interface Props {
  position: Position
  /** 弹出位置（覆盖层坐标）/ anchor in overlay coordinates */
  x: number
  y: number
  touch: boolean
  onClose: () => void
  onConfirm: (volume: number | undefined) => void
}

export default function ClosePopover({ position: p, x, y, touch, onClose, onConfirm }: Props) {
  const { t } = useTranslation()
  const tt = (k: string, o?: Record<string, unknown>) => String(t(k, o))
  const [ratio, setRatio] = useState<number>(1)
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })
  const dec = lotDecimals(p.symbol)
  const vol = partialVolume(p.volume, ratio, p.symbol)

  // 贴着按钮弹出，但不越出图表区域 / anchored at the button, kept inside the chart box
  useLayoutEffect(() => {
    const el = ref.current
    const host = el?.parentElement
    if (!el || !host) return
    const w = el.offsetWidth, h = el.offsetHeight
    setPos({
      left: Math.max(6, Math.min(x - w + 16, host.clientWidth - w - 6)),
      top: Math.max(6, Math.min(y, host.clientHeight - h - 6)),
    })
  }, [x, y])

  useEffect(() => {
    const onDown = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) onClose() }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('pointerdown', onDown, true); window.removeEventListener('keydown', onKey) }
  }, [onClose])

  const go = () => { if (vol != null) onConfirm(vol >= p.volume - 1e-9 ? undefined : vol) }
  const label = vol == null ? tt('charts.trade.tooSmall') : tt('charts.trade.closeLots', { lots: vol.toFixed(dec) })

  return (
    <div ref={ref} className="chart-closepop" style={pos} role="dialog" aria-label={tt('charts.trade.closeTitle', { symbol: baseSymbol(p.symbol), side: tt(p.side === 'BUY' ? 'charts.dock.buy' : 'charts.dock.sell'), lots: p.volume.toFixed(dec) })}>
      <b>{tt('charts.trade.closeTitle', { symbol: baseSymbol(p.symbol), side: tt(p.side === 'BUY' ? 'charts.dock.buy' : 'charts.dock.sell'), lots: p.volume.toFixed(dec) })}</b>
      <div className="chart-closepop-ratios" role="group">
        {RATIOS.map((r) => {
          const v = partialVolume(p.volume, r, p.symbol)
          return (
            <button key={r} type="button" className={ratio === r ? 'on' : ''} disabled={v == null} aria-pressed={ratio === r} onClick={() => setRatio(r)}>
              {r === 1 ? tt('charts.trade.all') : `${r * 100}%`}
            </button>
          )
        })}
      </div>
      {touch
        ? <SlideToConfirm disabled={vol == null} onConfirm={go} label={label} />
        : <button type="button" className="chart-closepop-go" disabled={vol == null} onClick={go} autoFocus>{label}</button>}
    </div>
  )
}
