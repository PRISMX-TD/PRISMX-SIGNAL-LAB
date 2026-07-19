// 品牌 Logo / Brand logo mark
// 透明底，无背景色，直接展示 logo.png
// Transparent, no background — logo.png rendered as-is.
export default function Logo({ size = 40 }: { size?: number }) {
  return (
    <span
      className="inline-flex items-center justify-center"
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
    </span>
  )
}
