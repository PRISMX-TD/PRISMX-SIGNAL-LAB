// 插画挂载点 + 入场动画 / illustration host with its entrance
import { memo, useEffect, useRef, type CSSProperties } from 'react'
import type { ArtKey } from './art'
import { playEntrance, type Surface } from './motion'

interface Props {
  html: string
  className?: string
  style?: CSSProperties
  // 给了 surface 就在挂载（以及 replay 变化）时播入场。
  // With a surface, the entrance plays on mount and whenever `replay` changes.
  surface?: Surface
  artKey?: ArtKey
  reduced?: boolean
  replay?: number
  onRef?: (el: HTMLSpanElement | null) => void
}

function SvgArtImpl({ html, className, style, surface, artKey, reduced = false, replay = 0, onRef }: Props) {
  const ref = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el || !surface || !artKey) return
    return playEntrance(el, surface, artKey, reduced)
  }, [html, surface, artKey, reduced, replay])

  return (
    <span
      ref={(el) => {
        ;(ref as { current: HTMLSpanElement | null }).current = el
        if (onRef) onRef(el)
      }}
      className={'fa-art ' + (className || '')}
      style={style}
      aria-hidden
      // 内容全部来自 art.ts 的常量，没有外部输入。
      // Every byte comes from constants in art.ts; there is no external input.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

export default memo(SvgArtImpl)
