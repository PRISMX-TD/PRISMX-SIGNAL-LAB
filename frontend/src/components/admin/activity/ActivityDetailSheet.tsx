// 操作日志的详情抽屉（设计 §6）：标题句 + 状态；基本信息（时间、用户含完整手机号、MT5 账户、来源、
// 结果 + 券商原话、订单号 / 仓位号）；交易类「这笔仓位的完整经过」时间轴；管理员类「修改前 / 修改后」
// 对照表；合并行的明细；底部「只看此用户」「只看此账户」「打开用户资料」。
// 只在打开时调 /admin/activity/item；先用列表里那一行画出来，详情到了再补全，不让人对着空抽屉等。
// The activity drawer (design §6): headline sentence + status, basics, the position
// timeline for trades, a before / after table for admin changes, the breakdown of merged
// rows, and filter / profile buttons. /admin/activity/item is called on open only; the
// list row renders immediately and the detail fills in when it arrives.
import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { adminApi, isAbortError } from '../../../api/client'
import { localizeApiError } from '../../../api/utils'
import type { ActivityDetail, ActivityItem, ActivityPerson, ActivityQuery } from '../../../api/types'
import AdminSheet from '../AdminSheet'
import { SkeletonLine } from '../../Skeleton'
import { actorLabel, changeFieldLabel, changeValueText, chipsFor, fmtPnl, kindName, renderEvent } from './renderEvent'
import { bjClock, bjFull } from './time'
import { AccountTags, CatDot, ChipList, Sentence, UserCell, pnlClass } from './ActivityBits'

type Raw = Record<string, unknown>

/** 详情请求带上的列表筛选 / the list filters sent with the detail request */
export type ActivityItemFilters = Pick<ActivityQuery, 'cat' | 'abnormal' | 'q' | 'userId'>

const isObj = (v: unknown): v is Raw => !!v && typeof v === 'object' && !Array.isArray(v)

/** 审计表存的是原文：JSON 字符串解析开，Python 的 True / False 也认。
 *  Audit values are stored as text: parse JSON strings, and Python's True / False too. */
