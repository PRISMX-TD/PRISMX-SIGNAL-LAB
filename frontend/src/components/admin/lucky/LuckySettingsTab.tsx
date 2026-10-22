// 一期的「奖品设置」（v2）：顶部模式切换（按份量 / 按概率；这一期已有抽奖记录就锁住），
// 格子编辑表（左）与实时预览（右）。按份量：每格「份数」必填；按概率：每格「概率 %」必填 + 「份数上限」可空，
// 合计不等于 100% 时保存键禁用。已结束的期只读。外壳按 round.id 做 key，换期即重载。
// One round's prize settings (v2): a mode switch at the top (qty / prob; locked once the round has
// draws), the slot editor (left) and a live preview (right). qty needs a stock per slot; prob needs a
// percentage per slot plus an optional stock cap, and Save stays disabled unless the odds total 100%.
// An ended round is read-only. The shell keys this by round.id, so switching rounds reloads.
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { adminApi } from '../../../api/client'
import type { LuckyMode, LuckyPrizeKind, LuckyRoundAdmin } from '../../../api/luckyTypes'
import { localizeApiError } from '../../../api/utils'
import LuckyWheel from '../../lucky/LuckyWheel'
import ImageField from '../ImageField'
import { autoColor, blankRow, fromAdmin, problems, toInput, totalPct, totalQty, type PrizeRow } from './prizeForm'

const MODES: LuckyMode[] = ['qty', 'prob']

