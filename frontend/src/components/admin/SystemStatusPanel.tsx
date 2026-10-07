// 系统状态：后端、数据库、Redis、gateway、行情、信号、后台任务、在线情况各一盏灯，每盏灯旁边
// 直接写「现在该怎么做」，下面是一张「遇到问题怎么办」速查表。给不懂技术的管理员用：
// 看灯 → 照着做 → 标着「找 Rex」的不碰。口径见 backend services/system_status.py。
//
// 后端挂了这一页照样打得开（前端托管在 Vercel），所以「读不到后端」本身就是一条结论：
// 显示看门狗会自动重启、等几分钟、超过 5 分钟找人。
//
// 修复按钮：三个「轻」的（重启某个后台任务、刷新比赛排行、让 gateway 重连 MT5）走后端，
// 所有管理员都能按；两个「重」的（重启 gateway、重启后端）走看门狗的运维接口（opsApi），
// 后端挂了也能按，但要输运维口令，与看门狗自动重启共用每小时的次数上限。
//
// System status for non-technical admins: one light per component with what to
// do next, plus a runbook. The page is served by Vercel, so it still loads when
// the backend is down — and "can't reach the backend" is itself the verdict.
// Fix buttons: three light ones via the backend; the two restarts via the
// watchdog's ops endpoint (work with the backend down, need an ops password).
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { adminApi, ApiHttpError, opsApi } from '../../api/client'
import type {
  AdminSystemStatus, HealthComponent, HealthLevel, HealthLoopRow, OpsBudget, OpsHistoryItem, OpsStatus,
} from '../../api/types'
import { useDialogA11y } from '../../utils/useDialogA11y'
import ConfirmModal from '../ConfirmModal'
import { SkeletonLine } from '../Skeleton'

const REFRESH_MS = 15_000

const COMPONENT_ORDER = ['backend', 'database', 'redis', 'gateway', 'feed', 'signals', 'loops', 'online'] as const
// 'watchdog' 不是后端给的：前端按看门狗运维接口的回应自己算（见 watchdogComponent）。
// 'watchdog' isn't from the backend; the page derives it from the ops endpoint.
type ComponentKey = (typeof COMPONENT_ORDER)[number] | 'watchdog'

const LEVEL_RANK: Record<HealthLevel, number> = { idle: 0, ok: 1, warn: 2, down: 3 }

/** 主循环多少秒没动算卡住：看门狗 30 秒一轮，给足 5 轮。/ Main loop considered stuck after this. */
export const WATCHDOG_STALE_SEC = 150

type WdState = 'ok' | 'down' | 'stale' | 'unknown'

/** 「看门狗」这盏灯：SG 看门狗回不回话、主循环在不在转、VPS 看门狗回不回话、额度用完没有、
 *  有没有人有运维口令。lastTickAgoSec 是新字段，旧看门狗没有就不判这一项。
 *  The watchdog light, derived from the ops endpoint's answer. */
export function watchdogComponent(ops: OpsStatus | null, opsError: string | null): HealthComponent {
  if (!ops && opsError === null) return { level: 'idle' }
  const stale = (ago: number | null | undefined) => ago != null && ago > WATCHDOG_STALE_SEC
  const sg: WdState = opsError !== null ? 'down' : !ops ? 'unknown' : stale(ops.backend.lastTickAgoSec) ? 'stale' : 'ok'
  const gw = ops?.gateway
  const vps: WdState = !ops ? 'unknown' : gw?.error ? 'down' : stale(gw?.lastTickAgoSec) ? 'stale' : 'ok'
  const reasons: string[] = []
  let level: HealthLevel = 'ok'
  const raise = (lv: HealthLevel, reason: string) => {
    reasons.push(reason)
    if (LEVEL_RANK[lv] > LEVEL_RANK[level]) level = lv
  }
  if (sg === 'down') raise('down', 'sgDown')
  if (sg === 'stale') raise('down', 'sgStale')
  if (ops) {
    if (vps === 'down') raise('warn', 'vpsDown')
    if (vps === 'stale') raise('warn', 'vpsStale')
    if (ops.backend.restartsUsed >= ops.backend.restartsMax) raise('down', 'budgetBackend')
    if (gw?.restartsMax != null && (gw.restartsUsed ?? 0) >= gw.restartsMax) raise('down', 'budgetGateway')
    if (ops.operators === 0) raise('warn', 'noOperators')
  }
  return {
    level, sg, vps, reasons, error: opsError ?? undefined,
    bu: ops?.backend.restartsUsed, bm: ops?.backend.restartsMax,
    gu: gw?.restartsUsed, gm: gw?.restartsMax,
  }
}

