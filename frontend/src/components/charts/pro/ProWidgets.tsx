// 专业版终端右侧：最右一条图标栏 + 它左边可拖宽的面板。面板五种：
//   自选（行情列表 + 当前品种详情卡）· 交易（下单票 + 账户）· 警报（列表，开关直接停 / 启）·
//   数据窗口（十字线那根的 OHLC / 对比 / 指标值，阶段 6）· 对象树（当前图的全部画线，阶段 6）。
// 再点一次当前图标收起面板，图表变宽；宽度松手才存（拖动中只改本地样式）。
// The pro terminal's right side: an icon strip on the far edge and a resizable panel beside
// it. Five panels: watchlist (list + the active symbol's detail card) · trade (ticket +
// account) · alerts (list with inline stop / resume switches) · data window (OHLC / compare /
// indicator values at the crosshair bar, phase 6) · object tree (the active chart's drawings, phase 6). Clicking the active icon again
// collapses the panel and widens the chart; the width is saved on release only.
import { useCallback, useMemo, useRef, useState, type ReactNode, type SyntheticEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { ChartAlert } from '../../../api/types'
import { useGlobalQuote } from '../../../store/live'
import { displaySymbol, localizeApiError } from '../../../api/utils'
import SymbolLogo from './SymbolLogo'
import { EMPTY } from '../../../utils/format'
import Switch from '../../Switch'
import { splitPrice, type DayStats } from '../SymbolHeader'
import { setAlertActive, useChartAlerts } from '../alert/alertStore'
import { PANEL_MAX, PANEL_MIN, useProPrefs, type ProWidget } from './proPrefs'
import { IcBell, IcClose, IcData, IcDock, IcKeyboard, IcList, IcPlus, IcTrade, IcTree } from './icons'
import { tzOffsetSec } from '../chartTime'
import { convertSessions, fmtMin, useChartSpec, useSymbolSessions } from './symbolMeta'

interface Props {
  widget: ProWidget | null
  onWidget: (w: ProWidget | null) => void
  width: number
  onWidth: (px: number) => void
  watch: ReactNode
  details: ReactNode
  trade: ReactNode
  alerts: ReactNode
  // 数据窗口 / 对象树（当前格）/ data window / object tree (the active cell)
  data: ReactNode
  tree: ReactNode
  alertCount: number
  onKeys: () => void
  dockOpen: boolean
  onDock: () => void
  posBadge: ReactNode
}

const ORDER: { id: ProWidget; icon: ReactNode }[] = [
  { id: 'watch', icon: <IcList size={19} /> },
  { id: 'trade', icon: <IcTrade size={19} /> },
  { id: 'alerts', icon: <IcBell size={19} /> },
  { id: 'data', icon: <IcData size={19} /> },
  { id: 'tree', icon: <IcTree size={19} /> },
]

export default function ProWidgets({ widget, onWidget, width, onWidth, watch, details, trade, alerts, data, tree, alertCount, onKeys, dockOpen, onDock, posBadge }: Props) {
  const { t } = useTranslation()
  const tt = (k: string) => String(t(k))
  const panelRef = useRef<HTMLElement>(null)
  // 拖宽：拖动中直接写面板的 CSS 变量（不过 React），松手再存偏好
  // Resize: while dragging write the panel's CSS variable directly (no React), save on release
  const drag = useRef<{ x0: number; w0: number; id: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const setW = (px: number) => { panelRef.current?.closest<HTMLElement>('.term-shell')?.style.setProperty('--pt-panel-w', `${px}px`) }
  const clampW = (v: number) => Math.round(Math.min(PANEL_MAX, Math.max(PANEL_MIN, v)))

  return (
    <>
      {widget && (
        <aside ref={panelRef} className="pt-panel" aria-label={tt(`charts.pro.w.${widget}`)}>
          <div
            className={`pt-resize-x ${dragging ? 'on' : ''}`}
            role="separator"
            aria-orientation="vertical"
            aria-label={tt('charts.pro.resize')}
            aria-valuenow={width}
            aria-valuemin={PANEL_MIN}
            aria-valuemax={PANEL_MAX}
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
              e.preventDefault()
              onWidth(clampW(width + (e.key === 'ArrowLeft' ? 16 : -16)))
            }}
            onPointerDown={(e) => {
              if (e.button !== 0) return
              e.currentTarget.setPointerCapture(e.pointerId)
              drag.current = { x0: e.clientX, w0: width, id: e.pointerId }
              setDragging(true)
            }}
            onPointerMove={(e) => {
              const d = drag.current
              if (!d || d.id !== e.pointerId) return
              setW(clampW(d.w0 + d.x0 - e.clientX))
            }}
            onPointerUp={(e) => {
              const d = drag.current
              drag.current = null
              setDragging(false)
              if (!d || d.id !== e.pointerId) return
              onWidth(clampW(d.w0 + d.x0 - e.clientX))
            }}
            onPointerCancel={() => { drag.current = null; setDragging(false); setW(width) }}
          />
          <div className="pt-panel-hd">
            <h2>{tt(`charts.pro.w.${widget}`)}</h2>
            <button type="button" className="pt-icon" onClick={() => onWidget(null)} aria-label={tt('charts.pro.collapsePanel')} title={tt('charts.pro.collapsePanel')}>
              <IcClose size={15} />
            </button>
          </div>
          {/* 三块内容都只在打开时挂载：下单票、自选各自订阅报价，收起就别再跟着跳价重渲染
              Each body mounts only while open: the ticket and watchlist subscribe to quotes */}
          {widget === 'watch' && (
            <div className="pt-panel-body pt-watch">
              <div className="pt-watch-list">{watch}</div>
              {details}
            </div>
          )}
          {widget === 'trade' && <div className="pt-panel-body pt-trade no-sb">{trade}</div>}
          {widget === 'alerts' && <div className="pt-panel-body pt-alerts">{alerts}</div>}
          {widget === 'data' && <div className="pt-panel-body pt-data no-sb">{data}</div>}
          {widget === 'tree' && <div className="pt-panel-body pt-tree">{tree}</div>}
        </aside>
      )}
      <nav className="pt-strip" aria-label={tt('charts.pro.panels')}>
        {ORDER.map((w) => (
          <button
            key={w.id}
            type="button"
            className={`pt-strip-btn ${widget === w.id ? 'on' : ''}`}
            onClick={() => onWidget(widget === w.id ? null : w.id)}
            aria-pressed={widget === w.id}
            title={tt(`charts.pro.w.${w.id}`)}
            aria-label={tt(`charts.pro.w.${w.id}`)}
          >
            {w.icon}
            {w.id === 'alerts' && alertCount > 0 && <b>{alertCount}</b>}
          </button>
        ))}
        <span className="pt-strip-gap" />
        <button type="button" className={`pt-strip-btn ${dockOpen ? 'on' : ''}`} onClick={onDock} aria-pressed={dockOpen} title={tt('charts.pro.dock')} aria-label={tt('charts.pro.dock')}>
          <IcDock size={19} />
          {posBadge}
        </button>
        <button type="button" className="pt-strip-btn" onClick={onKeys} title={tt('charts.keys.title')} aria-label={tt('charts.keys.title')}>
          <IcKeyboard size={19} />
        </button>
      </nav>
    </>
  )
}