export default function LuckySettingsTab({ round, onSaved, onDirty }: {
  round: LuckyRoundAdmin
  onSaved: (r: LuckyRoundAdmin) => void
  // 奖项表有未保存的改动时通知外壳，外壳切页签 / 换期前据此确认。
  // Tells the shell about unsaved prize edits so it can confirm before a tab or round switch.
  onDirty?: (dirty: boolean) => void
}) {
  const { t } = useTranslation()
  const [rows, setRows] = useState<PrizeRow[] | null>(null)
  const [mode, setMode] = useState<LuckyMode>(round.mode)
  // 抽奖记录数以详情接口为准（列表可能稍旧）/ the draw count from the detail call (the list may be a bit stale)
  const [draws, setDraws] = useState(round.stats.draws)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [dirty, setDirty] = useState(false)
  const ended = round.phase === 'ended'
  const modeLocked = draws > 0 || ended

  useEffect(() => {
    let live = true
    adminApi.luckyRound(round.id).then((d) => {
      if (!live) return
      setMode(d.round.mode)
      setDraws(d.round.stats.draws)
      // 新的一期还没有奖品：先放两格空白，省得从零点「添加」/ a fresh round starts with two blank slots
      setRows(d.prizes.length ? d.prizes.map(fromAdmin) : [blankRow('pro_days'), blankRow('none')])
    }).catch((e) => { if (live) setMsg(e instanceof Error ? localizeApiError(e.message) : t('common.error')) })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [round.id])

  useEffect(() => {
    onDirty?.(dirty)
    return () => onDirty?.(false)
  }, [dirty, onDirty])

  const list = rows ?? []
  const probs = problems(list, mode)
  const preview = useMemo(() => list.map((r) => ({
    id: r.key, name: r.name || '—', description: null, imageUrl: r.imageUrl || null,
    color: r.color || null, kind: r.kind, proDays: Number(r.proDays) || null,
  })), [list])
  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setMsg('')
    try { await fn() } catch (e) { setMsg(e instanceof Error ? localizeApiError(e.message) : t('common.error')) } finally { setBusy(false) }
  }
  // 所有对奖项表的改动都走 edit，顺手标脏。/ Every edit to the prize table goes through `edit`, which marks it dirty.
  const edit = (fn: (xs: PrizeRow[]) => PrizeRow[]) => { setRows((xs) => fn(xs ?? [])); setDirty(true) }
  const patch = (key: string, p: Partial<PrizeRow>) => edit((xs) => xs.map((r) => (r.key === key ? { ...r, ...p } : r)))

  if (!rows) return <div className="card p-6 text-sm text-neutral-500">{msg || t('common.loading')}</div>

  return (
    <div className="space-y-4">
      <section className="card space-y-2 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs text-neutral-400">{t('admin.lucky.mode.label')}</span>
          <div className="seg-tabs" role="radiogroup" aria-label={t('admin.lucky.mode.label')}>
            {MODES.map((m) => (
              <button key={m} type="button" role="radio" aria-checked={mode === m} className={mode === m ? 'on' : ''}
                disabled={modeLocked && mode !== m} onClick={() => { if (mode !== m) { setMode(m); setDirty(true) } }}>
                {t(`admin.lucky.mode.${m}`)}</button>
            ))}
          </div>
        </div>
        <p className="text-xs text-neutral-500">{t(`admin.lucky.mode.${mode}Hint`)}</p>
        {draws > 0 && !ended && <p className="text-xs text-amber-300">{t('admin.lucky.mode.locked')}</p>}
        {ended && <p className="text-xs text-amber-300">{t('admin.lucky.endedReadOnly')}</p>}
      </section>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <section className="card min-w-0 space-y-3 p-4">
          {rows.map((r, i) => (
            <div key={r.key} className="space-y-2 rounded-lg bg-white/5 p-3">
              <div className="flex flex-wrap items-end gap-2">
                <span className="w-6 text-xs text-neutral-500">{i + 1}</span>
                <input className="input min-w-0 flex-1 basis-32 py-1.5 text-sm sm:w-40 sm:flex-none" placeholder={t('admin.lucky.name')} maxLength={40}
                  aria-label={t('admin.lucky.name')} value={r.name} onChange={(e) => patch(r.key, { name: e.target.value })} />
                <select className="input py-1.5 text-sm" value={r.kind} aria-label={t('admin.lucky.kindLabel')}
                  onChange={(e) => patch(r.key, { kind: e.target.value as LuckyPrizeKind })}>
                  {(['pro_days', 'custom', 'retry', 'none'] as LuckyPrizeKind[]).map((k) =>
                    <option key={k} value={k}>{t(`admin.lucky.kind.${k}`)}</option>)}
                </select>
                {r.kind === 'pro_days' && <input className="input w-20 py-1.5 text-sm" inputMode="numeric" aria-label={t('admin.lucky.days')}
                  placeholder={t('admin.lucky.days')} value={r.proDays} onChange={(e) => patch(r.key, { proDays: e.target.value })} />}
                {mode === 'qty' ? (
                  <label className="flex items-center gap-1 text-xs text-neutral-400">
                    {t('admin.lucky.stockQty')}
                    <input className="input w-20 py-1.5 text-sm" inputMode="numeric" value={r.stock}
                      onChange={(e) => patch(r.key, { stock: e.target.value })} />
                  </label>
                ) : (
                  <>
                    <label className="flex items-center gap-1 text-xs text-neutral-400">
                      <input className="input w-20 py-1.5 text-sm" inputMode="decimal" aria-label={t('admin.lucky.prob')} value={r.probPct}
                        onChange={(e) => patch(r.key, { probPct: e.target.value })} />%</label>
                    <input className="input w-28 py-1.5 text-sm" inputMode="numeric" placeholder={t('admin.lucky.stockCap')}
                      aria-label={t('admin.lucky.stockCap')} value={r.stock} onChange={(e) => patch(r.key, { stock: e.target.value })} />
                  </>
                )}
                {r.stockUsed > 0 && <span className="text-xs text-neutral-500">{t('admin.lucky.given', { n: r.stockUsed })}</span>}
                <span className="flex items-center gap-1" title={r.color ? undefined : t('admin.lucky.colorAuto')}>
                  <input type="color" className={`h-8 w-8 rounded bg-transparent ${r.color ? '' : 'opacity-60'}`} value={r.color || autoColor(i)}
                    aria-label={t('admin.lucky.color')} onChange={(e) => patch(r.key, { color: e.target.value })} />
                  {r.color
                    ? <button type="button" className="text-[11px] text-neutral-400 hover:text-neutral-200" onClick={() => patch(r.key, { color: '' })}>{t('admin.lucky.colorReset')}</button>
                    : <span className="text-[11px] text-neutral-500">{t('admin.lucky.colorAuto')}</span>}
                </span>
                <button type="button" className="btn-ghost px-2 py-1 text-xs" disabled={i === 0} aria-label={t('admin.lucky.moveUp')}
                  onClick={() => edit((xs) => { const c = [...xs]; [c[i - 1], c[i]] = [c[i], c[i - 1]]; return c })}>↑</button>
                <button type="button" className="rounded px-2 py-1 text-xs text-down hover:bg-white/10"
                  onClick={() => edit((xs) => xs.filter((x) => x.key !== r.key))}>{t('admin.lucky.remove')}</button>
              </div>
              {r.kind === 'custom' && (
                <div className="flex flex-wrap items-start gap-2 sm:pl-8">
                  <select className="input min-w-0 max-w-full py-1.5 text-sm" value={r.claimMode} aria-label={t('admin.lucky.claimMode.pick')}
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
              </div>
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className="btn-ghost px-3 py-1 text-xs" disabled={rows.length >= 12}
              onClick={() => edit((xs) => [...xs, blankRow('custom')])}>{t('admin.lucky.addSlot')}</button>
            {mode === 'qty' ? (
              <span className="text-xs text-neutral-400">{t('admin.lucky.totalQty', { n: totalQty(rows) })}</span>
            ) : (
              <span className={`text-xs ${totalPct(rows) === 100 ? 'text-neutral-400' : 'text-down'}`}>
                {t('admin.lucky.total', { n: totalPct(rows) })}</span>
            )}
            {probs.map((k) => <span key={k} className="text-xs text-amber-300">{t(k)}</span>)}
            <button type="button" className="btn-primary ml-auto px-3 py-1.5 text-sm disabled:opacity-40"
              disabled={busy || ended || probs.length > 0}
              onClick={() => run(async () => {
                const d = await adminApi.luckySavePrizes(round.id, { mode, prizes: toInput(rows, mode) })
                setRows(d.prizes.map(fromAdmin)); setMode(d.round.mode); setDraws(d.round.stats.draws)
                setDirty(false); onSaved(d.round); setMsg(t('admin.lucky.saved'))
              })}>
              {t('admin.lucky.savePrizes')}</button>
          </div>
          {msg && <p className="text-xs text-neutral-300">{msg}</p>}
        </section>
        <section className="card p-4"><LuckyWheel prizes={preview} rotation={0} spinning={false} /></section>
      </div>
    </div>
  )
}
