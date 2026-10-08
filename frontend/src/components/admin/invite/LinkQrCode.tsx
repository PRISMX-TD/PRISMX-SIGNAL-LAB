// 链接二维码 + 下载。显示用 SVG；PNG 从一张隐藏的 1024px canvas 直接导出，不把 SVG
// 画进 canvas——Safari 旧版本把 SVG 图片画进 canvas 会污染画布，toBlob 直接抛错。
// 黑码白底、四周留白：深色主题的配色印出来扫不出来。
// QR + download. Display is SVG; the PNG comes from a hidden 1024px canvas instead of
// rasterising the SVG — older Safari taints a canvas that has an SVG image drawn on it.
// Black on white with a quiet zone: theme colours don't scan once printed.
// 下载的 SVG 与 PNG 用同样的 4 模块留白（扫码规范的 quiet zone）：屏幕上显示的那张外面
// 还包着一圈白底所以只留 2，下载用的是另一张隐藏的 marginSize=4 的 SVG。
// The downloaded SVG uses the same 4-module quiet zone as the PNG; the on-screen one
// sits in a white frame and keeps 2, so the download comes from a hidden copy.
import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { QRCodeCanvas, QRCodeSVG } from 'qrcode.react'

const EXPORT_PX = 1024

function triggerDownload(href: string, filename: string) {
  const a = document.createElement('a')
  a.href = href
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
}

export default function LinkQrCode({ url, filename }: { url: string; filename: string }) {
  const { t } = useTranslation()
  const svgRef = useRef<SVGSVGElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const downloadSvg = () => {
    const el = svgRef.current
    if (!el) return
    const clone = el.cloneNode(true) as SVGSVGElement
    clone.removeAttribute('class')
    clone.removeAttribute('aria-hidden')
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    clone.setAttribute('width', String(EXPORT_PX))
    clone.setAttribute('height', String(EXPORT_PX))
    const blob = new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' })
    const href = URL.createObjectURL(blob)
    triggerDownload(href, `${filename}.svg`)
    window.setTimeout(() => URL.revokeObjectURL(href), 1000)
  }

  const downloadPng = () => {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.toBlob((blob) => {
      if (!blob) return
      const href = URL.createObjectURL(blob)
      triggerDownload(href, `${filename}.png`)
      window.setTimeout(() => URL.revokeObjectURL(href), 1000)
    }, 'image/png')
  }

  return (
    <div className="flex items-center gap-4">
      <div className="shrink-0 rounded-xl bg-white p-1.5">
        <QRCodeSVG value={url} size={128} level="M" marginSize={2} bgColor="#ffffff" fgColor="#000000" />
      </div>
      <QRCodeSVG
        ref={svgRef}
        value={url}
        size={EXPORT_PX}
        level="M"
        marginSize={4}
        bgColor="#ffffff"
        fgColor="#000000"
        className="hidden"
        aria-hidden
      />
      <QRCodeCanvas
        ref={canvasRef}
        value={url}
        size={EXPORT_PX}
        level="M"
        marginSize={4}
        bgColor="#ffffff"
        fgColor="#000000"
        className="hidden"
        aria-hidden
      />
      <div className="flex flex-col gap-2">
        <button type="button" className="btn-ghost px-3 py-1.5 text-xs" onClick={downloadPng}>
          {t('admin.invite.qrPng')}
        </button>
        <button type="button" className="btn-ghost px-3 py-1.5 text-xs" onClick={downloadSvg}>
          {t('admin.invite.qrSvg')}
        </button>
      </div>
    </div>
  )
}
