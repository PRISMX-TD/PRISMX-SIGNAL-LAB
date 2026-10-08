// 分数按正负上色：收益率会为负，胜率恒为正，同一条规则两边都对。
// Score coloured by sign: a return can be negative, a win rate never is, and one
// rule covers both.
import BadgeIcon from '../badges/BadgeIcon'
import { fmtScorePct } from '../../api/utils'

export function ScoreText({ score, className = '' }: { score: number; className?: string }) {
  return (
    <b className={`num ${score < 0 ? 'text-down' : 'text-up'} ${className}`}>{fmtScorePct(score)}</b>
  )
}

export function badgeOf(id: string | null | undefined, tier?: number | null) {
  return id ? <BadgeIcon id={id} tier={tier ?? 0} earned size={18} /> : null
}
