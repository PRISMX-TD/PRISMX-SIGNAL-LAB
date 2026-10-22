// 显示开关 + 本期时间（新建 / 修改 / 立即结束）+ 奖项编辑表（左）与实时预览（右）。
// 概率合计不等于 100% 时保存键禁用；改结束时间到过去 = 立即结束，先二次确认。
// 时间：后端是不带 Z 的 naive UTC，输入框是管理员浏览器本地时区；输入框旁另用 fmtTime 显示
// 用户端看到的时间（站点按 UTC+8 显示），两边对得上才不会设错期。
// Visible switch + this round's window (create / edit / end now) + the prize editor (left) and a live
// preview (right). Save is disabled unless the odds total 100%; moving the end into the past ends the
// round, which is confirmed first. Times: the API is naive UTC (no Z) while the inputs are in the
// admin's browser zone; fmtTime next to them shows what users will see (the site shows UTC+8).
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { adminApi } from '../../../api/client'
import type { LuckyAdminConfig, LuckyPrizeKind } from '../../../api/luckyTypes'
import { fmtTime, localizeApiError, parseTime } from '../../../api/utils'
import LuckyWheel from '../../lucky/LuckyWheel'
import ImageField from '../ImageField'
import { autoColor, blankRow, fromAdmin, problems, toInput, totalPct, type PrizeRow } from './prizeForm'

