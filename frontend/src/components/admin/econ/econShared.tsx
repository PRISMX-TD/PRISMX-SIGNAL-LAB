// 财经日历的共用小工具：管理台日历页和仪表盘「今日财经」卡片都用。
// Shared calendar helpers for the admin calendar and the dashboard today card.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { EconGroup, EconValue } from '../../../api/econTypes'
import { measureZh, releaseZh } from './econNamesZh'

export function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function addDays(d: Date, n: number): Date {
  const x = new Date(d)
  x.setDate(x.getDate() + n)
  return x
}

/** 这一周的周日（和 Forex Factory 一样周日开始）/ the Sunday that starts this week, like FF */
export function weekStartOf(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  return addDays(x, -x.getDay())
}

export function filled(v: number | string | null | undefined): boolean {
  return v !== null && v !== undefined && v !== ''
}

/** 到某一时刻的倒计时，自己每秒走一次，不带动父组件重渲染。超过一天显示「几天几小时」。
 *  Countdown to a moment; ticks on its own so the parent does not re-render. Days and hours past 24h. */
export function Countdown({ to, className }: { to: number; className?: string }) {
  const { t } = useTranslation()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])
  const s = Math.max(0, Math.floor((to - now) / 1000))
  const pad = (n: number) => String(n).padStart(2, '0')
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  return (
    <span className={className}>
      {d > 0 ? t('econ.countdownDays', { d, h }) : `${pad(h)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`}
    </span>
  )
}

export function dayKey(g: EconGroup): string {
  return g.at ? ymd(new Date(g.at)) : (g.date ?? '')
}

// Narwhal 的数值有时是字符串（"3.5"），先转成数字；转不了就原样显示。
// Narwhal sometimes sends figures as strings ("3.5"); coerce, else show as-is.
export function fmtNum(raw: number | string | null | undefined, unit?: string | null): string {
  if (raw === null || raw === undefined || raw === '') return ''
  const v = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(v)) return String(raw)
  const s = Number.isInteger(v) ? String(v) : String(Number(v.toFixed(4)))
  return unit === 'percent' || unit === '%' ? `${s}%` : s
}

// 指标 id → 可读名：employment_change → Employment Change，cpi_yoy → CPI y/y
// Measure id → readable name.
const UPPER = new Set([
  'cpi',
  'ppi',
  'gdp',
  'pmi',
  'pce',
  'hicp',
  'ism',
  'zew',
  'ifo',
  'nfp',
  'rpi',
  'uom',
  'anz',
  'nab',
  'kof',
  'cbi',
  'adp',
])
const SUFFIX: Record<string, string> = {
  yoy: 'y/y',
  mom: 'm/m',
  qoq: 'q/q',
  ann: '(ann.)',
  sa: '(s.a.)',
  '3m': '3m',
}
function humanize(measure: string): string {
  return measure
    .split('_')
    .map((w) => SUFFIX[w] ?? (UPPER.has(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ')
}

// 表里列哪几项：有预期值的（Forex Factory 也只列有预测的），主指标排第一；都没有就只列主指标，
// 再没有就一行发布名。/ Rows: measures with a consensus (primary first); else the primary; else the release name.
function shownValues(g: EconGroup): EconValue[] {
  const withCons = g.values.filter((v) => v.consensus !== null && v.consensus !== undefined && v.consensus !== '')
  const primary = g.values.find((v) => v.measure === g.primaryMeasure)
  const list = withCons.length ? withCons : primary ? [primary] : []
  return [...list].sort((a, b) => (a.measure === g.primaryMeasure ? -1 : b.measure === g.primaryMeasure ? 1 : 0))
}

export type Row = { label: string; v: EconValue | null; importance: number }

export function rowsOf(g: EconGroup, zh: boolean, levels?: ReadonlySet<number>): Row[] {
  const c = g.preview?.status === 'ok' ? g.preview.content : null
  const values = shownValues(g)
  const rows: Row[] = values.length
    ? values.map((v) => ({
        // 中文界面：固定对照表优先（同一个指标处处同名），其次 AI 预案给的名字，最后英文
        // Chinese UI: the fixed table first (one name everywhere), then the AI preview's name, then English
        label: (zh && (measureZh(v.measure) || c?.names_zh[v.measure])) || humanize(v.measure),
        v,
        importance: v.importance ?? g.importance,
      }))
    : [
        {
          label:
            (c && (zh ? c.title_zh : c.title_en)) ||
            [...new Set(g.releases.map((r) => (zh && releaseZh(r.name)) || r.name))].join(' · '),
          v: null,
          importance: g.importance,
        },
      ]
  return levels ? rows.filter((r) => levels.has(Math.max(1, r.importance))) : rows
}

export function isPast(g: EconGroup, now: number): boolean {
  if (g.at) return new Date(g.at).getTime() <= now
  return !!g.date && g.date < ymd(new Date(now))
}

export function Impact({ n }: { n: number }) {
  // Forex Factory 的三色：黄 / 橙 / 红 / Forex Factory's yellow / orange / red
  const color = n >= 3 ? 'bg-[#e8322b]' : n >= 2 ? 'bg-[#f7941d]' : n >= 1 ? 'bg-[#f5d90a]' : 'bg-neutral-600'
  return <span className={`inline-block h-3.5 w-2.5 rounded-sm align-middle ${color}`} aria-label={`importance ${n}`} />
}
