// frontend/src/components/badges/BadgeIcon.tsx
// V5 铸币勋章：真正的渲染在 medal.ts（纯函数，字符串拼 SVG，见该文件顶部
// 关于为什么不用 JSX 的说明）；这里只是把它接进 React——用 useId() 给这枚
// 勋章的渐变/裁剪 id 一个稳定且跨枚不冲突的前缀，用 dangerouslySetInnerHTML
// 把内层标记灌进去（安全性同样在 medal.ts 里说明过：markup 全静态、不含用户
// 输入）。对外接口保持 { id, rarity, earned, size } 不变，四个既有调用点
// （AchievementsPage 56、LeaderboardPage 20、CompetitionsPage 20、
// GamificationPanel 40）不用改一行；新增的 spin/mint/className 是可选项。
//
// V5 minted-medal badges: the actual rendering lives in medal.ts (a pure
// function that string-builds SVG; see that file's header for why not
// JSX). This component just wires it into React — useId() gives this
// badge's gradient/clip ids a stable prefix that won't collide with other
// badges on the same page, and dangerouslySetInnerHTML splices in the inner
// markup (the safety case is made in medal.ts: the markup is fully static,
// no user input flows through it). The public props stay
// { id, rarity, earned, size } exactly as before, so the four existing call
// sites (AchievementsPage 56, LeaderboardPage 20, CompetitionsPage 20,
// GamificationPanel 40) compile unchanged; spin/mint/className are new and
// optional.
import { useEffect, useId, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { renderMedalInner } from './medal'
import type { GamificationBadgeRarity } from '../../api/types'

interface Props {
  id: string
  rarity: GamificationBadgeRarity | string
  earned: boolean
  size?: number
  // 传说勋章的环缘流光缓慢自转（16s 一圈）；仅头部佩戴展示用，勋章墙/榜单
  // 行都不传。Slow 16s rim-sheen rotation for legendary/limited badges;
  // header "equipped" display only — the wall and leaderboard rows don't pass it.
  spin?: boolean
  // 铸造瞬间：毛坯 → 压印 → 闪光 → 流光，见下方 effect 与全局 CSS 的
  // .badge-minting 关键帧。Mint moment: blank → strike → flash → sweep, see
  // the effect below and the .badge-minting keyframes in the global stylesheet.
  mint?: boolean
  className?: string
}

export default function BadgeIcon({ id, rarity, earned, size = 56, spin, mint, className }: Props) {
  const { t } = useTranslation()
  const reactId = useId()
  const svgRef = useRef<SVGSVGElement>(null)

  // 铸造动画只播一次：svg 挂载时（毛坯态，.emb 被 CSS 压暗缩放）加一帧
  // setTimeout 后追加 .play 类触发关键帧——不用 requestAnimationFrame，因为
  // 后台标签页从不触发 rAF（用户切走标签再切回时动画会像是从没播过），而
  // 30ms 的 setTimeout 在后台标签页仍会（延迟地）执行，播放只是稍晚而不是
  // 从不播放。
  // The mint animation plays once: on mount (blank state, .emb dimmed/scaled
  // by CSS) a 30ms setTimeout adds the .play class to trigger the keyframes.
  // Not requestAnimationFrame — background tabs never fire rAF (switch away
  // and back, and the animation would look like it never played), whereas a
  // 30ms setTimeout still fires (just later) in a background tab, so it
  // plays late rather than never.
  useEffect(() => {
    if (!mint) return
    const svg = svgRef.current
    if (!svg) return
    const timer = setTimeout(() => svg.classList.add('play'), 30)
    return () => clearTimeout(timer)
  }, [mint])

  const inner = renderMedalInner(id, (rarity as GamificationBadgeRarity) ?? 'common', size, reactId, { earned, spin })
  const classes = [mint ? 'badge-minting' : null, className ?? null].filter(Boolean).join(' ')

  return (
    <svg
      ref={svgRef}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label={t(`gamification.badges.${id}.name`)}
      className={classes || undefined}
      style={earned ? undefined : { filter: 'grayscale(1) brightness(.72)', opacity: .42 }}
      dangerouslySetInnerHTML={{ __html: inner }}
    />
  )
}
