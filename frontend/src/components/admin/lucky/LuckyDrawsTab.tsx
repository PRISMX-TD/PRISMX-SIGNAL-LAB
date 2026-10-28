// 抽奖记录 / 待发奖：mode=all 看当前选中那一期的抽奖记录（按状态筛选、导出 CSV）；mode=pending 是跨期的
// 待发奖队列（pending / submitted），每行带期名，可标「已发放」或「取消」。按概率模式抽中已抽完的格
// 记为「已抽完未中奖」。领奖期限由管理员自己掌握，这里不显示、不判断。
// Draws / pending tab: mode=all lists the selected round's draws (status filter, CSV export);
// mode=pending is the cross-round fulfilment queue (pending / submitted, each row names its round) with
// "mark delivered" and "cancel". A prob-mode hit on a sold-out slot shows as a sold-out miss. The claim
// deadline is the admin's call, so nothing here shows or enforces one.
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { adminApi } from '../../../api/client'
import type { LuckyAdminDraw, LuckyFulfillment } from '../../../api/luckyTypes'
import { fmtTime, localizeApiError } from '../../../api/utils'
import { PAGE, clampOffset, csvFileName, csvQuery, drawsQuery, parseNote, type DrawsStatus } from './luckyDraws'
import Copyable from '../../Copyable'

const STATUSES: LuckyFulfillment[] = ['auto_done', 'pending', 'submitted', 'delivered', 'cancelled']
// 要处理的是琥珀色，办完的是绿色，取消是红色，自动到账不着色。
// Needs action reads amber, done reads green, cancelled red; automatic payouts stay neutral.
const STATUS_PILL: Record<LuckyFulfillment, string> = {
  auto_done: '',
  pending: 'is-warn',
  submitted: 'is-info',
  delivered: 'is-up',
  cancelled: 'is-down',
}

