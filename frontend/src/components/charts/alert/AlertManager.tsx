// 警报管理器：全部品种的警报列表（状态、停止 / 恢复、编辑、克隆、删除，一键清理已停止的）
// 与触发记录（最近 300 条，可清空）。点品种名切到那个品种。
// The alert manager: every symbol's alerts (status, stop / resume, edit, clone, delete, bulk
// clean-up of stopped ones) and the fire log (latest 300, clearable). Clicking a symbol
// switches the chart to it.
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { chartApi } from '../../../api/client'
import type { ChartAlert, ChartAlertLogItem } from '../../../api/types'
import { localizeApiError } from '../../../api/utils'
import { onChartAlertFired } from '../../../utils/chartAlertEvents'
import ChartDialog from '../ChartDialog'
import { intervalLabel } from '../intervals'
import { deleteAlerts, setAlertActive, useChartAlerts } from './alertStore'
import { ALERTS_MAX, closeBased } from './model'

interface Props {
  symbol: string
  bid: () => number | null
  onNew: () => void
  onEdit: (a: ChartAlert, clone: boolean) => void
  onPickSymbol: (s: string) => void
  onToast: (text: string, kind: 'success' | 'error' | 'info') => void
  onClose: () => void
}

const STATUS_ORDER = { active: 0, paused: 1, fired: 2, expired: 3 } as const

