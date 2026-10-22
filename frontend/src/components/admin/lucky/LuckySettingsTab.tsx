// 一期的「奖品设置」（v2）。左边：奖品模式两张选项卡（这一期已有抽奖记录就锁住）+ 奖品格编辑（每格一张卡：
// 颜色、名称、类型、份数 / 概率、排序删除；第二行是说明、图片和自定义奖品的领取方式）+ 底栏（加格、合计、
// 问题提示、保存）。右边：预览（与用户端同一个转盘，可选节日皮肤）、按当前设置算的抽中占比、「试转」：
// 本地按同样的权重挑一格转过去，不扣券、不记录，只用来看效果。合计不等于 100% 等问题存在时保存键禁用；
// 已结束的期只读。外壳按 round.id 做 key，换期即重载。
// One round's prize settings (v2). Left: the two mode cards (locked once the round has draws), the slot
// editor (one card per slot: colour, name, kind, stock / odds, reorder and remove; a second row for the
// description, image and a custom prize's claim method) and a footer (add slot, totals, problems, Save).
// Right: a preview (the same wheel users see, with an optional festival skin), the share each slot gets
// under the current settings, and a test spin that picks a slot locally by those weights: no ticket, no
// record, just a look. Save stays disabled while there are problems; an ended round is read-only. The
// shell keys this by round.id, so switching rounds reloads.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { adminApi } from '../../../api/client'
import type { LuckyMode, LuckyPrizeKind, LuckyPrizePublic, LuckyRoundAdmin } from '../../../api/luckyTypes'
import { localizeApiError } from '../../../api/utils'
import { useFestivalOptional } from '../../../festival/FestivalProvider'
import LuckyWheel, { type LuckyWheelHandle } from '../../lucky/LuckyWheel'
import { slotColor } from '../../lucky/wheelArt'
import ImageField from '../ImageField'
import LuckyModeOptions from './LuckyModeOptions'
import {
  FESTIVAL_CHOICES, autoColor, blankRow, fromAdmin, pickWeighted, previewWeights, problems, resolveFestival, sharePct,
  slotSoldOut, toInput, totalPct, totalQty, type FestivalChoice, type PrizeRow,
} from './prizeForm'

const KINDS: LuckyPrizeKind[] = ['pro_days', 'custom', 'retry', 'none']
const MAX_SLOTS = 12

