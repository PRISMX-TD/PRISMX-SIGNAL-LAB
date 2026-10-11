// 图表设置小菜单（工具条上的齿轮）：K 线收线倒计时开关 + K 线涨跌颜色。
// 改动即时生效、云端同步（ChartsPage 落 charts.showCountdown / charts.candleColors）。
// 菜单 portal 到 body、按按钮位置 fixed 定位：工具条所在的网格会裁掉溢出的内容。
// Chart settings menu (gear on the toolbar): bar-close countdown switch + candle
// colors. Applies instantly and syncs to the cloud (ChartsPage persists
// charts.showCountdown / charts.candleColors). Portalled to body and positioned
// from the button's rect, because the toolbar's grid clips overflow.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import Switch from '../Switch'
import { ColorDot } from './IndicatorSettingsModal'
import { useBackToClose } from '../../utils/useBackToClose'
import {
  CANDLE_COLOR_PRESETS, CANDLE_SCHEMES, candleSchemeOf, type CandleColors, type CandleScheme,
} from './chartConfig'

interface Props {
  showCountdown: boolean
  onShowCountdown: (v: boolean) => void
  candleColors: CandleColors
  onCandleColors: (c: CandleColors) => void
}

const MENU_W = 280

export default function ChartSettingsMenu({ showCountdown, onShowCountdown, candleColors, onCandleColors }: Props) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 })
  useBackToClose(open, () => setOpen(false))

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return
    const r = btnRef.current.getBoundingClientRect()
    const left = Math.max(8, Math.min(window.innerWidth - MENU_W - 8, r.right - MENU_W))
    setPos({ top: r.bottom + 6, left })
  }, [open])

  useEffect(() => {
    if (!open) return
    // 色板是菜单里的子元素，点它不算「点外面」。/ The palette lives inside the menu.
    const onDown = (e: PointerEvent) => {
      const n = e.target as Node
      if (menuRef.current?.contains(n) || btnRef.current?.contains(n)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const scheme = candleSchemeOf(candleColors)
  const label = String(t('charts.settings.title'))
  const schemes: { v: CandleScheme; label: string }[] = [
    { v: 'greenUp', label: String(t('charts.settings.greenUp')) },
    { v: 'redUp', label: String(t('charts.settings.redUp')) },
  ]

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        title={label}
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`term-tool-btn ${open ? 'on' : ''}`}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>
      {open && createPortal(
        <div ref={menuRef} className="chart-set" role="dialog" aria-label={label} style={{ top: pos.top, left: pos.left, width: MENU_W }}>
          <div className="chart-set-row">
            <span>
              <b>{t('charts.settings.countdown')}</b>
              <small>{t('charts.settings.countdownHint')}</small>
            </span>
            <Switch checked={showCountdown} onChange={onShowCountdown} aria-label={String(t('charts.settings.countdown'))} />
          </div>
          <div className="chart-set-sec">
            <b>{t('charts.settings.candleColors')}</b>
            <span className="ind-seg" role="radiogroup" aria-label={String(t('charts.settings.candleColors'))}>
              {schemes.map((o) => (
                <button
                  key={o.v}
                  type="button"
                  role="radio"
                  aria-checked={scheme === o.v}
                  className={scheme === o.v ? 'on' : ''}
                  onClick={() => onCandleColors({ ...CANDLE_SCHEMES[o.v] })}
                >
                  {o.label}
                </button>
              ))}
            </span>
            <div className="chart-set-custom">
              <span className="chart-set-pick">
                <ColorDot value={candleColors.up} palette={CANDLE_COLOR_PRESETS} label={String(t('charts.settings.upColor'))} onChange={(v) => onCandleColors({ ...candleColors, up: v })} />
                {t('charts.settings.upColor')}
              </span>
              <span className="chart-set-pick">
                <ColorDot value={candleColors.down} palette={CANDLE_COLOR_PRESETS} label={String(t('charts.settings.downColor'))} onChange={(v) => onCandleColors({ ...candleColors, down: v })} />
                {t('charts.settings.downColor')}
              </span>
              {scheme === 'custom' && <em>{t('charts.settings.custom')}</em>}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}
