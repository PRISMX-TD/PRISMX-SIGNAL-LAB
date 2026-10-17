// 外包客服页面的半透明水印（设计 §8：账号昵称 + 日期）。文字由后端 /support/me 给，前端只负责铺满；
// pointer-events:none，不挡任何点击。截图外传时水印跟着走，这是它的全部用途。
// Semi-transparent watermark for outsourced agents (design §8: nickname + date). The text comes
// from /support/me; this only tiles it. pointer-events:none, so it never blocks a click. Its whole
// point is to travel with any screenshot that leaves the building.
import { useMemo } from 'react'

export default function Watermark({ text }: { text: string }) {
  const bg = useMemo(() => {
    const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="280" height="160">` +
      `<text x="20" y="100" transform="rotate(-22 140 80)" fill="rgba(255,255,255,0.07)" ` +
      `font-family="system-ui,sans-serif" font-size="15">${esc}</text></svg>`
    return `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}")`
  }, [text])
  return (
    <div
      aria-hidden="true"
      data-testid="support-watermark"
      className="pointer-events-none fixed inset-0 z-[65] select-none"
      style={{ backgroundImage: bg, backgroundRepeat: 'repeat' }}
    />
  )
}