// ── 品种详情卡 / symbol detail card ──
// 大价格（大手 · 点位 · 末位）+ 涨跌幅、卖 / 买 / 点差三格、日内区间条（现价在区间里的位置）。
// Big price (big figure · pips · last digit) + change, a sell / buy / spread trio, and the day
// range bar with the live price's place in it.
export function ProDetails({ symbol, digits, dayStats, fallback, stale, down, timezone = 'local' }: { symbol: string; digits: number; dayStats: DayStats | null; fallback: number; stale: boolean; down: boolean; timezone?: string }) {
  const { t } = useTranslation()
  const tt = (k: string) => String(t(k))
  const q = useGlobalQuote(symbol)
  const bid = q?.bid ?? (fallback || null)
  const ask = q?.ask ?? null
  const parts = splitPrice(bid, digits)
  const chg = dayStats?.changePct ?? null
  const up = chg != null && chg >= 0
  const spread = bid != null && ask != null && ask >= bid ? Math.round((ask - bid) * Math.pow(10, digits)) : null
  const hi = dayStats?.high ?? null
  const lo = dayStats?.low ?? null
  const pos = bid != null && hi != null && lo != null && hi > lo ? Math.min(1, Math.max(0, (bid - lo) / (hi - lo))) : null
  const state = down ? 'off' : stale ? 'stale' : 'live'
  const f = (v: number | null) => (v == null ? EMPTY : v.toFixed(digits))
  return (
    <section className="pt-det" aria-label={tt('charts.pro.details')}>
      <div className="pt-det-hd">
        <SymbolLogo symbol={symbol} size={40} className="pt-ava lg" />
        <div className="pt-det-id">
          <b>{symbol || EMPTY}</b>
          {symbol && displaySymbol(symbol) !== symbol && <small>{displaySymbol(symbol)}</small>}
        </div>
        <span className={`pt-state ${state}`}>{tt(`charts.pro.state.${state}`)}</span>
      </div>
      <div className="pt-det-px">
        <span className={`pt-det-big ${down ? 'mute' : ''}`}>
          {parts ? <>{parts.base}<em>{parts.pip}</em>{parts.sup && <sup>{parts.sup}</sup>}</> : EMPTY}
        </span>
        <span className={`pt-chg lg ${chg == null ? '' : up ? 'up' : 'dn'}`}>{chg == null ? EMPTY : `${up ? '+' : ''}${(chg * 100).toFixed(2)}%`}</span>
      </div>
      <dl className="pt-det-grid">
        <div><dt>{tt('charts.symhead.bid')}</dt><dd className="dn">{f(bid)}</dd></div>
        <div><dt>{tt('charts.symhead.ask')}</dt><dd className="up">{f(ask)}</dd></div>
        <div><dt>{tt('charts.symhead.spread')}</dt><dd>{spread ?? EMPTY}</dd></div>
      </dl>
      <div className="pt-range" aria-label={tt('charts.pro.range')}>
        <div className="pt-range-lab"><span>{tt('charts.pro.range')}</span></div>
        <div className="pt-range-bar">
          <i style={pos == null ? { opacity: 0 } : { left: `${pos * 100}%` }} />
        </div>
        <div className="pt-range-ends"><span>{f(lo)}</span><span>{f(hi)}</span></div>
      </div>
      <ProSymbolMeta symbol={symbol} timezone={timezone} />
    </section>
  )
}