// API 字符串（naive UTC）→ datetime-local 值（浏览器本地时区）。必须经 parseTime 补 Z，直接 new Date 会按本地时间解析。
// API string (naive UTC) -> datetime-local value (browser-local). Goes through parseTime, which adds
// the missing Z; a bare new Date(iso) would read it as local time.
const toLocalInput = (iso?: string) => {
  const d = parseTime(iso)
  if (!d || Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}
const fromLocalInput = (v: string) => new Date(v).toISOString()
// 输入框当前值在站点时区下的样子；空或非法返回空串。
// The input's value as the site shows it; '' if empty or invalid.
const shown = (v: string) => (v && !Number.isNaN(new Date(v).getTime()) ? fmtTime(fromLocalInput(v)) : '')

export default function LuckySettingsTab({ cfg, onChange, onDirty }: {
  cfg: LuckyAdminConfig
  onChange: (c: LuckyAdminConfig) => void
  // 奖项表有未保存的改动时通知外壳，外壳切页签前据此确认。/ Tells the shell about unsaved prize edits so it can confirm before a tab switch.
  onDirty?: (dirty: boolean) => void
}) {
  const { t } = useTranslation()
  const [rows, setRows] = useState<PrizeRow[]>(() => cfg.prizes.map(fromAdmin))
  const [start, setStart] = useState(toLocalInput(cfg.round?.startsAt))
  const [end, setEnd] = useState(toLocalInput(cfg.round?.endsAt))
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [dirty, setDirty] = useState(false)
  const probs = problems(rows)
  const preview = useMemo(() => rows.map((r) => ({
    id: r.key, name: r.name || '—', description: null, imageUrl: r.imageUrl || null,
    color: r.color || null, kind: r.kind, proDays: Number(r.proDays) || null,
  })), [rows])
  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setMsg('')
    try { await fn() } catch (e) { setMsg(e instanceof Error ? localizeApiError(e.message) : t('common.error')) } finally { setBusy(false) }
  }
  // 所有对奖项表的改动都走 edit，顺手标脏。/ Every edit to the prize table goes through `edit`, which marks it dirty.
  const edit = (fn: (xs: PrizeRow[]) => PrizeRow[]) => { setRows(fn); setDirty(true) }
  const patch = (key: string, p: Partial<PrizeRow>) => edit((xs) => xs.map((r) => (r.key === key ? { ...r, ...p } : r)))
  const round = cfg.round
  useEffect(() => {
    onDirty?.(dirty)
    return () => onDirty?.(false)
  }, [dirty, onDirty])
  // 期被结束 / 新建 / 改时间后，输入框跟着服务器值走；期没了就清空，不留旧窗口。
  // Re-sync the window inputs whenever the round changes server-side; with no round they clear
  // instead of keeping the old window.
  useEffect(() => {
    setStart(toLocalInput(round?.startsAt))
    setEnd(toLocalInput(round?.endsAt))
  }, [round?.id, round?.startsAt, round?.endsAt])

  return (
    <div className="space-y-4">
      <section className="card flex flex-wrap items-end gap-4 p-4">
        <label className="flex items-center gap-2 text-sm text-neutral-200">
          <input type="checkbox" checked={cfg.visible} disabled={busy}
            onChange={(e) => run(async () => onChange(await adminApi.luckySetVisible(e.target.checked)))} />
          {t('admin.lucky.visible')}
        </label>
        <label className="block"><span className="mb-1 block text-xs text-neutral-400">{t('admin.lucky.startsAt')}</span>
          <input type="datetime-local" className="input py-1.5 text-sm" value={start}
            disabled={!!round && round.phase !== 'upcoming'} onChange={(e) => setStart(e.target.value)} />
          {shown(start) && <span className="mt-1 block text-[11px] text-neutral-500">{t('admin.lucky.userSees', { time: shown(start) })}</span>}</label>
        <label className="block"><span className="mb-1 block text-xs text-neutral-400">{t('admin.lucky.endsAt')}</span>
          <input type="datetime-local" className="input py-1.5 text-sm" value={end} onChange={(e) => setEnd(e.target.value)} />
          {shown(end) && <span className="mt-1 block text-[11px] text-neutral-500">{t('admin.lucky.userSees', { time: shown(end) })}</span>}</label>
        {!round ? (
          <button type="button" className="btn-primary px-3 py-1.5 text-sm" disabled={busy || !shown(start) || !shown(end)}
            onClick={() => run(async () => { await adminApi.luckyCreateRound(fromLocalInput(start), fromLocalInput(end)); onChange(await adminApi.luckyConfig()) })}>
            {t('admin.lucky.createRound')}</button>
        ) : (
          <>
            <button type="button" className="btn-primary px-3 py-1.5 text-sm" disabled={busy || !shown(end)}
              onClick={() => run(async () => {
                if (new Date(end).getTime() <= Date.now() && !window.confirm(t('admin.lucky.confirmEnd'))) return
                const r = await adminApi.luckyUpdateRound({ ...(round.phase === 'upcoming' && shown(start) ? { startsAt: fromLocalInput(start) } : {}), endsAt: fromLocalInput(end) })
                if (r.voided) setMsg(t('admin.lucky.voided', { n: r.voided }))
                onChange(await adminApi.luckyConfig())
              })}>{t('admin.lucky.saveRound')}</button>
            <button type="button" className="btn-ghost px-3 py-1.5 text-sm text-down" disabled={busy}
              onClick={() => run(async () => {
                if (!window.confirm(t('admin.lucky.confirmEnd'))) return
                const r = await adminApi.luckyEndRound()
                setMsg(t('admin.lucky.voided', { n: r.voided }))
                onChange(await adminApi.luckyConfig())
              })}>{t('admin.lucky.endNow')}</button>
          </>
        )}
        <span className="text-xs text-neutral-500">{round ? t(`admin.lucky.phase.${round.phase}`) : t('admin.lucky.noRound')}</span>
      </section>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <section className="card min-w-0 space-y-3 p-4">
          {rows.map((r, i) => (
            <div key={r.key} className="space-y-2 rounded-lg bg-white/5 p-3">
              <div className="flex flex-wrap items-end gap-2">
                <span className="w-6 text-xs text-neutral-500">{i + 1}</span>
                <input className="input min-w-0 flex-1 basis-32 py-1.5 text-sm sm:w-40 sm:flex-none" placeholder={t('admin.lucky.name')} maxLength={40}
                  value={r.name} onChange={(e) => patch(r.key, { name: e.target.value })} />
                <select className="input py-1.5 text-sm" value={r.kind}
                  onChange={(e) => patch(r.key, { kind: e.target.value as LuckyPrizeKind })}>
                  {(['pro_days', 'custom', 'retry', 'none'] as LuckyPrizeKind[]).map((k) =>
                    <option key={k} value={k}>{t(`admin.lucky.kind.${k}`)}</option>)}
                </select>
                {r.kind === 'pro_days' && <input className="input w-20 py-1.5 text-sm" inputMode="numeric"
                  placeholder={t('admin.lucky.days')} value={r.proDays} onChange={(e) => patch(r.key, { proDays: e.target.value })} />}
                <label className="flex items-center gap-1 text-xs text-neutral-400">
                  <input className="input w-20 py-1.5 text-sm" inputMode="decimal" value={r.probPct}
                    onChange={(e) => patch(r.key, { probPct: e.target.value })} />%</label>
                <input className="input w-20 py-1.5 text-sm" inputMode="numeric" placeholder={t('admin.lucky.stock')}
                  value={r.stock} onChange={(e) => patch(r.key, { stock: e.target.value })} />
                <input className="input w-20 py-1.5 text-sm" inputMode="numeric" placeholder={t('admin.lucky.perUser')}
                  value={r.perUserLimit} onChange={(e) => patch(r.key, { perUserLimit: e.target.value })} />
                {(r.stock !== '' || r.perUserLimit !== '') && (
                  <select className="input min-w-0 max-w-full py-1.5 text-sm" value={r.onSoldOut}
                    onChange={(e) => patch(r.key, { onSoldOut: e.target.value as PrizeRow['onSoldOut'] })}>
                    <option value="to_fallback">{t('admin.lucky.soldOut.to_fallback')}</option>
                    <option value="redistribute">{t('admin.lucky.soldOut.redistribute')}</option>
                  </select>
                )}
                <span className="flex items-center gap-1" title={r.color ? undefined : t('admin.lucky.colorAuto')}>
                  <input type="color" className={`h-8 w-8 rounded bg-transparent ${r.color ? '' : 'opacity-60'}`} value={r.color || autoColor(i)}
                    aria-label={t('admin.lucky.color')} onChange={(e) => patch(r.key, { color: e.target.value })} />
                  {r.color
                    ? <button type="button" className="text-[11px] text-neutral-400 hover:text-neutral-200" onClick={() => patch(r.key, { color: '' })}>{t('admin.lucky.colorReset')}</button>
                    : <span className="text-[11px] text-neutral-500">{t('admin.lucky.colorAuto')}</span>}
                </span>
                <button type="button" className="btn-ghost px-2 py-1 text-xs" disabled={i === 0}
                  onClick={() => edit((xs) => { const c = [...xs]; [c[i - 1], c[i]] = [c[i], c[i - 1]]; return c })}>↑</button>
                <button type="button" className="rounded px-2 py-1 text-xs text-down hover:bg-white/10"
                  onClick={() => edit((xs) => xs.filter((x) => x.key !== r.key))}>{t('admin.lucky.remove')}</button>
              </div>
              {r.kind === 'custom' && (
                <div className="flex flex-wrap items-start gap-2 sm:pl-8">
                  <select className="input min-w-0 max-w-full py-1.5 text-sm" value={r.claimMode}
                    onChange={(e) => patch(r.key, { claimMode: e.target.value as PrizeRow['claimMode'] })}>
                    <option value="">{t('admin.lucky.claimMode.pick')}</option>
                    <option value="form">{t('admin.lucky.claimMode.form')}</option>
                    <option value="ticket">{t('admin.lucky.claimMode.ticket')}</option>
                  </select>
                  {r.claimMode === 'form' && <input className="input min-w-0 flex-1 basis-48 py-1.5 text-sm sm:max-w-sm" maxLength={200}
                    placeholder={t('admin.lucky.claimHint')} value={r.claimHint} onChange={(e) => patch(r.key, { claimHint: e.target.value })} />}
                </div>
              )}
              <div className="flex flex-wrap items-start gap-2 sm:pl-8">
                <input className="input min-w-0 flex-1 basis-48 py-1.5 text-sm sm:max-w-sm" maxLength={300} placeholder={t('admin.lucky.description')}
                  value={r.description} onChange={(e) => patch(r.key, { description: e.target.value })} />
                <div className="min-w-0 max-w-full"><ImageField compact value={r.imageUrl} onChange={(url) => patch(r.key, { imageUrl: url })} /></div>
                {r.stockUsed > 0 && <span className="text-xs text-neutral-500">{t('admin.lucky.given', { n: r.stockUsed })}</span>}
              </div>
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className="btn-ghost px-3 py-1 text-xs" disabled={rows.length >= 12}
              onClick={() => edit((xs) => [...xs, blankRow('custom')])}>{t('admin.lucky.addSlot')}</button>
            <span className={`text-xs ${totalPct(rows) === 100 ? 'text-neutral-400' : 'text-down'}`}>
              {t('admin.lucky.total', { n: totalPct(rows) })}</span>
            {probs.map((k) => <span key={k} className="text-xs text-amber-300">{t(k)}</span>)}
            <button type="button" className="btn-primary ml-auto px-3 py-1.5 text-sm disabled:opacity-40"
              disabled={busy || probs.length > 0}
              onClick={() => run(async () => { const c = await adminApi.luckySavePrizes(toInput(rows)); setRows(c.prizes.map(fromAdmin)); setDirty(false); onChange(c); setMsg(t('admin.lucky.saved')) })}>
              {t('admin.lucky.savePrizes')}</button>
          </div>
          {msg && <p className="text-xs text-neutral-300">{msg}</p>}
        </section>
        <section className="card p-4"><LuckyWheel prizes={preview} rotation={0} spinning={false} /></section>
      </div>
    </div>
  )
}
