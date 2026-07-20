// 历史信号回放（模拟器）：用平台已判定的真实信号，回放一条"如果每单都跟"的
// 净值曲线——包含亏损段、最大回撤与最长连亏。数据源是全局信号表（不含任何用户
// 私有数据），所以这一页天然具备"未来可公开"的条件。
//
// **当前仅管理员可见**：路由挂在 AdminOnly 下、后端端点也是 require_admin，
// 功能先内部试用。对外开放时：后端把 require_admin 换回 get_current_user，
// 前端把路由的 AdminOnly 包装与两处入口的 isAdmin 判断去掉即可，本页组件本身
// 不需要任何改动。
//
// Historical signal replay: an equity curve of "what if you took every trade",
// built from real, already-resolved signals — losing stretches, max drawdown
// and longest losing streak included. It reads the global signals table only
// (no user-private data), which is what makes this page publishable later.
//
// **Admin-only for now**: the route sits behind AdminOnly and the backend
// endpoint behind require_admin, while the feature is trialed internally. To
// release it: swap the backend dep back to get_current_user and drop the
// AdminOnly wrapper + the two isAdmin entry checks — this component itself
// needs no changes.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { simulateApi } from '../api/client'
import { displaySymbol, fmtTime, localizeApiError } from '../api/utils'
import type { SimulateResult } from '../api/types'

const DAYS_OPTIONS = [30, 90, 180] as const
const PAGE_SIZE = 20

// 净值曲线画布 / equity curve canvas
const CURVE_W = 600
const CURVE_H = 240

// 参数改动后的防抖：滑杆连续拖动时不要每一格都打一次接口。
// Debounce after a param change: dragging the slider shouldn't fire a request per notch.
const DEBOUNCE_MS = 300

