// 公开比赛页的纯逻辑（设计 §4）：CTA 状态机、错误分类、载荷→名次梯视图、每会话一次的浏览打点。
// Pure logic for the public competition page: CTA state machine, error classification,
// payload → ladder view mapping, once-per-session view ping.
import { PublicHttpError } from '../api/publicCompetition'
import type { PublicCompetition, PublicCompetitionRow } from '../api/types'
import type { LadderRowView } from '../components/competition/Ladder'
import { regState } from './competitionTime'
import { readStorage, writeStorage } from './safeStorage'

export type PublicCta =
  | { kind: 'join' }
  | { kind: 'notOpen'; opensAt: string | null }
  | { kind: 'closed'; reason: 'closed' | 'ended'; next: string | null }

// 已结束/已终审 → 看最终榜 + 下一场（主推比赛，且不是自己）；报名窗口开着 → 注册参赛；
// 未开 → 告诉开放时间（仍可先注册、先开户）；其余（窗口已关、非报名制）→ 截止。
// Ended/settled → final board + the next (featured) competition, never itself; window
// open → sign up and enter; not open yet → the opening time (signing up / opening an
// account early is still fine); anything else (closed window, non-signup) → closed.
export function publicCta(
  c: Pick<PublicCompetition, 'id' | 'status' | 'enrollment' | 'regOpensAt' | 'regClosesAt' | 'nextCompetitionId'>,
  nowMs: number,
): PublicCta {
  if (c.status === 'ended' || c.status === 'settled') {
    const next = c.nextCompetitionId && c.nextCompetitionId !== c.id ? c.nextCompetitionId : null
    return { kind: 'closed', reason: 'ended', next }
  }
  const rs = regState(c, nowMs)
  if (rs === 'open') return { kind: 'join' }
  if (rs === 'notOpen') return { kind: 'notOpen', opensAt: c.regOpensAt }
  return { kind: 'closed', reason: 'closed', next: null }
}

export type PublicLoadError = 'notFound' | 'retry'

// 只有 404 是「不存在或未公开」（后端把草稿/未公开/总开关关都折成同一个 404）；
// 429、5xx、断网都是暂时的：保留屏幕上的数据，提示稍后刷新。
// Only a 404 means "missing or not public" (the backend folds draft / not public / switch
// off into one 404); 429, 5xx and network errors are transient: keep what's on screen.
export function classifyPublicError(err: unknown): PublicLoadError {
  return err instanceof PublicHttpError && err.status === 404 ? 'notFound' : 'retry'
}

// 公开榜：没有昵称（后端按 public_name / name_hidden / 退榜规则置 null）→「匿名选手」，
// 徽章也一并不显示（后端已置空，这里再兜一次）。名字是纯文本，不链到 /u/:id。
// Public board: a null name (the backend nulls it per public_name / name_hidden / opt-out)
// renders as "anonymous", badge dropped too (already nulled server-side; enforced again
// here). Names are plain text, never links to /u/:id.
export function publicLadderRows(
  rows: PublicCompetitionRow[],
  anonLabel: string,
  sampleLabel: (n: number) => string,
): LadderRowView[] {
  return rows.map((r, i) => {
    const name = r.displayName && r.displayName.trim() ? r.displayName : null
    return {
      key: `${r.rank}-${i}`,
      rank: r.rank,
      name: name ?? anonLabel,
      sub: sampleLabel(r.sample),
      score: r.score,
      isSelf: false,
      badgeId: name ? r.equippedBadge : null,
      badgeTier: name ? r.equippedBadgeTier : 0,
    }
  })
}

const VIEW_KEY = 'prismx.compView'

// 每个会话每场比赛只打一次 view（sessionStorage）。存储不可用时退化为每次加载都打，
// 后端按天聚合，多几次无伤大雅。
// One view ping per competition per session (sessionStorage). Without storage it degrades
// to one per load; the backend aggregates per day, so a few extra are harmless.
export function shouldSendView(
  compId: string,
  read: (k: string) => string | null = (k) => readStorage(k, 'session'),
  write: (k: string, v: string) => unknown = (k, v) => writeStorage(k, v, 'session'),
): boolean {
  const key = `${VIEW_KEY}:${compId}`
  if (read(key)) return false
  write(key, '1')
  return true
}
