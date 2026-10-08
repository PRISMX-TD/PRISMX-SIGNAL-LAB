// ── 名次梯 ──
// 名次是 54px 的描边巨型数字，只有第一名填成金色；每行一根按分数比例的细线
// （负数红色），分数 24px 在最右。表格把冠军和第八名画得一样重，这个不会。
// The ladder: ranks as 54px outlined giants, only #1 filled gold; a thin bar per row
// proportional to the score (red when negative), the score at 24px on the right. A
// table draws the champion and the eighth place with equal weight; this doesn't.
//
// 行是视图模型：名字是 ReactNode——站内页传 <ProfileLink>，公开页传纯文本（公开页不能
// 链到 /u/:id，那是登录后的路由）。本文件不 import ProfileLink / useLive / Layout。
// Rows are a view model: the name is a ReactNode — the in-app page passes a
// <ProfileLink>, the public page plain text (/u/:id is a signed-in route). This file
// must not import ProfileLink / useLive / Layout.
import type { ReactNode } from 'react'
import { ScoreText, badgeOf } from './ScoreText'

export interface LadderRowView {
  key: string
  rank: number
  name: ReactNode
  // 名字下面的灰字：站内是打码账户号，公开页是平仓笔数。
  // The grey line under the name: masked login in-app, closed-trade count on the public page.
  sub?: ReactNode
  score: number
  isSelf?: boolean
  badgeId?: string | null
  badgeTier?: number | null
}

export default function Ladder({ rows, emptyText, youTag }: { rows: LadderRowView[]; emptyText: string; youTag?: string }) {
  if (rows.length === 0) {
    return (
      <div className="cmp-empty">
        <p>{emptyText}</p>
      </div>
    )
  }
  const maxAbs = Math.max(...rows.map((r) => Math.abs(r.score)), 1e-9)
  return (
    <ol className="cmp-ladder">
      {rows.map((row) => (
        <li key={row.key} className={row.isSelf ? 'is-self' : ''}>
          <span className="cmp-ladder-rank">{String(row.rank).padStart(2, '0')}</span>
          <div className="cmp-ladder-who">
            <b>
              {badgeOf(row.badgeId, row.badgeTier)}
              {row.name}
              {row.isSelf && youTag && <span className="cmp-you">{youTag}</span>}
            </b>
            {row.sub != null && <span className="num">{row.sub}</span>}
          </div>
          <i
            className={`cmp-ladder-bar ${row.score < 0 ? 'is-neg' : ''}`}
            style={{ width: `${Math.max(2, (Math.abs(row.score) / maxAbs) * 100)}%` }}
            aria-hidden
          />
          <ScoreText score={row.score} className="cmp-ladder-score" />
        </li>
      ))}
    </ol>
  )
}