function fmtMoney(v: number): string {
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// 本金输入框：自己维护一份文本缓冲，只在失焦（或回车）时才解析+夹紧+回传。
// 沿用指标设置弹窗踩过的坑（见产品需求文档 6.18 节第四步）：每敲一键就解析
// 夹紧会让用户清空重打时被强制弹回旧值，根本敲不进新数字。
// Capital input: keeps its own text buffer, parsing/clamping/propagating only
// on blur (or Enter). Mirrors the fix from the indicator settings modal —
// parsing on every keystroke bounces the user back to the old value mid-edit.
function CapitalField({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const { t } = useTranslation()
  const [text, setText] = useState(String(value))

  useEffect(() => { setText(String(value)) }, [value])

  const commit = () => {
    const n = Number(text)
    const clamped = !Number.isFinite(n) || n <= 0 ? value : Math.min(1e9, Math.max(1, Math.round(n)))
    setText(String(clamped))
    if (clamped !== value) onChange(clamped)
  }

  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[11px] uppercase tracking-wide text-slate-500">{t('simulator.capital')}</span>
      <input
        type="number"
        className="input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
      />
    </label>
  )
}

// 净值曲线：纯 SVG，不引图表库——这页不需要缩放/十字准线这类交互。
// x 按**索引**均分而不是真实时间：信号在时间轴上分布很不均匀（可能一天十条、
// 接着两天没有），按真实时间画会挤成几坨，读不出形状。
// Equity curve: plain SVG, no charting lib — this page needs no zoom/crosshair.
// x is spaced by INDEX, not real time: signals cluster very unevenly (ten in a
// day, then nothing for two), so a real-time axis would bunch into blobs.
function EquityCurve({ points, capital }: { points: Array<{ equity: number }>; capital: number }) {
  const { t } = useTranslation()
  if (points.length < 2) return null

  // 基准线（初始本金）也要参与取值域，否则全程盈利时基准线会被画到画布外面。
  // The baseline (starting capital) joins the domain — otherwise an all-winning
  // run would push it outside the canvas.
  const values = [...points.map((p) => p.equity), capital]
  const rawLo = Math.min(...values)
  const rawHi = Math.max(...values)
  const lo = rawLo * 0.98
  const hi = rawHi * 1.02
  const span = hi - lo || 1 // 全平时避免除零 / avoid /0 on a perfectly flat run

  const y = (v: number) => CURVE_H - ((v - lo) / span) * CURVE_H
  const x = (i: number) => (i * CURVE_W) / (points.length - 1)

  const line = points.map((p, i) => `${x(i).toFixed(1)},${y(p.equity).toFixed(1)}`).join(' ')
  const final = points[points.length - 1].equity
  const toneClass = final >= capital ? 'text-up' : 'text-down'
  const baselineY = y(capital)

  return (
    <div className={toneClass}>
      <svg viewBox={`0 0 ${CURVE_W} ${CURVE_H}`} className="w-full" preserveAspectRatio="none" role="img">
        {/* 初始本金基准线 / starting-capital baseline */}
        <line
          x1="0" y1={baselineY} x2={CURVE_W} y2={baselineY}
          stroke="currentColor" strokeOpacity="0.25" strokeWidth="1" strokeDasharray="4 4"
          className="text-slate-400"
        />
        <polyline
          fill="none" stroke="currentColor" strokeWidth="2"
          strokeLinecap="round" strokeLinejoin="round" points={line}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div className="mt-1 text-right text-[11px] text-slate-500">
        {t('simulator.baseline')}: ${fmtMoney(capital)}
      </div>
    </div>
  )
}

export default function SimulatorPage() {
  const { t } = useTranslation()

  const [capital, setCapital] = useState(10000)
  const [risk, setRisk] = useState(1.0)
  const [days, setDays] = useState<number>(90)
  const [mode, setMode] = useState<'compound' | 'flat'>('compound')

  const [data, setData] = useState<SimulateResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(0)
  const reqIdRef = useRef(0)

  useEffect(() => { document.title = t('simulator.title') }, [t])

  const run = useCallback(async () => {
    const id = ++reqIdRef.current
    setLoading(true)
    try {
      const res = await simulateApi.run({ days, risk, capital, mode })
      // 丢弃过期响应：快速改参数时，先发的请求可能后到，不能让它盖掉新结果。
      // Drop stale responses: with rapid param changes an earlier request can
      // land last and must not overwrite the newer result.
      if (id !== reqIdRef.current) return
      setData(res)
      setError(null)
    } catch (e: unknown) {
      if (id !== reqIdRef.current) return
      setError(e instanceof Error ? localizeApiError(e.message) : 'Unknown error')
    } finally {
      if (id === reqIdRef.current) setLoading(false)
    }
  }, [days, risk, capital, mode])

  useEffect(() => {
    const timer = window.setTimeout(run, DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [run])

  // 参数变化后回到第一页 / back to page 1 whenever the result set changes
  useEffect(() => { setPage(0) }, [data])

  const summary = data?.summary
  const trades = useMemo(() => data?.trades ?? [], [data])
  const totalPages = Math.max(1, Math.ceil(trades.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages - 1)
  const pageTrades = trades.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE)

  const segBtn = (active: boolean) =>
    `rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
      active
        ? 'border-prism-500/50 bg-prism-600/20 text-prism-200'
        : 'border-white/10 bg-white/5 text-slate-400 hover:text-slate-100'
    }`

  return (
    <div className="mx-auto max-w-5xl py-6">
      {/* 标题 / header */}
      <div className="mb-5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-display text-2xl font-bold text-slate-50">{t('simulator.title')}</h2>
          <span className="tag bg-amber-400/15 text-amber-300 ring-1 ring-amber-400/30">
            {t('simulator.adminOnly')}
          </span>
        </div>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-slate-400">{t('simulator.subtitle')}</p>
      </div>

      {/* 参数 / parameters */}
      <section className="glass mb-5 p-5">
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
          <CapitalField value={capital} onChange={setCapital} />

          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] uppercase tracking-wide text-slate-500">
              {t('simulator.risk')} · <b className="num text-prism-300">{risk.toFixed(1)}%</b>
            </span>
            <input
              type="range"
              min={0.1}
              max={3}
              step={0.1}
              value={risk}
              onChange={(e) => setRisk(parseFloat(e.target.value))}
              className="w-full accent-prism-500"
            />
          </label>

          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] uppercase tracking-wide text-slate-500">{t('simulator.range')}</span>
            <div className="flex flex-wrap gap-2">
              {DAYS_OPTIONS.map((d) => (
                <button key={d} onClick={() => setDays(d)} className={segBtn(days === d)}>
                  {t(`simulator.days${d}`)}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] uppercase tracking-wide text-slate-500">{t('simulator.mode')}</span>
            <div className="flex flex-wrap gap-2">
              <button onClick={() => setMode('compound')} className={segBtn(mode === 'compound')}>
                {t('simulator.modeCompound')}
              </button>
              <button onClick={() => setMode('flat')} className={segBtn(mode === 'flat')}>
                {t('simulator.modeFlat')}
              </button>
            </div>
          </div>
        </div>
      </section>

      {error ? (
        <div className="glass mb-5 p-6 text-center text-sm text-down">{error}</div>
      ) : loading && !data ? (
        <div className="flex items-center justify-center py-16">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-prism-600/30 border-t-prism-500" />
        </div>
      ) : summary && trades.length === 0 ? (
        <div className="glass mb-5 p-8 text-center text-sm text-slate-500">{t('simulator.noData')}</div>
      ) : summary ? (
        <>
          {/* 净值归零横幅 / wipeout banner */}
          {summary.busted && (
            <div className="mb-5 rounded-inner border border-down/30 bg-down/10 p-3.5 text-sm text-down">
              {t('simulator.busted')}
            </div>
          )}

          {/* 汇总 / summary */}
          <section className={`glass mb-5 p-5 transition-opacity ${loading ? 'opacity-60' : ''}`}>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
              <div className="rounded-lg bg-white/[0.03] px-3 py-2.5">
                <div className="text-[11px] text-slate-500">{t('simulator.finalEquity')}</div>
                <div className="num mt-1 text-xl font-bold text-slate-100">${fmtMoney(summary.finalEquity)}</div>
              </div>
              <div className="rounded-lg bg-white/[0.03] px-3 py-2.5">
                <div className="text-[11px] text-slate-500">{t('simulator.returnPct')}</div>
                <div className={`num mt-1 text-xl font-bold ${summary.returnPct >= 0 ? 'text-up' : 'text-down'}`}>
                  {summary.returnPct >= 0 ? '+' : ''}{summary.returnPct.toFixed(2)}%
                </div>
              </div>
              {/* 最大回撤与最长连亏永远红色、字号与收益同级——敢把这两个数字
                  摆在跟收益一样显眼的位置，正是这一页的意义所在，不许弱化。
                  Max drawdown and longest losing streak are always red and as
                  prominent as the return — showing them at equal weight is the
                  entire point of this page. Never de-emphasize them. */}
              <div className="rounded-lg bg-white/[0.03] px-3 py-2.5">
                <div className="text-[11px] text-slate-500">{t('simulator.maxDrawdown')}</div>
                <div className="num mt-1 text-xl font-bold text-down">-{summary.maxDrawdownPct.toFixed(2)}%</div>
              </div>
              <div className="rounded-lg bg-white/[0.03] px-3 py-2.5">
                <div className="text-[11px] text-slate-500">{t('simulator.maxLossStreak')}</div>
                <div className="num mt-1 text-xl font-bold text-down">{summary.maxLossStreak}</div>
              </div>
              <div className="rounded-lg bg-white/[0.03] px-3 py-2.5">
                <div className="text-[11px] text-slate-500">{t('simulator.winRate')}</div>
                <div className="num mt-1 text-xl font-bold text-slate-100">
                  {summary.winRate == null ? '-' : `${Math.round(summary.winRate * 100)}%`}
                  <span className="ml-1.5 text-xs font-normal text-slate-500">
                    {summary.wins}/{summary.wins + summary.losses}
                  </span>
                </div>
              </div>
              <div className="rounded-lg bg-white/[0.03] px-3 py-2.5">
                <div className="text-[11px] text-slate-500">{t('simulator.avgRr')}</div>
                <div className="num mt-1 text-xl font-bold text-slate-100">
                  {summary.avgRr == null ? '-' : `${summary.avgRr.toFixed(2)}R`}
                </div>
              </div>
            </div>
            {summary.skipped > 0 && (
              <p className="mt-3 text-[11px] text-slate-500">{t('simulator.skipped', { n: summary.skipped })}</p>
            )}
          </section>

          {/* 净值曲线 / equity curve */}
          <section className={`glass mb-5 p-5 transition-opacity ${loading ? 'opacity-60' : ''}`}>
            <h3 className="mb-3 font-display text-lg font-semibold text-slate-100">{t('simulator.equityCurve')}</h3>
            <EquityCurve points={data!.points} capital={capital} />
          </section>

          {/* 逐单明细 / trade-by-trade detail */}
          <section className={`glass mb-5 p-5 transition-opacity ${loading ? 'opacity-60' : ''}`}>
            <h3 className="font-display text-lg font-semibold text-slate-100">{t('simulator.trades')}</h3>

            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wider text-slate-500">
                    <th className="px-3 py-2 font-medium">{t('orders.colTime')}</th>
                    <th className="px-3 py-2 font-medium">{t('orders.colSymbol')}</th>
                    <th className="px-3 py-2 font-medium">{t('orders.colSide')}</th>
                    <th className="px-3 py-2 font-medium">{t('simulator.result')}</th>
                    <th className="px-3 py-2 text-right font-medium">{t('simulator.tradeRr')}</th>
                    <th className="px-3 py-2 text-right font-medium">{t('simulator.tradePnl')}</th>
                    <th className="px-3 py-2 text-right font-medium">{t('simulator.equityAfter')}</th>
                  </tr>
                </thead>
                <tbody>
                  {pageTrades.map((tr) => (
                    <tr key={tr.id} className="border-b border-white/5">
                      <td className="whitespace-nowrap px-3 py-2 text-slate-400">{fmtTime(tr.createdAt)}</td>
                      <td className="px-3 py-2 font-mono text-slate-100">{displaySymbol(tr.symbol)}</td>
                      <td className="px-3 py-2">
                        <span className={`tag ${tr.side === 'BUY' ? 'bg-up/15 text-up' : 'bg-down/15 text-down'}`}>
                          {tr.side === 'BUY' ? t('common.buy') : t('common.sell')}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <span className={`tag ${tr.result === 'HIT_TP' ? 'bg-up/15 text-up' : 'bg-down/15 text-down'}`}>
                          {t(`winrate.${tr.result === 'HIT_TP' ? 'hitTp' : 'hitSl'}`)}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-slate-300">{tr.rr.toFixed(2)}R</td>
                      <td className={`px-3 py-2 text-right font-mono font-semibold ${tr.pnlPct >= 0 ? 'text-up' : 'text-down'}`}>
                        {tr.pnlPct >= 0 ? '+' : ''}{tr.pnlPct.toFixed(2)}%
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-slate-200">${fmtMoney(tr.equityAfter)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {totalPages > 1 && (
              <div className="mt-3 flex items-center justify-between text-xs text-slate-400">
                <span>{t('orders.pageInfo', { page: safePage + 1, totalPages, total: trades.length })}</span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                    disabled={safePage === 0}
                    className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-300 transition hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {t('common.prevPage')}
                  </button>
                  <button
                    onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                    disabled={safePage + 1 >= totalPages}
                    className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-300 transition hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {t('common.nextPage')}
                  </button>
                </div>
              </div>
            )}
          </section>
        </>
      ) : null}

      {/* 合规免责：这条不适用"小字免责"惯例，必须清晰可读。
          Compliance disclaimer: exempt from the fine-print habit — must stay legible. */}
      <p className="text-xs leading-relaxed text-slate-500">{t('simulator.disclaimer')}</p>
    </div>
  )
}