export default function LuckyDrawsTab({ mode, roundId, onChange }: { mode: 'all' | 'pending'; roundId?: string; onChange: () => void }) {
  const { t } = useTranslation()
  const [status, setStatus] = useState<DrawsStatus>('')
  const [offset, setOffset] = useState(0)
  const [tick, setTick] = useState(0)
  const [data, setData] = useState<{ total: number; draws: LuckyAdminDraw[] }>({ total: 0, draws: [] })
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const seq = useRef(0)
  const errText = (e: unknown) => (e instanceof Error ? localizeApiError(e.message) : t('common.error'))

  // 筛选 / 翻页连点时，慢的旧响应不能盖掉新的：只认最后一次请求。
  // Rapid filter / page clicks must not let a slow old response overwrite a newer one.
  useEffect(() => {
    const mine = ++seq.current
    adminApi.luckyDraws(drawsQuery(mode, status, offset, roundId))
      .then((r) => {
        if (mine !== seq.current) return
        setData(r)
        // 处理完最后一条、当前页空了：退回有数据的最后一页 / the page emptied out: step back
        const fixed = clampOffset(offset, r.total)
        if (fixed !== offset) setOffset(fixed)
      })
      .catch((e) => { if (mine === seq.current) setMsg(errText(e)) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, status, offset, tick, roundId])

  const act = async (d: LuckyAdminDraw, kind: 'deliver' | 'cancel') => {
    if (busy) return
    const parsed = parseNote(kind, window.prompt(t(kind === 'deliver' ? 'admin.lucky.draws.note' : 'admin.lucky.draws.cancelReason')))
    if (parsed.kind === 'abort') return
    if (parsed.kind === 'empty') { setMsg(t('admin.lucky.draws.reasonRequired')); return }
    if (parsed.kind === 'long') { setMsg(t('admin.lucky.draws.noteLong')); return }
    setBusy(true); setMsg('')
    try {
      await (kind === 'deliver' ? adminApi.luckyDeliver(d.id, parsed.note) : adminApi.luckyCancel(d.id, parsed.note))
      setTick((n) => n + 1); onChange()
    } catch (e) { setMsg(errText(e)) } finally { setBusy(false) }
  }

  const exportCsv = async () => {
    if (busy) return
    setBusy(true); setMsg('')
    try {
      const q = csvQuery(mode, status, roundId)
      const blob = await adminApi.luckyDrawsCsv(q.status, q.roundId)
      const href = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = href; a.download = csvFileName(mode, status)
      document.body.appendChild(a); a.click(); a.remove()
      // 立即回收会让部分 WebView 取消下载 / revoking at once cancels the download in some WebViews
      window.setTimeout(() => URL.revokeObjectURL(href), 1000)
    } catch (e) { setMsg(errText(e)) } finally { setBusy(false) }
  }

  const cols = mode === 'pending' ? ['time', 'round', 'user', 'prize', 'status', 'claim'] : ['time', 'user', 'prize', 'status', 'claim']
  return (
    <section className="lka-draws space-y-3">
      <div className="adm-toolbar">
        {mode === 'all' && (
          <label className="adm-filter">
            <span>{t('admin.lucky.draws.status')}</span>
            <select className="input w-auto" value={status} aria-label={t('admin.lucky.draws.status')}
              onChange={(e) => { setOffset(0); setMsg(''); setStatus(e.target.value as DrawsStatus) }}>
              <option value="">{t('admin.lucky.draws.all')}</option>
              {STATUSES.map((s) => <option key={s} value={s}>{t(`lucky.status.${s}`)}</option>)}
            </select>
          </label>
        )}
        <div className="adm-toolbar-end">
          <span className="adm-count num">{t('admin.lucky.draws.total', { n: data.total })}</span>
          <button type="button" className="adm-btn" disabled={busy} onClick={exportCsv}>{t('admin.lucky.draws.export')}</button>
        </div>
      </div>
      {msg && <p className="lka-note is-down" role="alert">{msg}</p>}
      {data.draws.length === 0 ? (
        <div className="adm-card adm-empty"><p className="adm-empty-title">{t('admin.lucky.draws.empty')}</p></div>
      ) : (
        <div className="adm-table-wrap">
          <table className="adm-table">
            <thead>
              <tr>
                {cols.map((k) => <th key={k}>{t(`admin.lucky.draws.${k}`)}</th>)}
                {mode === 'pending' && <th><span className="sr-only">{t('admin.lucky.draws.deliver')}</span></th>}
              </tr>
            </thead>
            <tbody>
              {data.draws.map((d) => (
                <tr key={d.id}>
                  <td className="num whitespace-nowrap text-xs text-neutral-400">{fmtTime(d.createdAt)}</td>
                  {mode === 'pending' && <td className="max-w-[10rem] break-words text-xs text-neutral-300">{d.roundName}</td>}
                  <td className="lka-cell-user"><b>{d.user.nickname ? <Copyable text={d.user.nickname} label={t('supportDesk.copy.nickname')} /> : '—'}</b><span><Copyable text={d.user.email} label={t('supportDesk.copy.email')} /></span></td>
                  <td className="min-w-[7rem] text-neutral-200">{d.prize.name}</td>
                  <td className="whitespace-nowrap">
                    {d.soldOut
                      ? <span className="adm-pill is-warn">{t('admin.lucky.draws.soldOut')}</span>
                      : <span className={`adm-pill ${STATUS_PILL[d.fulfillmentStatus] ?? ''}`}>{t(`lucky.status.${d.fulfillmentStatus}`)}</span>}
                  </td>
                  <td className="min-w-[10rem] text-xs text-neutral-300">
                    {d.claimInfo && <div className="whitespace-pre-wrap break-words">{d.claimInfo}</div>}
                    {d.supportTicketId && (
                      // 用 Link 而不是 <a href>：Capacitor App 里整页刷新会丢状态
                      // Link, not a raw anchor: a full reload loses state in the Capacitor app
                      <Link className="adm-link-btn" to={`/admin/tickets?ticket=${encodeURIComponent(d.supportTicketId)}`}>
                        {t('admin.lucky.draws.openTicket')}</Link>
                    )}
                    {d.adminNote && <div className="mt-1 break-words text-neutral-500">{d.adminNote}</div>}
                  </td>
                  {mode === 'pending' && (
                    <td className="whitespace-nowrap text-right">
                      <div className="inline-flex gap-1.5">
                        <button type="button" className="adm-btn" disabled={busy} onClick={() => act(d, 'deliver')}>
                          {t('admin.lucky.draws.deliver')}</button>
                        <button type="button" className="adm-btn is-danger" disabled={busy} onClick={() => act(d, 'cancel')}>
                          {t('admin.lucky.draws.cancel')}</button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data.total > PAGE && (
        <div className="lka-pager">
          <button type="button" className="adm-icon-btn" disabled={offset === 0} aria-label={t('admin.lucky.draws.prev')}
            title={t('admin.lucky.draws.prev')} onClick={() => setOffset(Math.max(0, offset - PAGE))}><Chevron left /></button>
          <span className="adm-count num">{offset + 1}–{Math.min(offset + PAGE, data.total)}</span>
          <button type="button" className="adm-icon-btn" disabled={offset + PAGE >= data.total} aria-label={t('admin.lucky.draws.next')}
            title={t('admin.lucky.draws.next')} onClick={() => setOffset(offset + PAGE)}><Chevron /></button>
        </div>
      )}
    </section>
  )
}

function Chevron({ left = false }: { left?: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round"
      strokeLinejoin="round" aria-hidden>
      <path d={left ? 'M15 6l-6 6 6 6' : 'M9 6l6 6-6 6'} />
    </svg>
  )
}
