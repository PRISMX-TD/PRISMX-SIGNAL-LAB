// 品牌 Logo / Brand logo mark
// 透明底，无背景色，直接展示 logo.png
// Transparent, no background — logo.png rendered as-is.
//
// 节日期间在上面叠一层彩蛋（festival/LogoOrnament），Logo 本身不变。
// In festival windows an ornament is layered on top; the logo itself is unchanged.
import LogoOrnament from '../festival/LogoOrnament'

export default function Logo({ size = 40 }: { size?: number }) {
  return (
    <span
      className="relative inline-flex items-center justify-center"
      style={{ width: size, height: size }}
      aria-hidden
    >
      <img
        src="/logo.png"
        alt=""
        width={size}
        height={size}
        className="h-full w-full object-contain"
        draggable={false}
      />
      <LogoOrnament />
    </span>
  )
}
