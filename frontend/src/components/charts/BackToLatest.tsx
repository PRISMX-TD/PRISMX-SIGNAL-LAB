// 「回到最新」按钮（同 TradingView 右下角那个 »）：往左翻看历史、最新一根已经不在屏幕右缘时
// 出现，点一下滚回实时。
// "Scroll to the latest bar" button (TradingView's » at the bottom right): shows once the
// latest bar has left the right edge while browsing history; one click scrolls back.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { IChartApi } from 'lightweight-charts'

export default function BackToLatest({ chart }: { chart: IChartApi }) {
  const { t } = useTranslation()
  const [show, setShow] = useState(false)
  useEffect(() => {
    const ts = chart.timeScale()
    // 往右空白区拖远了也出现（这时不再自动跟随）/ also when dragged far into the empty right side (no auto-follow then)
    const check = () => { const pos = ts.scrollPosition(); setShow(pos < -3 || pos > ts.options().rightOffset + 3) }
    ts.subscribeVisibleLogicalRangeChange(check)
    check()
    return () => ts.unsubscribeVisibleLogicalRangeChange(check)
  }, [chart])
  if (!show) return null
  const label = String(t('charts.backToLatest'))
  return (
    <button type="button" className="chart-latest" onClick={() => chart.timeScale().scrollToRealTime()} title={label} aria-label={label}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M6 6l6 6-6 6M13 6l6 6-6 6" /></svg>
    </button>
  )
}