export function parseStored(v: unknown): unknown {
  if (typeof v !== 'string') return v
  const s = v.trim()
  if (s === 'True') return true
  if (s === 'False') return false
  if (s === 'None' || s === '') return null
  if (/^[[{"]/.test(s) || /^(true|false|null|-?\d+(\.\d+)?)$/.test(s)) {
    try {
      return JSON.parse(s)
    } catch {
      return v
    }
  }
  return v
}

// 审计表里的时刻有两种写法：ISO（带 T）和 Python 的 str(datetime)（空格分隔，可能带 +00:00、
// 可能不带时区）。不带时区的按 UTC（与全站 parseTime 同一口径），都换成北京时间显示。
// Stored instants come as ISO (with a T) or as Python's str(datetime) (a space, maybe a
// +00:00, maybe no zone at all). No zone means UTC, as everywhere else; both show as Beijing time.
const STORED_TIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([+-]\d{2}:?\d{2}|Z)?$/
// 会员审计行的值形如 PRO(2026-11-09 00:00:00+00:00)、PRO(7d)、FREE(None)
// Membership audit values look like PRO(2026-11-09 00:00:00+00:00), PRO(7d), FREE(None)
const PLAN_WITH = /^([A-Z]+)\((.*)\)$/

/** 抽屉里的值：比句子宽松，结构化的值给紧凑 JSON（这里是给要查问题的人看的）。
 *  Drawer values: looser than the sentence; structured values show compact JSON (this is for
 *  someone investigating). */
export function showValue(v: unknown, t: TFunction): string {
  if (v == null || v === '') return '—'
  if (typeof v === 'boolean') return t(v ? 'admin.log.v.yes' : 'admin.log.v.no')
  if (typeof v === 'number') return String(v)
  if (typeof v === 'string') {
    const s = v.trim()
    if (STORED_TIME.test(s)) return bjFull(s.replace(' ', 'T'))
    const m = PLAN_WITH.exec(s)
    if (m) {
      const inner = m[2].trim()
      if (inner === '' || inner === 'None') return m[1]
      if (STORED_TIME.test(inner)) return t('admin.log.detail.planUntil', { plan: m[1], d: bjFull(inner.replace(' ', 'T')) })
      const days = /^(\d+)d$/.exec(inner)
      if (days) return t('admin.log.detail.planDays', { plan: m[1], days: Number(days[1]) })
    }
    return v
  }
  if (Array.isArray(v) && v.every((x) => typeof x !== 'object' || x === null)) return v.map((x) => String(x)).join(', ')
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

export interface ChangeRow {
  /** 审计行的原字段名 / the audit row's raw field name */
  field: string
  /** 值是 JSON 时拆开的那个键 / the key a JSON value was split on */
  sub: string | null
  before: unknown
  after: unknown
  target: string | null
}

/**
 * 「修改前 / 修改后」对照表的行：审计行的 old / new 解析开；两侧有一边是对象就按键拆成多行
 * （「JSON 拆字段」），只拆一层。
 * Rows of the before / after table: audit old / new parsed; when either side is an object it
 * is split per key (one level), as the design asks ("split JSON into fields").
 */
export function changeRows(raw: Raw | null | undefined, params: Raw | null | undefined): ChangeRow[] {
  const out: ChangeRow[] = []
  const push = (field: string, a: unknown, b: unknown, target: string | null) => {
    if (isObj(a) || isObj(b)) {
      const keys = new Set([...Object.keys(isObj(a) ? a : {}), ...Object.keys(isObj(b) ? b : {})])
      for (const k of keys) out.push({ field, sub: k, before: isObj(a) ? a[k] : null, after: isObj(b) ? b[k] : null, target })
    } else out.push({ field, sub: null, before: a, after: b, target })
  }
  const rows = Array.isArray(raw?.rows) ? (raw!.rows as unknown[]) : []
  for (const r of rows) {
    if (!isObj(r)) continue
    const target = isObj(r.target) ? ((r.target.nickname as string) || (r.target.email as string) || null) : null
    push(String(r.field ?? '?'), parseStored(r.old), parseStored(r.new), target)
  }
  if (!rows.length && Array.isArray(params?.changes)) {
    for (const c of params!.changes as unknown[]) {
      if (!isObj(c)) continue
      // 列表行里只有键名（设置项还有分组）：拼回审计字段的形状，标签表按同一套找
      // List rows carry bare keys (plus a group for settings): rebuild the audit field shape
      const key = typeof c.key === 'string' && c.key ? c.key : typeof c.field === 'string' && c.field ? c.field : '?'
      const field = typeof c.group === 'string' && c.group ? `setting:${c.group}:${key}` : key
      push(field, c.old, c.new, null)
    }
  }
  return out
}

export interface ChangeCell {
  label: string
  field: string
  before: string
  after: string
  target: string | null
}

/** 对照表的显示文字：项目翻成人话标签、值能翻的翻（角色、R 倍数…）、时间换北京时间。
 *  Display text for the table: human field labels, translated values where possible, Beijing times. */
export function changeCells(kind: string, raw: Raw | null | undefined, params: Raw | null | undefined, t: TFunction): ChangeCell[] {
  return changeRows(raw, params).map((r) => {
    const value = (v: unknown) => changeValueText(kind, r.sub ?? r.field, v, t) ?? showValue(v, t)
    return {
      label: changeFieldLabel(kind, r.field, r.sub, t),
      field: r.sub ? `${r.field} · ${r.sub}` : r.field,
      before: value(r.before),
      after: value(r.after),
      target: r.target,
    }
  })
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-5">
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">{title}</h4>
      {children}
    </section>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-xs text-neutral-500">{label}</dt>
      <dd className="min-w-0 break-words text-sm text-neutral-200">{children}</dd>
    </>
  )
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v : null)

export default function ActivityDetailSheet({
  item,
  filters,
  onClose,
  onUser,
  onLogin,
  onOpenUser,
}: {
  item: ActivityItem
  // 打开时列表的筛选：合并行（审计组、追踪止损）按它还原，抽屉与被点的那一行一致
  // The list's filters when opened: merged rows are rebuilt with them, matching the clicked row
  filters?: ActivityItemFilters
  onClose: () => void
  onUser: (u: ActivityPerson) => void
  onLogin: (login: string) => void
  onOpenUser?: (email: string) => void
}) {
  const { t } = useTranslation()
  const [data, setData] = useState<ActivityDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const ctrl = new AbortController()
    setData(null)
    setError(null)
    adminApi
      .activityItem(item.key, filters, ctrl.signal)
      .then(setData)
      .catch((err) => {
        if (!isAbortError(err)) setError(err instanceof Error ? localizeApiError(err.message) : t('admin.log.detail.loadError'))
      })
    return () => ctrl.abort()
  }, [item.key])

  const it = data?.item ?? item
  const p = it.params ?? {}
  const raw = data?.raw ?? null
  const rendered = renderEvent(it, t)
  const user = data?.user ?? null
  const acct = data?.account ?? null
  const msg = str(p.msg) ?? str(raw?.message)
  const src = str(p.src) ?? str(raw?.src)
  const moneyShown = it.cat === 'trade' || num(p.bal) != null
  const rows = it.cat === 'admin' || it.kind.startsWith('plan.') || it.kind === 'auto.settings' ? changeCells(it.kind, raw, p, t) : []
  const multiTarget = new Set(rows.map((r) => r.target)).size > 1
  // 原始字段：审计行 / 爆仓腿另有表格，这里不再重复 / audit rows and stop-out legs have their own table
  const rawEntries = raw ? Object.entries(raw).filter(([k]) => k !== 'rows' && k !== 'legs') : []
  const ids: [string, unknown][] = [
    [t('admin.log.detail.orderNo'), raw?.mt5_ticket],
    [t('admin.log.detail.positionNo'), raw?.mt5_position ?? raw?.ticket ?? raw?.position_ticket ?? data?.position?.ticket],
    [t('admin.log.detail.dealNo'), raw?.deal_ticket],
    [t('admin.log.detail.batch'), raw?.batch],
  ]

  const plan = (() => {
    if (!user?.plan) return null
    return user.plan_expires_at ? t('admin.log.detail.planUntil', { plan: user.plan, d: bjFull(user.plan_expires_at) }) : user.plan
  })()

  return (
    <AdminSheet title={kindName(it.kind, t)} onClose={onClose} widthClass="sm:w-[680px]" badge={<CatDot cat={it.cat} />}>
      {/* 标题句 + 状态 / headline sentence + status */}
      <p className="mt-3 text-base leading-relaxed text-neutral-100">
        <Sentence parts={rendered.parts} /> <ChipList chips={chipsFor(it, t)} />
      </p>

      {error && <p className="mt-3 rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-sm text-down">{t('admin.log.detail.loadError')} — {error}</p>}

      <Section title={t('admin.log.detail.basic')}>
        <dl className="grid grid-cols-[minmax(84px,auto)_minmax(0,1fr)] gap-x-4 gap-y-1.5">
          {it.at && <Field label={t('admin.log.detail.dealAt')}>{bjFull(it.at)}</Field>}
          <Field label={t('admin.log.detail.recordedAt')}>{bjFull(it.ts)}</Field>
          <Field label={t('admin.log.detail.actor')}>
            {actorLabel(it, t)}
            {it.actor.email && it.actor.name && <span className="ml-1 font-mono text-xs text-neutral-500">{it.actor.email}</span>}
          </Field>
          {src && <Field label={t('admin.log.detail.source')}>{t(`admin.log.detail.src.${src === 'SIG' || src === 'STRAT' ? src : 'CHART'}`)}</Field>}
          {/* 「结果」只对平台发出的指令有意义（MT5 成交、事件恒为成功）
              "Result" only means something for platform instructions (deals and events are always ok) */}
          {(it.key.startsWith('o:') || it.key.startsWith('t:') || it.kind === 'trade.close_all') && (
            <Field label={t('admin.log.detail.result')}>{t(`admin.log.status.${it.status}`)}</Field>
          )}
          {msg && (
            <Field label={t('admin.log.detail.brokerMsg')}>
              <span className="font-mono text-xs text-neutral-300">{msg}</span>
            </Field>
          )}
          {ids.map(([label, v]) =>
            v == null || v === '' ? null : (
              <Field key={label} label={label}>
                <span className="num font-mono text-xs">{String(v)}</span>
              </Field>
            ),
          )}
        </dl>
        {moneyShown && <p className="mt-2 text-[11px] text-neutral-500">{t('admin.log.detail.currencyNote')}</p>}
      </Section>

      {(user || it.user) && (
        <Section title={t('admin.log.detail.user')}>
          <dl className="grid grid-cols-[minmax(84px,auto)_minmax(0,1fr)] gap-x-4 gap-y-1.5">
            <Field label={t('admin.log.detail.nickname')}>{user?.nickname ?? it.user?.nickname ?? '—'}</Field>
            <Field label={t('admin.log.detail.email')}>
              <span className="break-all font-mono text-xs">{user?.email ?? it.user?.email ?? '—'}</span>
            </Field>
            {data && (
              <>
                {/* 完整手机号只在这里显示（列表里不显示）/ the full phone number appears only here */}
                <Field label={t('admin.log.detail.phone')}>
                  <span className="font-mono text-xs">{user?.phone ?? '—'}</span>
                </Field>
                <Field label={t('admin.log.detail.plan')}>{plan ?? '—'}</Field>
                <Field label={t('admin.log.detail.role')}>{user?.role ? t(`admin.log.v.role.${user.role === 'admin' ? 'admin' : 'user'}`) : '—'}</Field>
                <Field label={t('admin.log.detail.registered')}>{bjFull(user?.created_at)}</Field>
              </>
            )}
          </dl>
        </Section>
      )}

      {it.login && (
        <Section title={t('admin.log.detail.account')}>
          <dl className="grid grid-cols-[minmax(84px,auto)_minmax(0,1fr)] gap-x-4 gap-y-1.5">
            <Field label={t('admin.log.detail.account')}>
              <span className="inline-flex flex-wrap items-center gap-1">
                <span className="num font-mono text-xs">{it.login}</span>
                <AccountTags item={it} />
              </span>
            </Field>
            {acct && (
              <>
                <Field label={t('admin.log.detail.channel')}>{acct.channel ? t(`admin.log.acct.${acct.channel}`) : '—'}</Field>
                <Field label={t('admin.log.detail.accountType')}>
                  {acct.demo === true ? t('admin.log.acct.demo') : acct.demo === false ? t('admin.log.acct.live') : '—'}
                </Field>
                <Field label={t('admin.log.detail.state')}>
                  {[
                    acct.removed ? t('admin.log.acct.removed') : null,
                    acct.revoked ? t('admin.log.acct.revoked') : null,
                    !acct.removed && !acct.revoked ? t('admin.log.detail.normal') : null,
                    acct.online === true ? t('admin.log.detail.online') : acct.online === false ? t('admin.log.detail.offline') : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </Field>
                {acct.server && <Field label={t('admin.log.detail.server')}>{acct.server}</Field>}
                {acct.name && <Field label={t('admin.log.detail.accName')}>{acct.name}</Field>}
                {acct.holders.length > 0 && (
                  <Field label={t('admin.log.detail.holders')}>
                    {acct.holders.map((h) => [h.nickname, h.email].filter(Boolean).join(' · ')).join('；')}
                  </Field>
                )}
              </>
            )}
          </dl>
        </Section>
      )}

      {!data && !error && (
        <div className="mt-5 space-y-2" aria-label={t('admin.log.detail.loading')}>
          <SkeletonLine height={14} />
          <SkeletonLine width="70%" height={14} />
        </div>
      )}

      {/* 这笔仓位的完整经过：竖线时间轴，当前这一步高亮 / the position's whole story, current step highlighted */}
      {data?.position && data.position.steps.length > 0 && (
        <Section title={t('admin.log.detail.timeline')}>
          <ol className="relative ml-1.5 border-l border-white/10">
            {data.position.steps.map((s) => {
              const current = s.key === it.key || (it.children ?? []).some((c) => c.key === s.key)
              return (
                <li key={s.key} className="relative pb-3 pl-4 last:pb-0">
                  <span
                    aria-hidden
                    className={`absolute -left-[5px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-[color:var(--surface)] ${
                      current ? 'bg-prism-400' : 'bg-neutral-600'
                    }`}
                  />
                  <div className="num text-[11px] text-neutral-500">{bjFull(s.at ?? s.ts)}</div>
                  <div className={`text-sm leading-relaxed ${current ? 'text-neutral-100' : 'text-neutral-300'}`}>
                    <Sentence parts={renderEvent(s, t).parts} /> <ChipList chips={chipsFor(s, t)} />
                  </div>
                </li>
              )
            })}
          </ol>
          {data.position.total_pnl != null && (
            <p className="mt-3 text-sm text-neutral-300">
              {t('admin.log.detail.totalPnl')}{' '}
              <span className={`num font-semibold ${pnlClass(data.position.total_pnl)}`}>{fmtPnl(data.position.total_pnl)}</span>
            </p>
          )}
        </Section>
      )}

      {/* 修改前 / 修改后 / before and after */}
      {rows.length > 0 && (
        <Section title={t('admin.log.detail.changes')}>
          <div className="overflow-x-auto rounded-lg border border-white/5">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-white/10 text-neutral-500">
                  {multiTarget && <th className="px-3 py-2 font-medium">{t('admin.log.detail.target')}</th>}
                  <th className="px-3 py-2 font-medium">{t('admin.log.detail.field')}</th>
                  <th className="px-3 py-2 font-medium">{t('admin.log.detail.before')}</th>
                  <th className="px-3 py-2 font-medium">{t('admin.log.detail.after')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className="border-b border-white/5 align-top last:border-0">
                    {multiTarget && <td className="px-3 py-2 text-neutral-300">{r.target ?? '—'}</td>}
                    {/* 标签是人话，原字段名留在 title 里给查问题的人 / human label; raw field name in the title */}
                    <td className="break-words px-3 py-2 text-neutral-400" title={r.field}>
                      {r.label}
                    </td>
                    <td className="break-words px-3 py-2 text-neutral-400">{r.before}</td>
                    <td className="break-words px-3 py-2 text-neutral-100">{r.after}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {/* 合并行的明细（一键平仓子单、爆仓的每一笔、批量修改的每位用户、每一次追踪）
          The breakdown of a merged row */}
      {it.children && it.children.length > 0 && (
        <Section title={t('admin.log.detail.children')}>
          <ul className="divide-y divide-white/5 rounded-lg border border-white/5">
            {it.children.map((c) => (
              <li key={c.key} className="grid grid-cols-[64px_minmax(0,1fr)] gap-x-3 px-3 py-2">
                <span className="num pt-0.5 text-[11px] text-neutral-500">{bjClock(c.at ?? c.ts)}</span>
                <div className="min-w-0 text-sm leading-relaxed text-neutral-200">
                  <Sentence parts={renderEvent(c, t).parts} /> <ChipList chips={chipsFor(c, t)} />
                  {it.kind === 'admin.bulk_edit' && c.user && (
                    <div className="mt-0.5">
                      <UserCell item={c} />
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {rawEntries.length > 0 && (
        <details className="mt-5 rounded-lg border border-white/5 px-3 py-2">
          <summary className="cursor-pointer text-xs font-semibold text-neutral-500">{t('admin.log.detail.raw')}</summary>
          <dl className="mt-2 grid grid-cols-[minmax(96px,auto)_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs">
            {rawEntries.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="font-mono text-neutral-500">{k}</dt>
                <dd className="min-w-0 break-all font-mono text-neutral-300">{showValue(v, t)}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}

      {/* 底部按钮 / footer buttons */}
      <div className="mt-6 flex flex-wrap gap-2">
        {it.user && (
          <button type="button" className="btn-ghost px-3 py-1.5 text-xs" onClick={() => onUser(it.user!)}>
            {t('admin.log.detail.onlyUser')}
          </button>
        )}
        {it.login && (
          <button type="button" className="btn-ghost px-3 py-1.5 text-xs" onClick={() => onLogin(it.login!)}>
            {t('admin.log.detail.onlyAccount')}
          </button>
        )}
        {onOpenUser && (user?.email ?? it.user?.email) && (
          <button type="button" className="btn-ghost px-3 py-1.5 text-xs" onClick={() => onOpenUser((user?.email ?? it.user?.email)!)}>
            {t('admin.log.detail.openUser')}
          </button>
        )}
      </div>
    </AdminSheet>
  )
}
