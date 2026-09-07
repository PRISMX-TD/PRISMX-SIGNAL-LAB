// 榜面上的名字 → 公开主页链接（2026-09-07）。榜单行、比赛名次梯、冠军块、上期
// 冠军芯片都经这里：有 profileId 就渲染成 Link，没有（旧后端响应 / 用户已不存在）
// 就退回普通 span，调用方不用各自判空。
// Board names → public-profile links (2026-09-07). Leaderboard rows, competition
// ladders, champion blocks and the previous-winner chip all go through this: a
// Link when profileId is present, a plain span otherwise (older backend payload /
// deleted user), so callers never branch on it themselves.
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'

interface Props {
  profileId?: string | null
  className?: string
  children: ReactNode
}

export default function ProfileLink({ profileId, className, children }: Props) {
  if (!profileId) return <span className={className}>{children}</span>
  return (
    <Link
      to={`/u/${encodeURIComponent(profileId)}`}
      className={`${className ?? ''} decoration-white/30 underline-offset-2 hover:underline`.trim()}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </Link>
  )
}
