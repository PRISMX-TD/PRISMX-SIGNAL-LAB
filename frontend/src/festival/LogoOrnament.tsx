// Logo 彩蛋 / logo ornament
//
// 原 Logo 一个像素不动，只在上面叠一层节日小装饰。Logo 在全站出现十几处（顶栏、
// 落地页、登录页、手机样机里），全部自动带上，不需要逐页接。
// The logo itself is untouched; a small festival ornament is layered on top.
// The logo appears in a dozen places (header, landing, login, the phone mockup)
// and every one picks the ornament up without per-page wiring.
import { useMemo, useRef } from 'react'
import { useFestivalOptional } from './FestivalProvider'
import { ornament } from './art'
import { poke } from './motion'
import SvgArt from './SvgArt'
import './festival.css'

export default function LogoOrnament() {
  const f = useFestivalOptional()
  const key = f ? f.festival : null
  const html = useMemo(() => (key ? ornament(key) : ''), [key])
  const el = useRef<HTMLSpanElement | null>(null)

  if (!f || !key || !html) return null

  return (
    <span
      className="fa-logo-ornament"
      // 鼠标移到 Logo 上，彩蛋回应一下（帽子一跳、灯笼一荡）。父级 Logo 的
      // aria-hidden 已覆盖读屏，这里只是指针反馈。
      // Hovering the logo makes the ornament react (the hat hops, the lantern
      // swings). The parent logo is aria-hidden; this is pointer feedback only.
      onPointerEnter={() => el.current && poke(el.current, key, f.reducedMotion)}
      style={{ pointerEvents: 'auto' }}
    >
      <SvgArt
        html={html}
        surface="ornament"
        artKey={key}
        reduced={f.reducedMotion}
        replay={f.replay}
        onRef={(n) => (el.current = n)}
        style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }}
      />
    </span>
  )
}