// ── 交易时段 + 合约规格（阶段 6）/ trading sessions + contract spec (phase 6) ──
// 时段按图表时区显示（服务器日的分钟数 + 服务器 UTC 偏移换过来）；拿不到（known=false）就一条横线。
// 规格只列有值的字段。两者每个品种只拉一次（symbolMeta.ts 缓存）。
// Sessions show in the chart timezone (server-day minutes shifted by the server's UTC offset); unknown
// (known=false) is a dash line. The spec lists only non-null fields. Both are fetched once per symbol.
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]
const num = (v: number | null | undefined) => (v == null ? null : String(+v.toPrecision(10)))
function ProSymbolMeta({ symbol, timezone }: { symbol: string; timezone: string }) {
  const { t, i18n } = useTranslation()
  const tt = (k: string, o?: Record<string, unknown>) => String(t(k, o))
  const { data: sess } = useSymbolSessions(symbol || null)
  const { data: spec } = useChartSpec(symbol || null)
  // 两段的展开 / 收起记在专业版偏好里（跨刷新、跟账户走）。onToggle 在 React 改 open 属性时也会触发，
  // 值相同就不写，偏好晚到时不会回写一遍。
  // Each section's open state lives in the pro prefs (survives reloads, follows the account). onToggle also
  // fires when React sets `open`, so an unchanged value is not written back when the prefs arrive late.
  const [proPrefs, updatePro] = useProPrefs()
  const onMetaToggle = (key: 'metaSess' | 'metaSpec') => (e: SyntheticEvent<HTMLDetailsElement>) => {
    const open = e.currentTarget.open
    if (open !== proPrefs[key]) updatePro({ [key]: open })
  }
  const offMin = Math.round(tzOffsetSec(timezone, Date.now() / 1000) / 60)
  const segs = useMemo(
    () => (sess?.known && sess.serverUtcOffsetSec != null ? convertSessions(sess.sessions, sess.serverUtcOffsetSec, offMin) : null),
    [sess, offMin],
  )
  const dayName = useMemo(() => {
    const f = new Intl.DateTimeFormat(i18n.language || 'zh', { weekday: 'short', timeZone: 'UTC' })
    // 1970-01-04 是周日 / 1970-01-04 was a Sunday
    return (d: number) => f.format(new Date(Date.UTC(1970, 0, 4 + d)))
  }, [i18n.language])
  const nextOpen = sess?.nextOpenAt ? Date.parse(sess.nextOpenAt) / 1000 : NaN
  const fmtAt = (ts: number) => {
    const w = new Date((ts + tzOffsetSec(timezone, ts)) * 1000)
    return `${dayName(w.getUTCDay())} ${fmtMin(w.getUTCHours() * 60 + w.getUTCMinutes())}`
  }
  const specRows: [string, string][] = []
  if (spec) {
    const push = (k: string, v: string | null) => { if (v != null && v !== '') specRows.push([k, v]) }
    push('contractSize', num(spec.contractSize))
    push('tickSize', num(spec.tickSize))
    push('tickValue', num(spec.tickValue))
    push('digits', num(spec.digits))
    if (spec.volumeMin != null || spec.volumeMax != null) push('volume', `${num(spec.volumeMin) ?? EMPTY} – ${num(spec.volumeMax) ?? EMPTY}`)
    push('volumeStep', num(spec.volumeStep))
    push('currencyBase', spec.currencyBase)
    push('currencyProfit', spec.currencyProfit)
    push('currencyMargin', spec.currencyMargin)
    push('description', spec.description)
  }
  if (!symbol) return null
  return (
    <>
      <details className="pt-meta" open={proPrefs.metaSess} onToggle={onMetaToggle('metaSess')}>
        <summary className="pt-meta-hd">
          <h3>{tt('charts.pro.meta.sessions')}</h3>
          {sess?.known && sess.openNow != null && (
            <span className={`pt-meta-st ${sess.openNow ? 'open' : 'closed'}`}>{tt(sess.openNow ? 'charts.pro.meta.open' : sess.holiday ? 'charts.pro.meta.holiday' : 'charts.pro.meta.closed')}</span>
          )}
        </summary>
        {!segs ? <p className="pt-meta-dim">{EMPTY}</p> : (
          <>
            {sess && sess.openNow === false && Number.isFinite(nextOpen) && (
              <p className="pt-meta-next">{tt('charts.pro.meta.nextOpen', { at: fmtAt(nextOpen) })}</p>
            )}
            <dl className="pt-meta-days">
              {WEEK_ORDER.map((d) => {
                const ds = segs.filter((x) => x.day === d)
                return (
                  <div key={d} className={ds.length ? undefined : 'off'}>
                    <dt>{dayName(d)}</dt>
                    <dd>{ds.length ? ds.map((x) => `${fmtMin(x.from)}–${x.to >= 1440 ? '24:00' : fmtMin(x.to)}`).join(', ') : tt('charts.pro.meta.closedDay')}</dd>
                  </div>
                )
              })}
            </dl>
          </>
        )}
      </details>
      <details className="pt-meta" open={proPrefs.metaSpec} onToggle={onMetaToggle('metaSpec')}>
        <summary className="pt-meta-hd"><h3>{tt('charts.pro.meta.spec')}</h3></summary>
        {specRows.length === 0 ? <p className="pt-meta-dim">{EMPTY}</p> : (
          <dl className="pt-meta-spec">
            {specRows.map(([k, v]) => <div key={k}><dt>{tt(`charts.pro.meta.${k}`)}</dt><dd>{v}</dd></div>)}
          </dl>
        )}
      </details>
    </>
  )
}

