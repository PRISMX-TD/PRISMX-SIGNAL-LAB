// 品牌 Logo / Brand logo mark
// 纯黑圆角底 + 品牌 logo 图片（信号实验室霓虹烧杯），等比内缩显示。
// Pure-black rounded base + the brand logo image (Signal Lab neon flask),
// contained and centered.
export default function Logo({ size = 32 }: { size?: number }) {
  return (
    <span
      className="inline-flex items-center justify-center overflow-hidden rounded-[22%] bg-black"
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