const DOT: Record<HealthLevel, string> = {
  ok: 'bg-up',
  warn: 'bg-amber-300',
  down: 'bg-down',
  idle: 'bg-neutral-500',
}
const TEXT: Record<HealthLevel, string> = {
  ok: 'text-up',
  warn: 'text-amber-300',
  down: 'text-down',
  idle: 'text-neutral-400',
}
const BORDER: Record<HealthLevel, string> = {
  ok: 'border-white/10',
  warn: 'border-amber-300/40',
  down: 'border-down/50',
  idle: 'border-white/10',
}

type RunbookTag = 'wait' | 'admin' | 'rex' | 'stop'
// 顺序 = 管理员最可能遇到的先后；标签决定能不能自己动手。
// Ordered by how likely an admin meets them; the tag says whether to act.
const RUNBOOK: { id: string; tag: RunbookTag }[] = [
  { id: 'siteDown', tag: 'wait' },
  { id: 'after502', tag: 'wait' },
  { id: 'chartsFrozen', tag: 'admin' },
  { id: 'noSignals', tag: 'admin' },
  { id: 'gatewayDown', tag: 'wait' },
  { id: 'reconnecting', tag: 'wait' },
  { id: 'unknownOutcome', tag: 'admin' },
  { id: 'appFrozen', tag: 'admin' },
  { id: 'bridgeOffline', tag: 'admin' },
  { id: 'emailStuck', tag: 'admin' },
  { id: 'bridge500', tag: 'rex' },
  { id: 'mainland', tag: 'rex' },
  { id: 'readOnly', tag: 'rex' },
  { id: 'backendBroken', tag: 'stop' },
]
const TAG_CLS: Record<RunbookTag, string> = {
  wait: 'bg-white/10 text-neutral-300',
  admin: 'bg-up/15 text-up',
  rex: 'bg-amber-300/15 text-amber-300',
  stop: 'bg-down/20 text-down',
}

