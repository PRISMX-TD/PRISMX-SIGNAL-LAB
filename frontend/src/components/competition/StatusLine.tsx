// 状态行：状态芯片 + 计分口径 / 赛道 / 参赛方式，发丝线隔开。列表、详情、公开页共用。
// The status line: status pill plus metric / track / enrollment, hairline-separated.
// Shared by the list, the detail and the public page.
import type { TFunction } from 'i18next'
import type { CompetitionSummary } from '../../api/types'

export const STATUS_TAG_CLASS: Record<string, string> = {
  upcoming: 'bg-neutral-500/15 text-neutral-400',
  regOpen: 'bg-prism-600/20 text-prism-300',
  running: 'bg-up/15 text-up',
  finished: 'bg-neutral-500/15 text-neutral-400',
  // 结算态此前用 Tailwind 原生 blue-*，是全站状态色里唯一一个外来色相——设计
  // 令牌写明「紫是整页唯一的彩度」，neon.cyan 等旧键也早已去霓虹化。结算是
  // 「已封存、不再变动」，语义上就是中性档，与 finished 同族但更亮一级以示区分。
  // The settled tag used stock Tailwind blue-*, the only foreign hue among the
  // status colours, against a token set that states violet is the page's only
  // chroma. Settled means sealed and final, which is semantically the neutral
  // band — same family as finished, one step brighter to stay distinguishable.
  settled: 'bg-neutral-300/15 text-neutral-300',
}

export default function StatusLine({ c, tagKey, t }: {
  c: Pick<CompetitionSummary, 'metric' | 'track' | 'enrollment'>
  tagKey: string
  t: TFunction
}) {
  const live = tagKey === 'running' || tagKey === 'regOpen'
  return (
    <div className="cmp-kicker">
      <span className={`cmp-status-tag ${STATUS_TAG_CLASS[tagKey] ?? ''}`}>
        {live && <i className="cmp-live-dot" aria-hidden />}
        {t(`competition.status.${tagKey}`)}
      </span>
      <span>{t(`leaderboard.boards.${c.metric}`)}</span>
      <span>{t(`competition.track.${c.track}`)}</span>
      <span>{t(`competition.enrollment.${c.enrollment}`)}</span>
    </div>
  )
}
