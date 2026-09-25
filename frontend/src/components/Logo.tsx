// 品牌 Logo / Brand logo mark
// 透明底，无背景色，直接展示 logo（缩小版，见下）
// Transparent, no background — the logo rendered as-is (downscaled, see below).
//
// 节日期间在上面叠一层彩蛋（festival/LogoOrnament），Logo 本身不变。
// In festival windows an ornament is layered on top; the logo itself is unchanged.
//
// 图片用缩小版 logo-128.png / logo-256.png（从 826px、656 KB 的 logo.png 等比导出，
// 8 KB / 25 KB，调色板 PNG——同尺寸下比带透明通道的 WebP 还小，且 Safari 12/13 也认）。
// 实际显示 26–72px，按 sizes 声明的 CSS 尺寸 × DPR 由浏览器挑：3x 屏 72px 也只要 216px。
// 正方形等比缩放，LogoOrnament 的 0–100 坐标系照旧对齐 logo 方框。
// logo.png 原图保留（manifest / og / 邮件等外部引用可能仍在用）。
// Uses the downscaled logo-128.png / logo-256.png (square, exported from the 826px
// 656 KB original; palette PNGs at 8 KB / 25 KB, smaller than alpha WebP here and
// supported by Safari 12/13). Displayed at 26–72px; the browser picks via sizes × DPR.
// Aspect ratio unchanged, so LogoOrnament's 0–100 box still lines up.
export const LOGO_SRC = '/logo-128.png'
export const LOGO_SRCSET = '/logo-128.png 128w, /logo-256.png 256w'
import LogoOrnament from '../festival/LogoOrnament'

export default function Logo({ size = 40 }: { size?: number }) {
  return (
    <span
      className="relative inline-flex items-center justify-center"
      style={{ width: size, height: size }}
      aria-hidden
    >
      <img
        src={LOGO_SRC}
        srcSet={LOGO_SRCSET}
        sizes={`${size}px`}
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
