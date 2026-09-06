// frontend/src/components/badges/BadgeIcon.tsx
// 铸币勋章：真正的渲染在 medal.ts（纯函数，字符串拼 SVG，见该文件顶部关于为什么
// 不用 JSX 的说明）；这里只是把它接进 React——用 useId() 给这枚勋章的渐变/裁剪
// id 一个稳定且跨枚不冲突的前缀，用 dangerouslySetInnerHTML 把内层标记灌进去
//（安全性同样在 medal.ts 里说明过：markup 全静态、不含用户输入）。
//
// 2026-09-07 改制：材质不再由「稀有度」决定，而由**档位**决定——进阶勋章铜 /
// 银 / 金，独立勋章各有固定材质（materialOf）。调用方传 tier（榜单行、比赛行
// 用后端随行下发的 equippedBadgeTier），不再需要前端镜像表。
//
// Minted-medal badges: the actual rendering lives in medal.ts (a pure function
// that string-builds SVG; see that file's header for why not JSX). This
// component wires it into React — useId() gives this badge's gradient/clip ids
// a stable prefix, and dangerouslySetInnerHTML splices in the inner markup (the
// safety case is made in medal.ts: fully static markup, no user input).
//
// 2026-09-07 overhaul: the material follows the **tier** (bronze / silver / gold
// for tiered badges, a fixed material for standalone ones — see materialOf), not
// a rarity. Callers pass the tier (board rows use the backend's per-row
// equippedBadgeTier), so no frontend mirror table is needed any more.
import { useEffect, useId, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { renderMedalInner } from './medal'

interface Props {
  id: string
  // 档位：1 铜 / 2 银 / 3 金；独立勋章或未获得传 0 / 不传。
  // Tier: 1 bronze / 2 silver / 3 gold; 0 / omitted for standalone or unearned.
  tier?: number | null
  earned: boolean
  size?: number
  // 环缘流光缓慢自转（16s 一圈）；仅头部佩戴展示用，勋章墙/榜单行都不传。
  // Slow 16s rim-sheen rotation; header "equipped" display only — the wall and
  // leaderboard rows don't pass it.
  spin?: boolean
  // 铸造瞬间：毛坯 → 压印 → 闪光 → 流光，见下方 effect 与全局 CSS 的
  // .badge-minting 关键帧。Mint moment: blank → strike → flash → sweep, see
  // the effect below and the .badge-minting keyframes in the global stylesheet.
  mint?: boolean
  className?: string
}

export default function BadgeIcon({ id, tier, earned, size = 56, spin, mint, className }: Props) {
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

  const inner = renderMedalInner(id, tier ?? 0, size, reactId, { earned, spin })
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
