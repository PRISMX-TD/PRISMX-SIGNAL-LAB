// 实时行情图表页：嵌入 TradingView 高级图表 Widget。
// Live charts page: embeds the TradingView Advanced Chart widget.
//
// 数据由用户浏览器直连 TradingView，不经过后端 / VPS，因此无论多少用户都
// 不会给后端带来额外负载。品种为固定预设列表（贵金属/能源/加密/热门货币对）。
// Candle data is fetched by the browser directly from TradingView (never via
// our backend/VPS), so it adds no server load regardless of user count. The
// symbol list is a fixed preset (metals/energy/crypto/popular FX pairs).
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { mt5ToTradingView } from '../api/utils'
import { usePrefs } from '../store/prefs'

// 固定品种预设：贵金属 / 能源 / 加密 / 热门货币对。
// Fixed symbol presets: metals / energy / crypto / popular FX pairs.
const PRESET_SYMBOLS = [
  'XAUUSD',
  'XAGUSD',
  'USOIL',
  'BTCUSD',
  'EURUSD',
  'GBPUSD',
  'USDJPY',
  'AUDUSD',
  'USDCAD',
  'USDCHF',
  'NZDUSD',
  'EURJPY',
  'GBPJPY',
]
const INTERVALS: { code: string; label: string }[] = [
  { code: '1', label: '1m' },
  { code: '5', label: '5m' },
  { code: '15', label: '15m' },
  { code: '60', label: '1H' },
  { code: '240', label: '4H' },
  { code: 'D', label: '1D' },
]

// 向后兼容的 localStorage key / backward-compat localStorage keys
const INTERVAL_KEY = 'prismx.charts.interval'
const SYMBOL_KEY = 'prismx.charts.symbol'

export default function ChartsPage() {
  const { t } = useTranslation()
  const { getPref, setPref, loaded } = usePrefs()
  const containerRef = useRef<HTMLDivElement>(null)

  const [symbol, setSymbol] = useState<string>(
    () => {
      // 优先云端偏好 > localStorage 旧缓存 > 默认值
      // cloud prefs > legacy localStorage > default
      const cloud = getPref<string>('charts', 'symbol', '')
      if (cloud && PRESET_SYMBOLS.includes(cloud)) return cloud
      const saved = localStorage.getItem(SYMBOL_KEY)
      return saved && PRESET_SYMBOLS.includes(saved) ? saved : PRESET_SYMBOLS[0]
    }
  )
  const [interval, setIntervalCode] = useState<string>(
    () => getPref<string>('charts', 'interval', '') || localStorage.getItem(INTERVAL_KEY) || '15'
  )

  // 云端偏好加载完成后覆盖本地初始值 / override initial values when cloud prefs arrive
  useEffect(() => {
    if (!loaded) return
    const cloudSym = getPref<string>('charts', 'symbol', '')
    if (cloudSym && PRESET_SYMBOLS.includes(cloudSym)) setSymbol(cloudSym)
    const cloudInt = getPref<string>('charts', 'interval', '')
    if (cloudInt) setIntervalCode(cloudInt)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- only run when cloud prefs finish loading
  }, [loaded])

  useEffect(() => {
    setPref('charts', 'symbol', symbol)
  }, [symbol, setPref])

  useEffect(() => {
    setPref('charts', 'interval', interval)
  }, [interval, setPref])

  const tvSymbol = mt5ToTradingView(symbol)

  // 每次品种 / 周期变化时重建 widget。TradingView 脚本以子节点形式注入，
  // 销毁时清空容器即可。Rebuild the widget on symbol/interval change.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    el.innerHTML = ''

    const widget = document.createElement('div')
    widget.className = 'tradingview-widget-container__widget h-full w-full'
    el.appendChild(widget)

    const script = document.createElement('script')
    script.src =
      'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js'
    script.type = 'text/javascript'
    script.async = true
    script.innerHTML = JSON.stringify({
      symbol: tvSymbol,
      interval,
      autosize: true,
      timezone: 'Asia/Kuala_Lumpur',
      theme: 'dark',
      style: '1',
      locale: t('charts.tvLocale'),
      // 黑紫主题配色 / black & purple theme styling
      backgroundColor: 'rgba(10, 7, 16, 1)',
      gridColor: 'rgba(139, 70, 255, 0.08)',
      hide_top_toolbar: false,
      hide_legend: false,
      // 不默认加载任何指标（含成交量）/ don't load any default study (incl. volume)
      hide_volume: true,
      studies: [],
      allow_symbol_change: false,
      save_image: false,
      withdateranges: true,
      support_host: 'https://www.tradingview.com',
    })
    el.appendChild(script)

    return () => {
      el.innerHTML = ''
    }
  }, [tvSymbol, interval, t])

  return (
    <div className="flex flex-col">
      <div className="mb-5">
        <h2 className="font-display text-2xl font-bold text-slate-100">
          <span className="neon-text">{t('charts.title')}</span>
        </h2>
        <p className="mt-1 text-sm text-slate-400">{t('charts.subtitle')}</p>
      </div>

      {/* 控制条：品种 + 周期 / controls: symbol + interval */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2">
          <span className="text-xs uppercase tracking-wider text-slate-500">
            {t('charts.symbol')}
          </span>
          <select
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
            className="rounded-lg border border-white/10 bg-ink-800/80 px-3 py-1.5 text-sm text-slate-100 outline-none transition focus:border-prism-500"
          >
            {PRESET_SYMBOLS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>

        <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-ink-800/50 p-1">
          {INTERVALS.map((iv) => (
            <button
              key={iv.code}
              onClick={() => setIntervalCode(iv.code)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
                interval === iv.code
                  ? 'bg-prism-600/30 text-prism-200 shadow-prism'
                  : 'text-slate-400 hover:text-slate-100'
              }`}
            >
              {iv.label}
            </button>
          ))}
        </div>
      </div>

      {/* 图表容器：跟随视口高度自适应，移动端给底部 Tab 栏留空间 */}
      {/* Chart container: viewport-relative height, leaves room for the mobile tab bar */}
      <div className="glass relative overflow-hidden p-1.5 h-[70vh] min-h-[420px] sm:h-[calc(100vh-15rem)]">
        <div
          ref={containerRef}
          className="tradingview-widget-container h-full w-full"
        />
      </div>

      <p className="mt-3 text-center text-[11px] text-slate-600">
        {t('charts.disclaimer')}
      </p>
    </div>
  )
}