/** 秒数 → 「3 分钟」这样的人话。/ Seconds to a human duration. */
export function fmtDuration(t: TFunction, sec: number | null | undefined): string {
  if (sec == null) return t('admin.health.unknown')
  if (sec < 60) return t('admin.health.unit.s', { n: sec })
  if (sec < 3600) return t('admin.health.unit.m', { n: Math.floor(sec / 60) })
  if (sec < 86400) return t('admin.health.unit.h', { n: Math.floor(sec / 3600) })
  return t('admin.health.unit.d', { n: Math.floor(sec / 86400) })
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** 每盏灯下面那一行「依据」。探测失败时只有 error。/ The facts line under each light. */
function factsLine(t: TFunction, key: ComponentKey, c: HealthComponent): string {
  if (c.error && key !== 'watchdog') return c.error
  const ago = (s: unknown) => t('admin.health.ago', { t: fmtDuration(t, num(s)) })
  const flag = (v: unknown) =>
    v === true ? t('admin.health.yes') : v === false ? t('admin.health.no') : t('admin.health.unknown')
  switch (key) {
    case 'backend':
      return t('admin.health.comp.backend.facts', { uptime: fmtDuration(t, num(c.uptimeSec)), workers: num(c.workers) ?? 1 })
    case 'database':
      return c.latencyMs == null ? '' : t('admin.health.comp.database.facts', { ms: c.latencyMs })
    case 'redis':
      return c.latencyMs == null ? '' : t('admin.health.comp.redis.facts', { ms: c.latencyMs })
    case 'gateway':
      if (c.level === 'idle') return ''
      if (c.reachable === false) return `${t('admin.health.comp.gateway.unreachableFacts')}${c.detail ? `（${String(c.detail)}）` : ''}`
      return t('admin.health.comp.gateway.facts', {
        mt5: flag(c.mt5Connected), dealer: flag(c.dealerActive),
        rc: num(c.readChannelsConnected) ?? '—', r: num(c.readChannels) ?? '—',
      })
    case 'feed':
      return c.level === 'idle' ? '' : t('admin.health.comp.feed.facts', {
        ago: ago(c.newestAgoSec), active: num(c.activeSymbols) ?? 0, closed: num(c.closedSymbols) ?? 0,
      })
    case 'signals':
      return c.lastAgoSec == null ? '' : t('admin.health.comp.signals.facts', { ago: ago(c.lastAgoSec) })
    case 'loops':
      return t('admin.health.comp.loops.facts', { total: num(c.total) ?? 0, down: num(c.down) ?? 0, warn: num(c.warn) ?? 0 })
    case 'watchdog': {
      if (c.level === 'idle') return ''
      const st = (v: unknown) => t(`admin.health.comp.watchdog.state.${String(v)}`)
      const line = t('admin.health.comp.watchdog.facts', {
        sg: st(c.sg), vps: st(c.vps), bu: c.bu ?? '—', bm: c.bm ?? '—', gu: c.gu ?? '—', gm: c.gm ?? '—',
      })
      const why = ((c.reasons as string[] | undefined) ?? []).map((r) => t(`admin.health.comp.watchdog.reason.${r}`))
      return [line, ...why].join('；')
    }
    case 'online':
      return t('admin.health.comp.online.facts', {
        users: num(c.users) ?? '—', bridges: num(c.bridges) ?? '—', gw: num(c.gatewayAccounts) ?? '—',
      })
  }
}

function hintFor(t: TFunction, key: ComponentKey, level: HealthLevel): string {
  const k = `admin.health.comp.${key}.hint.${level}`
  const s = t(k)
  // 不是每盏灯每个颜色都有专门的话（比如「在线情况」只有一句）；缺了就退回正常那句。
  return s === k ? t(`admin.health.comp.${key}.hint.ok`) : s
}

/** 读不到后端 = 没拿到任何响应，或任何 5xx。这个接口按设计永不抛异常，它回 5xx 只能是
 *  后端本身出了事；而且前面一层代理在后端挂掉时回什么因环境而异（nginx 502、Vite 开发代理 500），
 *  只认 502 以上会把「后端挂了」漏成一个不起眼的普通错误。
 *  Unreachable = no response, or any 5xx: this endpoint never raises by design, and
 *  what the proxy returns for a dead backend varies (nginx 502, the Vite dev proxy 500). */
export function isUnreachable(err: unknown): boolean {
  return !(err instanceof ApiHttpError) || err.status >= 500
}

export type LoopErrorKind =
  'stopped' | 'redis' | 'dbBusy' | 'db' | 'gateway' | 'rateLimit' | 'timeout' | 'network' | 'other'

// 按顺序匹配，先到先得：数据库超时（statement timeout、连接池排满）要排在「连不上数据库」前面，
// 「连不上数据库」要排在通用的超时 / 网络前面（psycopg2 的连不上也带 timeout、Connection refused）。
// gateway 只认 gateway_client 自己打的那几句，不能只看有没有 "gateway"——gateway_positions
// 循环的报错前缀里就带这个词。
// Matched in order, first hit wins; see the comments for why the order matters.
const LOOP_ERROR_RULES: [LoopErrorKind, RegExp][] = [
  ['stopped', /循环意外结束/],
  ['redis', /redis|:6379\b/i],
  ['dbBusy', /statement timeout|canceling statement|QueuePool limit|deadlock detected|lock timeout|too many clients|remaining connection slots|max client conn/i],
  ['db', /psycopg|OperationalError|InterfaceError|sqlalchemy|pooler\.supabase|connection to server at|server closed the connection|SSL connection has been closed/i],
  ['gateway', /Gateway (连不上|超时|HTTP \d)/],
  ['rateLimit', /\b429\b|rate.?limit|too many requests/i],
  ['timeout', /timeout|timed out/i],
  ['network', /ConnectError|ConnectionError|Connection refused|connection reset|Name or service not known|getaddrinfo|Network is unreachable/i],
]

/** 把后台任务的报错原文归成一类，界面上显示一句大白话。/ Classify a raw loop error for a plain-language label. */
export function loopErrorKind(message: string): LoopErrorKind {
  for (const [kind, re] of LOOP_ERROR_RULES) if (re.test(message)) return kind
  return 'other'
}

/** 报错的大白话；点开看原文（手机上没有悬停，所以不用 title）。/ Plain label, tap to reveal the raw text. */
function LoopError({ message, className }: { message: string; className: string }) {
  const { t } = useTranslation()
  return (
    <details className="mt-0.5">
      <summary className={`cursor-pointer list-none hover:underline [&::-webkit-details-marker]:hidden ${className}`}>
        {t(`admin.health.loopTable.errorKind.${loopErrorKind(message)}`)}
      </summary>
      <div className="mt-1 break-all text-[10px] leading-snug text-neutral-600">{message}</div>
    </details>
  )
}

function Light({ level }: { level: HealthLevel }) {
  return (
    <span className="relative flex h-3 w-3 shrink-0">
      {level === 'down' && <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${DOT.down}`} />}
      <span className={`relative inline-flex h-3 w-3 rounded-full ${DOT[level]}`} />
    </span>
  )
}

function ComponentCard({ k, c, children }: { k: ComponentKey; c: HealthComponent; children?: ReactNode }) {
  const { t } = useTranslation()
  const facts = factsLine(t, k, c)
  return (
    <div className={`flex flex-col rounded-inner border bg-white/[0.02] p-4 ${BORDER[c.level]}`}>
      <div className="flex items-center gap-2">
        <Light level={c.level} />
        <span className="text-sm font-semibold text-white">{t(`admin.health.comp.${k}.name`)}</span>
        <span className={`ml-auto text-xs font-medium ${TEXT[c.level]}`}>{t(`admin.health.level.${c.level}`)}</span>
      </div>
      {facts && <p className="mt-2 break-words text-xs tabular-nums text-neutral-400">{facts}</p>}
      <p className={`mt-2 text-xs leading-relaxed ${c.level === 'down' ? 'text-neutral-100' : 'text-neutral-400'}`}>
        {hintFor(t, k, c.level)}
      </p>
      {children && <div className="mt-auto flex flex-wrap items-center gap-2 pt-3">{children}</div>}
    </div>
  )
}

function ActionButton({ onClick, disabled, danger, title, children }: {
  onClick: () => void; disabled?: boolean; danger?: boolean; title?: string; children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`rounded-lg border px-2.5 py-1 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${
        danger
          ? 'border-down/40 bg-down/10 text-down hover:bg-down/20'
          : 'border-white/15 bg-white/5 text-neutral-200 hover:bg-white/10'
      }`}
    >
      {children}
    </button>
  )
}

type HeavyKind = 'backend' | 'gateway'

/** 重按钮能不能按、为什么不能按。/ Whether a restart button is usable, and why not. */
function heavyBlock(t: TFunction, budget: Partial<OpsBudget> | undefined, opsError: string | null): string | null {
  if (opsError !== null) return t('admin.health.actions.opsUnavailable', { msg: opsError })
  if (!budget || budget.restartsMax == null) return t('admin.health.actions.opsUnavailable', { msg: t('admin.health.unknown') })
  if ((budget.restartsUsed ?? 0) >= budget.restartsMax) return t('admin.health.actions.budgetFull', { max: budget.restartsMax })
  if ((budget.cooldownSec ?? 0) > 0) return t('admin.health.actions.cooldown', { sec: budget.cooldownSec })
  return null
}

function HeavyButton({ kind, budget, opsError, onOpen }: {
  kind: HeavyKind; budget: Partial<OpsBudget> | undefined; opsError: string | null; onOpen: (k: HeavyKind) => void
}) {
  const { t } = useTranslation()
  const blocked = heavyBlock(t, budget, opsError)
  return (
    <ActionButton danger disabled={blocked !== null} title={blocked ?? undefined} onClick={() => onOpen(kind)}>
      {t(kind === 'backend' ? 'admin.health.actions.restartBackend' : 'admin.health.actions.restartGateway')}
    </ActionButton>
  )
}

/** 重启确认框：说清影响、显示本小时已用次数、输运维口令。/ Restart dialog with the ops password. */
function RestartModal({ kind, budget, onClose, onDone }: {
  kind: HeavyKind; budget: Partial<OpsBudget> | undefined; onClose: () => void; onDone: (msg: string) => void
}) {
  const { t } = useTranslation()
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sheetRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  useDialogA11y(sheetRef, () => { if (!busy) onClose() })

  const submit = async () => {
    if (!password || busy) return
    setBusy(true)
    setError(null)
    try {
      const rsp = await (kind === 'backend' ? opsApi.restartBackend(password) : opsApi.restartGateway(password))
      onDone(rsp.message)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6 backdrop-blur-sm" onClick={() => { if (!busy) onClose() }}>
      <div ref={sheetRef} className="glass-card w-full max-w-sm p-6" onClick={(e) => e.stopPropagation()}
        role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <h3 id={titleId} className="text-lg font-bold text-white">{t(`admin.health.actions.${kind}Title`)}</h3>
        <p className="mt-3 text-sm leading-relaxed text-neutral-300">{t(`admin.health.actions.${kind}Message`)}</p>
        {budget?.restartsMax != null && (
          <p className="mt-2 text-xs text-neutral-500">
            {t('admin.health.actions.budget', { used: budget.restartsUsed ?? 0, max: budget.restartsMax })}
          </p>
        )}
        <form onSubmit={(e) => { e.preventDefault(); void submit() }} className="mt-4">
          <label className="text-xs text-neutral-400" htmlFor={`${titleId}-pw`}>{t('admin.health.actions.passwordLabel')}</label>
          <input
            id={`${titleId}-pw`}
            type="password"
            autoComplete="off"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={t('admin.health.actions.passwordPlaceholder')}
            className="input mt-1 w-full"
          />
          <p className="mt-1 text-[11px] text-neutral-500">{t('admin.health.actions.passwordHint')}</p>
          {error && <p className="mt-2 text-xs text-down" role="alert">{error}</p>}
          <div className="mt-5 flex gap-3">
            <button type="button" onClick={onClose} disabled={busy} className="btn-ghost flex-1 py-2 text-sm">
              {t('common.cancel')}
            </button>
            <button type="submit" disabled={busy || !password}
              className="flex-1 rounded-xl border border-down/40 bg-down/15 py-2 text-sm font-semibold text-down transition hover:bg-down/25 disabled:opacity-50">
              {busy ? t('admin.health.loading') : t('admin.health.actions.confirmRestart')}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  )
}

function OpsHistoryList({ ops }: { ops: OpsStatus | null }) {
  const { t } = useTranslation()
  if (!ops) return null
  // SG 的记录里有：手动/自动重启后端、手动重启 gateway；VPS 自己的自动重启只在 VPS 那边，补进来。
  const items: OpsHistoryItem[] = [
    ...ops.history,
    ...(ops.gateway.history ?? []).filter((h) => h.source === 'auto'),
  ].sort((a, b) => b.at - a.at).slice(0, 15)
  const resultText = (r: string) => {
    const key = `admin.health.history.result.${r.split(':')[0]}`
    const label = t(key)
    return label === key ? r : label
  }
  return (
    <div className="glass mb-5 p-5">
      <h3 className="mb-3 text-sm font-semibold text-white">{t('admin.health.history.title')}</h3>
      {items.length === 0 ? (
        <p className="text-xs text-neutral-500">{t('admin.health.history.empty')}</p>
      ) : (
        <ul className="divide-y divide-white/5 text-xs">
          {items.map((h, i) => (
            <li key={`${h.at}-${i}`} className="flex flex-wrap gap-x-3 gap-y-0.5 py-2">
              <span className="num text-neutral-500">{new Date(h.at * 1000).toLocaleString()}</span>
              <span className="text-neutral-200">{h.source === 'auto' ? t('admin.health.history.auto') : h.operator}</span>
              <span className="text-neutral-300">{t(`admin.health.history.action.${h.action}`)}</span>
              <span className={h.result === 'ok' || h.result === 'started' ? 'text-up' : 'text-amber-300'}>{resultText(h.result)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function LoopTable({ rows, onRestart, onRefreshCompetitions, busy }: {
  rows: HealthLoopRow[]; onRestart: (name: string) => void; onRefreshCompetitions: () => void; busy: boolean
}) {
  const { t } = useTranslation()
  if (rows.length === 0) return null
  return (
    <div className="glass mb-5 overflow-x-auto p-5">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-white">{t('admin.health.loopTable.title')}</h3>
        <span className="ml-auto">
          <ActionButton onClick={onRefreshCompetitions} disabled={busy}>{t('admin.health.actions.refreshCompetitions')}</ActionButton>
        </span>
      </div>
      <table className="w-full min-w-[600px] text-left text-xs">
        <thead className="text-neutral-500">
          <tr>
            <th className="pb-2 font-medium">{t('admin.health.loopTable.name')}</th>
            <th className="pb-2 font-medium">{t('admin.health.loopTable.status')}</th>
            <th className="pb-2 font-medium">{t('admin.health.loopTable.lastRun')}</th>
            <th className="pb-2 font-medium">{t('admin.health.loopTable.lastError')}</th>
            <th className="pb-2 font-medium" />
          </tr>
        </thead>
        <tbody className="divide-y divide-white/5">
          {rows.map((r) => {
            const nameKey = `admin.health.loopName.${r.name}`
            const label = t(nameKey)
            return (
              <tr key={r.name} className="align-top">
                <td className="py-2 pr-3 text-neutral-200">
                  {label === nameKey ? r.name : label}
                  <div className="text-[10px] text-neutral-600">{r.name}</div>
                </td>
                <td className="whitespace-nowrap py-2 pr-3">
                  <span className="flex items-center gap-1.5">
                    <Light level={r.level} />
                    <span className={TEXT[r.level]}>{t(`admin.health.level.${r.level}`)}</span>
                  </span>
                </td>
                <td className="num whitespace-nowrap py-2 pr-3 text-neutral-300">
                  {r.beatAgoSec == null
                    ? t('admin.health.loopTable.never')
                    : t('admin.health.ago', { t: fmtDuration(t, r.beatAgoSec) })}
                </td>
                <td className="py-2 text-neutral-400">
                  {r.crashMessage ? (
                    <>
                      <span className="text-down">{t('admin.health.loopTable.crashed')}</span>
                      <LoopError message={r.crashMessage} className="text-down" />
                    </>
                  ) : r.errorMessage ? (
                    <>
                      <span className="num text-neutral-300">{t('admin.health.ago', { t: fmtDuration(t, r.errorAgoSec) })}</span>
                      <LoopError message={r.errorMessage} className="text-neutral-400" />
                    </>
                  ) : (
                    t('admin.health.loopTable.none')
                  )}
                </td>
                <td className="py-2 pl-2 text-right">
                  {/* 只有红的（停了、崩了）才给按钮：黄的只是报过错，任务还在跑 */}
                  {r.level === 'down' && (
                    <ActionButton onClick={() => onRestart(r.name)} disabled={busy}>{t('admin.health.actions.restartLoop')}</ActionButton>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <p className="mt-3 text-[11px] text-neutral-500">{t('admin.health.loopTable.errorHint')}</p>
    </div>
  )
}

function Runbook() {
  const { t } = useTranslation()
  return (
    <div className="glass p-5">
      <h3 className="mb-1 text-sm font-semibold text-white">{t('admin.health.runbook.title')}</h3>
      <p className="mb-4 text-xs text-neutral-500">{t('admin.health.runbook.intro')}</p>
      <ul className="divide-y divide-white/5">
        {RUNBOOK.map(({ id, tag }) => (
          <li key={id} className="py-3 first:pt-0 last:pb-0">
            <div className="flex flex-wrap items-start gap-2">
              <span className="text-sm text-neutral-100">{t(`admin.health.runbook.items.${id}.q`)}</span>
              <span className={`ml-auto shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${TAG_CLS[tag]}`}>
                {t(`admin.health.runbook.tag.${tag}`)}
              </span>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-neutral-400">{t(`admin.health.runbook.items.${id}.a`)}</p>
          </li>
        ))}
      </ul>
    </div>
  )
}

export default function SystemStatusPanel() {
  const { t } = useTranslation()
  const [data, setData] = useState<AdminSystemStatus | null>(null)
  const [unreachable, setUnreachable] = useState<string | null>(null)
  const [otherError, setOtherError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [ops, setOps] = useState<OpsStatus | null>(null)
  const [opsError, setOpsError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<{ title: string; message: string; run: () => Promise<string> } | null>(null)
  const [actionBusy, setActionBusy] = useState(false)
  const [heavy, setHeavy] = useState<HeavyKind | null>(null)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const alive = useRef(true)

  const loadOps = useCallback(() => {
    opsApi.status().then(
      (d) => { if (alive.current) { setOps(d); setOpsError(null) } },
      (err: unknown) => {
        if (!alive.current) return
        // 404 = nginx 还没配 /ops/ 转发；502 = 看门狗没在跑；401 = 登录过期
        setOpsError(err instanceof Error ? err.message : String(err))
      },
    )
  }, [])

  const load = useCallback(() => {
    setLoading(true)
    loadOps()
    adminApi.systemStatus().then(
      (d) => {
        if (!alive.current) return
        setData(d)
        setUnreachable(null)
        setOtherError(null)
      },
      (err: unknown) => {
        if (!alive.current) return
        const msg = err instanceof Error ? err.message : String(err)
        if (isUnreachable(err)) setUnreachable(msg)
        else setOtherError(msg)
      },
    ).finally(() => { if (alive.current) setLoading(false) })
  }, [loadOps])

  // 轻按钮：先确认，再调后端，结果显示在页面顶部。/ Light buttons: confirm, call, report.
  const runConfirmed = async () => {
    if (!confirm) return
    setActionBusy(true)
    setNotice(null)   // 别让上一次的结果挂着，看起来像是这一次的
    try {
      const text = await confirm.run()
      setNotice({ ok: true, text })
    } catch (err) {
      setNotice({ ok: false, text: t('admin.health.actions.failed', { msg: err instanceof Error ? err.message : String(err) }) })
    } finally {
      setActionBusy(false)
      setConfirm(null)
      window.setTimeout(load, 3000)
    }
  }

  const loopLabel = (name: string) => {
    const key = `admin.health.loopName.${name}`
    const label = t(key)
    return label === key ? name : label
  }
  const askRestartLoop = (name: string) => setConfirm({
    title: t('admin.health.actions.restartLoopTitle', { name: loopLabel(name) }),
    message: t('admin.health.actions.restartLoopMessage'),
    run: async () => { await adminApi.restartLoop(name); return t('admin.health.actions.restartLoopDone', { name: loopLabel(name) }) },
  })
  const askRefreshCompetitions = () => setConfirm({
    title: t('admin.health.actions.refreshCompetitionsTitle'),
    message: t('admin.health.actions.refreshCompetitionsMessage'),
    run: async () => {
      const r = await adminApi.refreshCompetitions()
      return t('admin.health.actions.refreshCompetitionsDone', { refreshed: r.refreshed, running: r.running })
    },
  })
  const askReconnect = () => setConfirm({
    title: t('admin.health.actions.reconnectTitle'),
    message: t('admin.health.actions.reconnectMessage'),
    run: async () => {
      const r = await adminApi.reconnectGateway()
      return t(r.accepted ? 'admin.health.actions.reconnectDone' : 'admin.health.actions.reconnectAlready')
    },
  })

  // 标签页在后台时不刷新：有人把这页开着一整天也不会一直查后端；切回来立刻补一次，
  // 不让人看着一份过时的数据等满 15 秒。
  // Pause while the tab is hidden; refresh at once when it comes back.
  useEffect(() => {
    alive.current = true
    load()
    const id = window.setInterval(() => { if (!document.hidden) load() }, REFRESH_MS)
    const onVisible = () => { if (!document.hidden) load() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      alive.current = false
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [load])

  const watchdog = watchdogComponent(ops, opsError)
  // 读不到后端时，整体结论就是「异常」，不管上一份数据怎么说；看门狗那盏灯也算进整体结论。
  const backendOverall: HealthLevel | null = unreachable !== null ? 'down' : data?.overall ?? null
  const overall: HealthLevel | null = backendOverall === null ? null
    : LEVEL_RANK[watchdog.level] > LEVEL_RANK[backendOverall] ? watchdog.level : backendOverall
  const updated = data ? new Date(data.generatedAt * 1000).toLocaleTimeString() : null

  return (
    <div>
      <div className="glass mb-5 p-5">
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-white">{t('admin.health.title')}</h2>
            <p className="mt-1 text-xs text-neutral-500">{t('admin.health.subtitle')}</p>
          </div>
          {overall && (
            <span className={`flex items-center gap-2 rounded-full border px-3 py-1 text-sm font-medium ${BORDER[overall]} ${TEXT[overall]}`}>
              <Light level={overall} />
              {t(`admin.health.overall.${overall}`)}
            </span>
          )}
        </div>
        <div className="mt-3 flex items-center gap-3 text-xs text-neutral-500">
          {updated && <span>{t('admin.health.updated', { time: updated })}</span>}
          <button
            type="button"
            onClick={load}
            disabled={loading}
            className="rounded-lg px-2 py-1 text-prism-200 hover:bg-white/5 disabled:opacity-50"
          >
            {loading ? t('admin.health.loading') : t('admin.health.refresh')}
          </button>
        </div>
      </div>

      {notice && (
        <div className={`mb-5 flex items-start gap-3 rounded-inner border p-3 text-sm ${
          notice.ok ? 'border-up/40 bg-up/10 text-up' : 'border-down/40 bg-down/10 text-down'}`} role="status">
          <span className="flex-1">{notice.text}</span>
          <button type="button" onClick={() => setNotice(null)} className="text-xs text-neutral-400 hover:text-neutral-200">✕</button>
        </div>
      )}

      {unreachable !== null && (
        <div className="mb-5 rounded-inner border border-down/50 bg-down/10 p-4" role="alert">
          <div className="flex items-center gap-2">
            <Light level="down" />
            <span className="text-sm font-semibold text-down">{t('admin.health.unreachable.title')}</span>
          </div>
          <p className="mt-2 text-sm leading-relaxed text-neutral-100">{t('admin.health.unreachable.body')}</p>
          {unreachable && <p className="mt-1 text-xs text-neutral-500">{t('admin.health.unreachable.detail', { msg: unreachable })}</p>}
          {/* 后端挂了这里还能按：走看门狗，不经过后端 */}
          <div className="mt-3">
            <HeavyButton kind="backend" budget={ops?.backend} opsError={opsError} onOpen={setHeavy} />
          </div>
        </div>
      )}

      {/* 有旧数据也要说出来：静默保留上一份会让人以为一切照旧。/ Never fail silently over stale data. */}
      {otherError !== null && (
        <p className="mb-5 text-xs text-down">
          {data ? `${t('admin.health.stale')} ` : ''}{otherError}
        </p>
      )}
      {!data && unreachable === null && otherError === null && <SkeletonLine height={160} />}

      {data && (
        <div className={unreachable !== null || otherError !== null ? 'opacity-50' : undefined}>
          <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {COMPONENT_ORDER.map((k) => data.components[k] && (
              <ComponentCard key={k} k={k} c={data.components[k]}>
                {k === 'backend' && <HeavyButton kind="backend" budget={ops?.backend} opsError={opsError} onOpen={setHeavy} />}
                {k === 'gateway' && (
                  <>
                    <ActionButton onClick={askReconnect} disabled={actionBusy}>{t('admin.health.actions.reconnectGateway')}</ActionButton>
                    <HeavyButton kind="gateway" budget={ops?.gateway} opsError={opsError ?? (ops?.gateway.error ? ops.gateway.message ?? ops.gateway.error : null)} onOpen={setHeavy} />
                  </>
                )}
              </ComponentCard>
            ))}
            <ComponentCard k="watchdog" c={watchdog} />
          </div>
          <LoopTable rows={data.loops} onRestart={askRestartLoop} onRefreshCompetitions={askRefreshCompetitions} busy={actionBusy} />
        </div>
      )}

      {/* 后端连不上时上面那排灯不显示，看门狗这盏单独留着：它正是此刻要看的 */}
      {!data && watchdog.level !== 'idle' && (
        <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <ComponentCard k="watchdog" c={watchdog} />
        </div>
      )}
      <OpsHistoryList ops={ops} />

      <Runbook />

      {confirm && (
        <ConfirmModal center title={confirm.title} message={confirm.message} busy={actionBusy}
          onConfirm={() => { void runConfirmed() }} onCancel={() => { if (!actionBusy) setConfirm(null) }} />
      )}
      {heavy && (
        <RestartModal
          kind={heavy}
          budget={heavy === 'backend' ? ops?.backend : ops?.gateway}
          onClose={() => setHeavy(null)}
          onDone={(msg) => { setHeavy(null); setNotice({ ok: true, text: msg }); loadOps(); window.setTimeout(load, 15_000) }}
        />
      )}
    </div>
  )
}