// ── 警报面板 / alerts panel ──
// 生效的排前面，然后是已停止 / 已触发 / 已过期；开关直接停 / 启（与管理器同一个接口）。
// 点一行打开编辑；顶上「新建」「全部管理」。
// Active first, then paused / fired / expired; the switch stops / resumes in place (same call
// as the manager). A row opens the editor; "New" and "Manage all" sit on top.
const RANK: Record<string, number> = { active: 0, paused: 1, fired: 2, expired: 3 }
export function ProAlerts({ symbol, bid, onNew, onEdit, onManage, onPickSymbol, onToast }: {
  symbol: string
  bid: () => number | null
  onNew: () => void
  onEdit: (a: ChartAlert) => void
  onManage: () => void
  onPickSymbol: (s: string) => void
  onToast: (msg: string, kind: 'error') => void
}) {
  const { t } = useTranslation()
  const tt = (k: string, o?: Record<string, unknown>) => String(t(k, o))
  const { alerts, loaded } = useChartAlerts()
  const [busy, setBusy] = useState<string | null>(null)
  const list = useMemo(() => [...alerts].sort((a, b) => (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9) || (a.createdAt < b.createdAt ? 1 : -1)), [alerts])
  const toggle = useCallback(async (a: ChartAlert, on: boolean) => {
    setBusy(a.id)
    try {
      await setAlertActive(a, on, a.symbol.toUpperCase() === symbol.toUpperCase() ? bid() : null)
    } catch (e) {
      onToast(e instanceof Error ? localizeApiError(e.message) : tt('charts.alert.err.save'), 'error')
    } finally {
      setBusy(null)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- tt follows the language
  }, [symbol, bid, onToast, t])
  const active = alerts.filter((a) => a.status === 'active').length

  return (
    <>
      <div className="pt-al-bar">
        <span>{tt('charts.pro.alertsActive', { n: active })}</span>
        <button type="button" className="pt-btn sm" onClick={onManage}>{tt('charts.pro.manage')}</button>
        <button type="button" className="pt-btn sm tint" onClick={onNew}><IcPlus size={14} />{tt('charts.pro.newAlert')}</button>
      </div>
      {!loaded ? (
        <div className="pt-al-skel" aria-hidden><i /><i /><i /></div>
      ) : list.length === 0 ? (
        <div className="pt-empty">
          <IcBell size={26} />
          <p>{tt('charts.pro.alertsEmpty')}</p>
          <small>{tt('charts.pro.alertsEmptyHint')}</small>
          <button type="button" className="pt-btn tint" onClick={onNew}><IcPlus size={14} />{tt('charts.pro.newAlert')}</button>
        </div>
      ) : (
        <ul className="pt-al-list no-sb">
          {list.map((a) => {
            const live = a.status === 'active' || a.status === 'paused'
            return (
              <li key={a.id} className={`pt-al s-${a.status}`}>
                <button type="button" className="pt-al-main" onClick={() => onEdit(a)}>
                  <span className="pt-al-top">
                    <span className="pt-al-sym" role="link" tabIndex={-1} onClick={(e) => { e.stopPropagation(); onPickSymbol(a.symbol) }}>{a.symbol}</span>
                    <span className={`pt-al-st s-${a.status}`}>{tt(`charts.alert.status.${a.status}`)}</span>
                  </span>
                  <span className="pt-al-msg">{a.message}</span>
                  <span className="pt-al-meta">{tt(`charts.alert.trig.${a.trigger}`)}{a.fireCount > 0 ? ` · ${tt('charts.pro.fired', { n: a.fireCount })}` : ''}</span>
                </button>
                {live && (
                  <Switch
                    checked={a.status === 'active'}
                    busy={busy === a.id}
                    onChange={(on) => { void toggle(a, on) }}
                    aria-label={tt(a.status === 'active' ? 'charts.alert.stop' : 'charts.alert.resume')}
                  />
                )}
              </li>
            )
          })}
        </ul>
      )}
    </>
  )
}