function fmtTime(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return '—'
  return d.toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export default function AlertManager({ symbol, bid, onNew, onEdit, onPickSymbol, onToast, onClose }: Props) {
  const { t } = useTranslation()
  const tt = (k: string, o?: Record<string, unknown>) => String(t(k, o))
  const { alerts, loaded } = useChartAlerts()
  const [tab, setTab] = useState<'list' | 'log'>('list')
  const [onlyThis, setOnlyThis] = useState(false)
  const [log, setLog] = useState<ChartAlertLogItem[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [confirmDel, setConfirmDel] = useState<string | null>(null)

  const loadLog = () => { chartApi.alertLog(300).then((r) => setLog(r.log)).catch(() => setLog([])) }
  useEffect(() => { if (tab === 'log') loadLog() }, [tab])
  // 记录页开着时有新触发就刷新 / refresh the log tab on a new fire
  useEffect(() => (tab === 'log' ? onChartAlertFired(() => loadLog()) : undefined), [tab])

  const rows = useMemo(() => {
    const sym = symbol.toUpperCase()
    return alerts
      .filter((a) => !onlyThis || a.symbol.toUpperCase() === sym)
      .slice()
      .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.createdAt.localeCompare(a.createdAt))
  }, [alerts, onlyThis, symbol])
  const stopped = alerts.filter((a) => a.status !== 'active' && a.status !== 'paused')
  const active = alerts.filter((a) => a.status === 'active').length

  const run = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id)
    try { await fn() } catch (e) { onToast(e instanceof Error ? localizeApiError(e.message) : tt('charts.alert.err.save'), 'error') } finally { setBusy(null) }
  }
  const toggle = (a: ChartAlert) => run(a.id, () => setAlertActive(a, a.status !== 'active', a.symbol.toUpperCase() === symbol.toUpperCase() ? bid() : null))
  const remove = (a: ChartAlert) => {
    if (confirmDel !== a.id) { setConfirmDel(a.id); return }
    setConfirmDel(null)
    void run(a.id, () => deleteAlerts([a.id]))
  }

  return (
    <ChartDialog title={tt('charts.alert.manager')} onClose={onClose} wide className="alert-mgr"
      footer={tab === 'list' ? <>
        <span className="alert-count">{tt('charts.alert.count', { n: alerts.length, max: ALERTS_MAX, active })}</span>
        {stopped.length > 0 && <button type="button" className="ind-btn" onClick={() => void run('bulk', () => deleteAlerts(stopped.map((a) => a.id)))}>{tt('charts.alert.clearStopped', { n: stopped.length })}</button>}
        <button type="button" className="ind-btn primary" onClick={onNew}>{tt('charts.alert.new')}</button>
      </> : <>
        <span className="alert-count">{tt('charts.alert.logCount', { n: log?.length ?? 0 })}</span>
        {log && log.length > 0 && <button type="button" className="ind-btn" style={{ marginLeft: 'auto' }} onClick={() => { void chartApi.clearAlertLog().then(() => setLog([])).catch(() => {}) }}>{tt('charts.alert.clearLog')}</button>}
      </>}
    >
      <div className="alert-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'list'} className={tab === 'list' ? 'on' : ''} onClick={() => setTab('list')}>{tt('charts.alert.tabList')}</button>
        <button type="button" role="tab" aria-selected={tab === 'log'} className={tab === 'log' ? 'on' : ''} onClick={() => setTab('log')}>{tt('charts.alert.tabLog')}</button>
        {tab === 'list' && (
          <label className="alert-chk alert-only"><input type="checkbox" checked={onlyThis} onChange={(e) => setOnlyThis(e.target.checked)} />{tt('charts.alert.onlyThis', { symbol })}</label>
        )}
      </div>

      {tab === 'list' && (
        !loaded ? <p className="alert-empty">{tt('common.loading')}</p>
          : rows.length === 0 ? (
            <div className="alert-empty">
              <p>{tt('charts.alert.empty')}</p>
              <small>{tt('charts.alert.emptyHint')}</small>
            </div>
          ) : (
            <ul className="alert-list">
              {rows.map((a) => (
                <li key={a.id} className={`alert-item s-${a.status}`}>
                  <div className="alert-main">
                    <div className="alert-top">
                      <button type="button" className="alert-sym" onClick={() => { onPickSymbol(a.symbol); onClose() }}>{a.symbol}</button>
                      <span className={`alert-st s-${a.status}`}>{tt(`charts.alert.status.${a.status}`)}</span>
                    </div>
                    <p className="alert-msg-line">{a.message}</p>
                    <small className="alert-meta">
                      {tt(`charts.alert.trig.${a.trigger}`)}
                      {(a.trigger !== 'once' || closeBased(a.kind, a.cond)) && ` · ${intervalLabel(a.interval)}`}
                      {a.fireCount > 0 && ` · ${tt('charts.alert.fired', { n: a.fireCount, at: fmtTime(a.lastFiredAt) })}`}
                      {a.expiresAt && ` · ${tt('charts.alert.until', { at: fmtTime(a.expiresAt) })}`}
                    </small>
                  </div>
                  <div className="alert-acts">
                    <button type="button" className="alert-act" disabled={busy === a.id} onClick={() => void toggle(a)}
                      title={tt(a.status === 'active' ? 'charts.alert.stop' : 'charts.alert.resume')} aria-label={tt(a.status === 'active' ? 'charts.alert.stop' : 'charts.alert.resume')}>
                      {a.status === 'active'
                        ? <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
                        : <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M7 5l12 7-12 7z" /></svg>}
                    </button>
                    <button type="button" className="alert-act" onClick={() => onEdit(a, false)} title={tt('charts.alert.edit')} aria-label={tt('charts.alert.edit')}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4 20h4L19 9l-4-4L4 16z" /></svg>
                    </button>
                    <button type="button" className="alert-act" onClick={() => onEdit(a, true)} title={tt('charts.alert.clone')} aria-label={tt('charts.alert.clone')}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><rect x="8" y="8" width="13" height="13" rx="2" /><path d="M16 8V5a2 2 0 00-2-2H5a2 2 0 00-2 2v9a2 2 0 002 2h3" /></svg>
                    </button>
                    <button type="button" className={`alert-act del ${confirmDel === a.id ? 'confirm' : ''}`} disabled={busy === a.id} onClick={() => remove(a)}
                      onBlur={() => setConfirmDel((v) => (v === a.id ? null : v))}
                      title={tt(confirmDel === a.id ? 'charts.alert.confirmDelete' : 'charts.alert.delete')} aria-label={tt(confirmDel === a.id ? 'charts.alert.confirmDelete' : 'charts.alert.delete')}>
                      {confirmDel === a.id ? <small>{tt('charts.alert.confirmDelete')}</small>
                        : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></svg>}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )
      )}

      {tab === 'log' && (
        log == null ? <p className="alert-empty">{tt('common.loading')}</p>
          : log.length === 0 ? <div className="alert-empty"><p>{tt('charts.alert.logEmpty')}</p></div>
            : (
              <ul className="alert-list log">
                {log.map((l) => (
                  <li key={l.id} className="alert-item">
                    <div className="alert-main">
                      <div className="alert-top">
                        <button type="button" className="alert-sym" onClick={() => { onPickSymbol(l.symbol); onClose() }}>{l.symbol}</button>
                        <time className="alert-time">{fmtTime(l.firedAt)}</time>
                      </div>
                      <p className="alert-msg-line">{l.message}</p>
                    </div>
                    {l.price != null && <span className="alert-price">{l.price}</span>}
                  </li>
                ))}
              </ul>
            )
      )}
    </ChartDialog>
  )
}
