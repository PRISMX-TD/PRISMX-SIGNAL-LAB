// 后台幸运轮盘「期列表」的纯逻辑（v2 多期）：列表分组、默认选中、时间输入框换算、新建 / 编辑表单校验、
// 编辑只发改过的字段、删除前核对期名。放在 .ts 里是因为仓库没有 DOM 测试环境。
// 时间：后端是不带 Z 的 naive UTC，输入框是管理员浏览器本地时区；输入框旁另用 fmtTime 显示用户端看到的
// 时间（站点按 UTC+8 显示），两边对得上才不会设错期。
// Pure logic for the admin round list (v2, several rounds): grouping, default selection, datetime-input
// conversion, create / edit validation, sending only changed fields, and the delete name check. Kept in
// .ts because the repo has no DOM test environment. Times: the API is naive UTC (no Z) while the inputs
// are in the admin's browser zone; fmtTime next to them shows what users will see (the site shows UTC+8).
import type { LuckyMode, LuckyRoundAdmin, LuckyRoundPatch } from '../../../api/luckyTypes'
import { fmtTime, parseTime } from '../../../api/utils'

export const NAME_MAX = 40

/** 未结束的在前、已结束的在后（后端已排好序，这里只分组）/ Open rounds first, ended after (the backend already sorts). */
export function splitRounds(rounds: LuckyRoundAdmin[]): { open: LuckyRoundAdmin[]; ended: LuckyRoundAdmin[] } {
  return { open: rounds.filter((r) => r.phase !== 'ended'), ended: rounds.filter((r) => r.phase === 'ended') }
}

/** 选中的期还在就保留，否则选第一个未结束的期，再否则第一期 / Keep the selection if listed, else the first open round, else the first. */
export function keepSelection(rounds: LuckyRoundAdmin[], current: string | null): string | null {
  if (current && rounds.some((r) => r.id === current)) return current
  return (rounds.find((r) => r.phase !== 'ended') ?? rounds[0])?.id ?? null
}

/** 用接口返回的期替换列表里的同一期（PATCH / end 多带的 voided 去掉）/ Swap the returned round into the list (dropping `voided`). */
export function replaceRound(rounds: LuckyRoundAdmin[], next: LuckyRoundAdmin & { voided?: number }): LuckyRoundAdmin[] {
  const round = { ...next }
  delete round.voided
  return rounds.some((r) => r.id === round.id) ? rounds.map((r) => (r.id === round.id ? round : r)) : [round, ...rounds]
}

// API 字符串（naive UTC）→ datetime-local 值（浏览器本地时区）。必须经 parseTime 补 Z，直接 new Date 会按本地时间解析。
// API string (naive UTC) -> datetime-local value (browser-local). Goes through parseTime, which adds
// the missing Z; a bare new Date(iso) would read it as local time.
export function toLocalInput(iso?: string | null): string {
  const d = parseTime(iso)
  if (!d || Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}
export const localValid = (v: string) => !!v && !Number.isNaN(new Date(v).getTime())
export const fromLocalInput = (v: string) => new Date(v).toISOString()
// 输入框当前值在站点时区下的样子；空或非法返回空串 / the input's value as the site shows it; '' if empty or invalid
export const shown = (v: string) => (localValid(v) ? fmtTime(fromLocalInput(v)) : '')

export interface RoundForm { name: string; start: string; end: string; mode: LuckyMode }
export type RoundFormProblem = 'name' | 'nameLong' | 'start' | 'end' | 'order' | 'past'

/**
 * 新建 / 编辑表单的问题（只给第一条）。新建：结束必须晚于现在；编辑：结束改到过去 = 立即结束，
 * 允许但由调用方二次确认，所以不报错。
 * The first problem with the create / edit form. Creating needs an end in the future; editing allows
 * an end in the past (= end now), which the caller confirms instead.
 */
export function roundFormProblem(f: RoundForm, nowMs: number, editing = false): RoundFormProblem | null {
  const name = f.name.trim()
  if (!name) return 'name'
  if (name.length > NAME_MAX) return 'nameLong'
  if (!localValid(f.start)) return 'start'
  if (!localValid(f.end)) return 'end'
  if (new Date(f.end).getTime() <= new Date(f.start).getTime()) return 'order'
  if (!editing && new Date(f.end).getTime() <= nowMs) return 'past'
  return null
}

/** 结束时间已到 / 已过（编辑时要先确认会作废未用券）/ The end is now or past (editing confirms the voiding first). */
export const endsInPast = (end: string, nowMs: number) => localValid(end) && new Date(end).getTime() <= nowMs

/**
 * 编辑只发改过的字段；开始时间只有未开始的期能改。没改任何东西返回 null。
 * Editing sends only what changed; the start can only move while the round is upcoming. Null when nothing changed.
 */
export function roundPatch(orig: LuckyRoundAdmin, f: RoundForm): LuckyRoundPatch | null {
  const out: LuckyRoundPatch = {}
  if (f.name.trim() !== orig.name) out.name = f.name.trim()
  if (orig.phase === 'upcoming' && localValid(f.start) && f.start !== toLocalInput(orig.startsAt)) out.startsAt = fromLocalInput(f.start)
  if (localValid(f.end) && f.end !== toLocalInput(orig.endsAt)) out.endsAt = fromLocalInput(f.end)
  return Object.keys(out).length ? out : null
}

/** 删除前要求输入的期名与原名完全一致（只去掉两端空白）/ The typed name must match exactly (outer whitespace aside). */
export const deleteNameMatches = (typed: string, name: string) => typed.trim() !== '' && typed.trim() === name.trim()

/** 顶部指标条：进行中 / 未开始的期数，与所有期合计的已发券、已使用 / KPI strip: active / upcoming counts and issued / used summed over every round. */
export function roundKpis(rounds: LuckyRoundAdmin[]): { active: number; upcoming: number; issued: number; used: number } {
  return rounds.reduce((a, r) => ({
    active: a.active + (r.phase === 'active' ? 1 : 0),
    upcoming: a.upcoming + (r.phase === 'upcoming' ? 1 : 0),
    issued: a.issued + r.stats.issued,
    used: a.used + r.stats.used,
  }), { active: 0, upcoming: 0, issued: 0, used: 0 })
}

/** 已使用占已发券的比例（0–1），没发过券是 0 / Used over issued (0–1); 0 when nothing was issued. */
export const usedRatio = (s: { issued: number; used: number }) => (s.issued > 0 ? Math.min(1, Math.max(0, s.used / s.issued)) : 0)