export default function LuckySettingsTab({ round, onSaved, onDirty }: {
  round: LuckyRoundAdmin
  onSaved: (r: LuckyRoundAdmin) => void
  // 奖项表有未保存的改动时通知外壳，外壳切页签 / 换期前据此确认。
  // Tells the shell about unsaved prize edits so it can confirm before a tab or round switch.
  onDirty?: (dirty: boolean) => void
}) {
  const { t } = useTranslation()
  const siteFestival = useFestivalOptional()?.festival ?? null
  const [rows, setRows] = useState<PrizeRow[] | null>(null)
  const [mode, setMode] = useState<LuckyMode>(round.mode)
  // 抽奖记录数以详情接口为准（列表可能稍旧）/ the draw count from the detail call (the list may be a bit stale)
  const [draws, setDraws] = useState(round.stats.draws)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [fest, setFest] = useState<FestivalChoice>('auto')
  const [testing, setTesting] = useState(false)
  const [testMsg, setTestMsg] = useState('')
  const wheel = useRef<LuckyWheelHandle>(null)
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
  const weights = useMemo(() => previewWeights(list, mode), [list, mode])
  const shares = useMemo(() => sharePct(weights), [weights])
  const preview = useMemo<LuckyPrizePublic[]>(() => list.map((r, i) => ({
    id: r.key, name: r.name.trim() || t('admin.lucky.preview.slotN', { n: i + 1 }), description: null,
    imageUrl: r.imageUrl || null, color: r.color || null, kind: r.kind, proDays: Number(r.proDays) || null,
  })), [list, t])
  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setMsg('')
    try { await fn() } catch (e) { setMsg(e instanceof Error ? localizeApiError(e.message) : t('common.error')) } finally { setBusy(false) }
  }
  // 所有对奖项表的改动都走 edit，顺手标脏。/ Every edit to the prize table goes through `edit`, which marks it dirty.
  const edit = (fn: (xs: PrizeRow[]) => PrizeRow[]) => { setRows((xs) => fn(xs ?? [])); setDirty(true) }
  const patch = (key: string, p: Partial<PrizeRow>) => edit((xs) => xs.map((r) => (r.key === key ? { ...r, ...p } : r)))
  const move = (i: number, d: -1 | 1) => edit((xs) => {
    const j = i + d
    if (j < 0 || j >= xs.length) return xs
    const c = [...xs]; [c[i], c[j]] = [c[j], c[i]]; return c
  })

  // 试转：本地按当前权重挑一格，转过去再报结果；不碰后端。
  // Test spin: pick a slot locally by the current weights, spin there and report; never touches the backend.
  const testSpin = async () => {
    if (testing) return
    const i = pickWeighted(weights, Math.random())
    if (i < 0) { setTestMsg(t('admin.lucky.preview.noWeight')); return }
    const r = list[i]
    setTesting(true); setTestMsg('')
    try {
      await wheel.current?.spinTo(i)
      const soldOut = slotSoldOut(r, mode)
      if (r.kind !== 'none' && !soldOut) wheel.current?.celebrate()
      const name = r.name.trim() || t('admin.lucky.preview.slotN', { n: i + 1 })
      setTestMsg(t(soldOut ? 'admin.lucky.preview.resultSoldOut' : 'admin.lucky.preview.result', { name }))
    } finally { setTesting(false) }
  }

  if (!rows) return <div className="adm-card text-sm text-neutral-500">{msg || t('common.loading')}</div>

  const pct = totalPct(rows)
  return (
    <div className="lka-settings">
      <div className="min-w-0 space-y-4">
        <section className="adm-card">
          <div className="lka-card-head">
            <div className="min-w-0">
              <h4 className="lka-h">{t('admin.lucky.mode.label')}</h4>
              {draws > 0 && !ended && <p className="lka-note is-warn mt-1">{t('admin.lucky.mode.locked')}</p>}
              {ended && <p className="lka-note is-warn mt-1">{t('admin.lucky.endedReadOnly')}</p>}
            </div>
          </div>
          <LuckyModeOptions value={mode} locked={modeLocked} onChange={(m) => { setMode(m); setDirty(true) }} />
        </section>

        <section className="adm-card">
          <div className="lka-card-head">
            <h4 className="lka-h">{t('admin.lucky.slots.title')}</h4>
            <span className="lka-note num">{t('admin.lucky.slots.count', { n: rows.length, max: MAX_SLOTS })}</span>
          </div>
          <ol className="lka-slots">
            {rows.map((r, i) => {
              const color = r.color || autoColor(i)
              return (
                <li key={r.key} className="lka-slot">
                  <div className="lka-slot-row">
                    <span className="lka-slot-idx num">{i + 1}</span>
                    <label className={`lka-swatch ${r.color ? '' : 'is-auto'}`} title={r.color ? t('admin.lucky.color') : t('admin.lucky.colorAuto')}>
                      <span className="lka-swatch-dot" style={{ background: color }} />
                      <input type="color" value={color} aria-label={t('admin.lucky.color')}
                        onChange={(e) => patch(r.key, { color: e.target.value })} />
                      {!r.color && <span className="lka-swatch-text">{t('admin.lucky.slots.auto')}</span>}
                    </label>
                    {r.color && (
                      <button type="button" className="adm-link-btn" onClick={() => patch(r.key, { color: '' })}>
                        {t('admin.lucky.colorReset')}</button>
                    )}
                    <input className="input lka-in-name" placeholder={t('admin.lucky.name')} maxLength={40}
                      aria-label={t('admin.lucky.name')} value={r.name} onChange={(e) => patch(r.key, { name: e.target.value })} />
                    <select className="input lka-in-kind" value={r.kind} aria-label={t('admin.lucky.kindLabel')}
                      onChange={(e) => patch(r.key, { kind: e.target.value as LuckyPrizeKind })}>
                      {KINDS.map((k) => <option key={k} value={k}>{t(`admin.lucky.kind.${k}`)}</option>)}
                    </select>
                    {r.kind === 'pro_days' && (
                      <label className="lka-field">
                        <input className="input lka-in-num" inputMode="numeric" aria-label={t('admin.lucky.days')}
                          placeholder={t('admin.lucky.days')} value={r.proDays} onChange={(e) => patch(r.key, { proDays: e.target.value })} />
                        {t('admin.lucky.slots.daysUnit')}
                      </label>
                    )}
                    {mode === 'qty' ? (
                      <label className="lka-field">
                        {t('admin.lucky.stockQty')}
                        <input className="input lka-in-num" inputMode="numeric" value={r.stock}
                          onChange={(e) => patch(r.key, { stock: e.target.value })} />
                      </label>
                    ) : (
                      <>
                        <label className="lka-field">
                          <input className="input lka-in-num" inputMode="decimal" aria-label={t('admin.lucky.prob')} value={r.probPct}
                            onChange={(e) => patch(r.key, { probPct: e.target.value })} />%
                        </label>
                        <input className="input lka-in-cap" inputMode="numeric" placeholder={t('admin.lucky.stockCap')}
                          aria-label={t('admin.lucky.stockCap')} value={r.stock} onChange={(e) => patch(r.key, { stock: e.target.value })} />
                      </>
                    )}
                    {r.stockUsed > 0 && <span className="adm-pill num">{t('admin.lucky.given', { n: r.stockUsed })}</span>}
                    <div className="lka-slot-tools">
                      <button type="button" className="adm-icon-btn" disabled={i === 0} aria-label={t('admin.lucky.moveUp')}
                        title={t('admin.lucky.moveUp')} onClick={() => move(i, -1)}><Chevron up /></button>
                      <button type="button" className="adm-icon-btn" disabled={i === rows.length - 1} aria-label={t('admin.lucky.moveDown')}
                        title={t('admin.lucky.moveDown')} onClick={() => move(i, 1)}><Chevron /></button>
                      <button type="button" className="adm-icon-btn is-down" aria-label={t('admin.lucky.remove')} title={t('admin.lucky.remove')}
                        onClick={() => edit((xs) => xs.filter((x) => x.key !== r.key))}><Cross /></button>
                    </div>
                  </div>
                  <div className="lka-slot-row is-sub">
                    <input className="input lka-in-grow" maxLength={300} placeholder={t('admin.lucky.description')}
                      aria-label={t('admin.lucky.description')} value={r.description}
                      onChange={(e) => patch(r.key, { description: e.target.value })} />
                    <div className="min-w-0 max-w-full flex-1 basis-56">
                      <ImageField compact value={r.imageUrl} onChange={(url) => patch(r.key, { imageUrl: url })} />
                    </div>
                  </div>
                  {r.kind === 'custom' && (
                    <div className="lka-slot-row is-sub">
                      <select className="input lka-in-kind" value={r.claimMode} aria-label={t('admin.lucky.claimMode.pick')}
                        onChange={(e) => patch(r.key, { claimMode: e.target.value as PrizeRow['claimMode'] })}>
                        <option value="">{t('admin.lucky.claimMode.pick')}</option>
                        <option value="form">{t('admin.lucky.claimMode.form')}</option>
                        <option value="ticket">{t('admin.lucky.claimMode.ticket')}</option>
                      </select>
                      {r.claimMode === 'form' && (
                        <input className="input lka-in-grow" maxLength={200} placeholder={t('admin.lucky.claimHint')}
                          aria-label={t('admin.lucky.claimHint')} value={r.claimHint}
                          onChange={(e) => patch(r.key, { claimHint: e.target.value })} />
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ol>
          <div className="lka-slots-foot">
            <button type="button" className="adm-btn" disabled={rows.length >= MAX_SLOTS}
              onClick={() => edit((xs) => [...xs, blankRow('custom')])}>{t('admin.lucky.addSlot')}</button>
            {mode === 'qty' ? (
              <span className="lka-total num">{t('admin.lucky.totalQty', { n: totalQty(rows) })}</span>
            ) : (
              <span className={`lka-total num ${pct === 100 ? '' : 'is-bad'}`}>{t('admin.lucky.total', { n: pct })}</span>
            )}
            {probs.map((k) => <span key={k} className="adm-pill is-warn">{t(k)}</span>)}
            <button type="button" className="adm-btn is-primary ml-auto"
              disabled={busy || ended || probs.length > 0 || !dirty}
              onClick={() => run(async () => {
                const d = await adminApi.luckySavePrizes(round.id, { mode, prizes: toInput(rows, mode) })
                setRows(d.prizes.map(fromAdmin)); setMode(d.round.mode); setDraws(d.round.stats.draws)
                setDirty(false); onSaved(d.round); setMsg(t('admin.lucky.saved'))
              })}>
              {t('admin.lucky.savePrizes')}</button>
          </div>
          {msg && <p className="lka-note mt-3" role="status">{msg}</p>}
        </section>
      </div>

      <aside className="lka-preview adm-card min-w-0">
        <div className="lka-card-head">
          <div className="min-w-0">
            <h4 className="lka-h">{t('admin.lucky.preview.title')}</h4>
            <p className="lka-sub">{t('admin.lucky.preview.hint')}</p>
          </div>
        </div>
        <div className="lka-preview-wheel">
          <LuckyWheel ref={wheel} size="sm" prizes={preview} festival={resolveFestival(fest, siteFestival)}
            hub={{
              label: t('admin.lucky.preview.spin'), sub: t('admin.lucky.preview.spinSub'),
              ariaLabel: t('admin.lucky.preview.spinAria'), busy: testing, disabled: rows.length < 2, onPress: () => void testSpin(),
            }} />
        </div>
        <p className="lka-test" role="status" aria-live="polite">{testMsg}</p>

        <div className="lka-sect">
          <p className="lka-sect-title">{t('admin.lucky.preview.festLabel')}</p>
          <div className="adm-seg lka-scroll" role="radiogroup" aria-label={t('admin.lucky.preview.festLabel')}>
            {FESTIVAL_CHOICES.map((c) => (
              <button key={c} type="button" role="radio" aria-checked={fest === c} className={fest === c ? 'is-on' : ''}
                onClick={() => setFest(c)}>{t(`admin.lucky.preview.fest.${c}`)}</button>
            ))}
          </div>
          <p className="lka-note mt-2">{t('admin.lucky.preview.festHint')}</p>
        </div>

        <div className="lka-sect">
          <p className="lka-sect-title">{t('admin.lucky.preview.share')}</p>
          {weights.some((w) => w > 0) ? (
            <div className="lka-stack" aria-hidden>
              {rows.map((r, i) => (weights[i] > 0
                ? <i key={r.key} style={{ width: `${shares[i]}%`, background: slotColor(r.color, i) }} />
                : null))}
            </div>
          ) : <p className="lka-note">{t('admin.lucky.preview.shareEmpty')}</p>}
          <ul className="lka-legend">
            {rows.map((r, i) => (
              <li key={r.key} className={weights[i] > 0 ? '' : 'is-zero'}>
                <span className="lka-legend-dot" style={{ background: slotColor(r.color, i) }} />
                <span className="lka-legend-name">{r.name.trim() || t('admin.lucky.preview.slotN', { n: i + 1 })}</span>
                {slotSoldOut(r, mode) && <span className="adm-pill is-warn">{t('admin.lucky.preview.soldOut')}</span>}
                <span className="lka-legend-pct num">{shares[i]}%</span>
              </li>
            ))}
          </ul>
          <p className="lka-note mt-3">{t(mode === 'qty' ? 'admin.lucky.preview.shareQty' : 'admin.lucky.preview.shareProb')}</p>
        </div>
      </aside>
    </div>
  )
}

// 与控制台图标同一笔法：24 网格、1.75 描边、圆头 / same hand as the console icons: 24 grid, 1.75 stroke, round caps
function Chevron({ up = false }: { up?: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round"
      strokeLinejoin="round" aria-hidden>
      <path d={up ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6'} />
    </svg>
  )
}

function Cross() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round"
      aria-hidden>
      <path d="M7 7l10 10M17 7L7 17" />
    </svg>
  )
}
