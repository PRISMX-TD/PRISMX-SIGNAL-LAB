// 系统状态：后端、数据库、Redis、gateway、行情、信号、后台任务、在线情况各一盏灯，每盏灯旁边
// 直接写「现在该怎么做」，下面是一张「遇到问题怎么办」速查表。给不懂技术的管理员用：
// 看灯 → 照着做 → 标着「找 Rex」的不碰。口径见 backend services/system_status.py。
//
// 后端挂了这一页照样打得开（前端托管在 Vercel），所以「读不到后端」本身就是一条结论：
// 显示看门狗会自动重启、等几分钟、超过 5 分钟找人。
//
// System status for non-technical admins: one light per component with what to
// do next, plus a runbook. The page is served by Vercel, so it still loads when
// the backend is down — and "can't reach the backend" is itself the verdict.
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { adminApi, ApiHttpError } from '../../api/client'
import type { AdminSystemStatus, HealthComponent, HealthLevel, HealthLoopRow } from '../../api/types'
import { SkeletonLine } from '../Skeleton'

const REFRESH_MS = 15_000

const COMPONENT_ORDER = ['backend', 'database', 'redis', 'gateway', 'feed', 'signals', 'loops', 'online'] as const
type ComponentKey = (typeof COMPONENT_ORDER)[number]

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
  if (c.error) return c.error
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

function Light({ level }: { level: HealthLevel }) {
  return (
    <span className="relative flex h-3 w-3 shrink-0">
      {level === 'down' && <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${DOT.down}`} />}
      <span className={`relative inline-flex h-3 w-3 rounded-full ${DOT[level]}`} />
    </span>
  )
}

function ComponentCard({ k, c }: { k: ComponentKey; c: HealthComponent }) {
  const { t } = useTranslation()
  const facts = factsLine(t, k, c)
  return (
    <div className={`rounded-inner border bg-white/[0.02] p-4 ${BORDER[c.level]}`}>
      <div className="flex items-center gap-2">
        <Light level={c.level} />
        <span className="text-sm font-semibold text-white">{t(`admin.health.comp.${k}.name`)}</span>
        <span className={`ml-auto text-xs font-medium ${TEXT[c.level]}`}>{t(`admin.health.level.${c.level}`)}</span>
      </div>
      {facts && <p className="mt-2 break-words text-xs tabular-nums text-neutral-400">{facts}</p>}
      <p className={`mt-2 text-xs leading-relaxed ${c.level === 'down' ? 'text-neutral-100' : 'text-neutral-400'}`}>
        {hintFor(t, k, c.level)}
      </p>
    </div>
  )
}

function LoopTable({ rows }: { rows: HealthLoopRow[] }) {
  const { t } = useTranslation()
  if (rows.length === 0) return null
  return (
    <div className="glass mb-5 overflow-x-auto p-5">
      <h3 className="mb-3 text-sm font-semibold text-white">{t('admin.health.loopTable.title')}</h3>
      <table className="w-full min-w-[520px] text-left text-xs">
        <thead className="text-neutral-500">
          <tr>
            <th className="pb-2 font-medium">{t('admin.health.loopTable.name')}</th>
            <th className="pb-2 font-medium">{t('admin.health.loopTable.status')}</th>
            <th className="pb-2 font-medium">{t('admin.health.loopTable.lastRun')}</th>
            <th className="pb-2 font-medium">{t('admin.health.loopTable.lastError')}</th>
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
                <td className="py-2 pr-3">
                  <span className="flex items-center gap-1.5">
                    <Light level={r.level} />
                    <span className={TEXT[r.level]}>{t(`admin.health.level.${r.level}`)}</span>
                  </span>
                </td>
                <td className="num py-2 pr-3 text-neutral-300">
                  {r.beatAgoSec == null
                    ? t('admin.health.loopTable.never')
                    : t('admin.health.ago', { t: fmtDuration(t, r.beatAgoSec) })}
                </td>
                <td className="py-2 text-neutral-400">
                  {r.crashMessage ? (
                    <span className="text-down">{t('admin.health.loopTable.crashed', { msg: r.crashMessage })}</span>
                  ) : r.errorMessage ? (
                    <>
                      <span className="num text-neutral-300">{t('admin.health.ago', { t: fmtDuration(t, r.errorAgoSec) })}</span>
                      <div className="mt-0.5 line-clamp-2 break-all text-neutral-500" title={r.errorMessage}>{r.errorMessage}</div>
                    </>
                  ) : (
                    t('admin.health.loopTable.none')
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
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
  const alive = useRef(true)

  const load = useCallback(() => {
    setLoading(true)
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
  }, [])

  useEffect(() => {
    alive.current = true
    load()
    const id = window.setInterval(load, REFRESH_MS)
    return () => { alive.current = false; window.clearInterval(id) }
  }, [load])

  // 读不到后端时，整体结论就是「异常」，不管上一份数据怎么说。
  const overall: HealthLevel | null = unreachable !== null ? 'down' : data?.overall ?? null
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

      {unreachable !== null && (
        <div className="mb-5 rounded-inner border border-down/50 bg-down/10 p-4" role="alert">
          <div className="flex items-center gap-2">
            <Light level="down" />
            <span className="text-sm font-semibold text-down">{t('admin.health.unreachable.title')}</span>
          </div>
          <p className="mt-2 text-sm leading-relaxed text-neutral-100">{t('admin.health.unreachable.body')}</p>
          {unreachable && <p className="mt-1 text-xs text-neutral-500">{t('admin.health.unreachable.detail', { msg: unreachable })}</p>}
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
            {COMPONENT_ORDER.map((k) => data.components[k] && <ComponentCard key={k} k={k} c={data.components[k]} />)}
          </div>
          <LoopTable rows={data.loops} />
        </div>
      )}

      <Runbook />
    </div>
  )
}
