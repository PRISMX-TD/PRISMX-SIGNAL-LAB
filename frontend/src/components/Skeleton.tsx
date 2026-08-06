// 轻量骨架屏：数据加载时用贴合布局的低对比占位替代全屏 spinner，
// 加载完成后由页面内容的 .content-fade 柔和淡入。纯展示组件，无状态、无逻辑。
// Lightweight skeletons: layout-shaped, low-contrast placeholders that replace
// full-screen spinners during data loads; resolved content eases in via
// .content-fade. Pure presentational components — no state, no logic.
import type { CSSProperties } from 'react'

type BaseProps = {
  className?: string
  style?: CSSProperties
}

// 单行文本占位 / single text line
export function SkeletonLine({
  width = '100%',
  height = 12,
  className = '',
  style,
}: BaseProps & { width?: number | string; height?: number | string }) {
  return (
    <span
      className={`skeleton skeleton-line ${className}`}
      style={{ display: 'block', width, height, ...style }}
    />
  )
}

// 任意尺寸的方块占位 / arbitrary block
export function SkeletonBlock({
  width = '100%',
  height = 48,
  radius,
  className = '',
  style,
}: BaseProps & {
  width?: number | string
  height?: number | string
  radius?: number | string
}) {
  return (
    <span
      className={`skeleton ${className}`}
      style={{
        display: 'block',
        width,
        height,
        ...(radius != null ? { borderRadius: radius } : null),
        ...style,
      }}
    />
  )
}

// 卡片占位：模拟一张带标题 + 若干行的内容卡 / card with title + lines
export function SkeletonCard({
  lines = 3,
  className = '',
  style,
}: BaseProps & { lines?: number }) {
  return (
    <div className={`skeleton-card ${className}`} style={{ padding: 16, ...style }}>
      <SkeletonLine width="42%" height={16} />
      <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {Array.from({ length: lines }).map((_, i) => (
          <SkeletonLine key={i} width={i === lines - 1 ? '70%' : '100%'} />
        ))}
      </div>
    </div>
  )
}

// 页面级默认骨架：一屏几张卡，适合大多数列表/仪表盘页的首屏加载。
// Page-level default skeleton: a screenful of cards, fits most list/dashboard loads.
export function SkeletonPage({ cards = 3 }: { cards?: number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {Array.from({ length: cards }).map((_, i) => (
        <SkeletonCard key={i} lines={i === 0 ? 4 : 3} />
      ))}
    </div>
  )
}
