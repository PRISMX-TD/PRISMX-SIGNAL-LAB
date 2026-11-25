// 图表截图（工具条相机按钮 / Ctrl+Alt+S）：lightweight-charts 的 takeScreenshot 再在顶上加一条
// 「品种 · 周期 · 时间」抬头。网页直接下载 PNG（或复制到剪贴板）；App 走原生 SignalImage 插件
// 存进相册，旧安装包没有插件时返回 false，由调用方提示。截图只在本机生成，不上传。
// Chart screenshot (toolbar camera / Ctrl+Alt+S): lightweight-charts' takeScreenshot plus a
// "symbol · interval · time" header band. The web downloads a PNG (or copies it to the
// clipboard); the App saves to the gallery through the native SignalImage plugin and returns
// false on older APKs without it. Generated on the device only, never uploaded.
import type { IChartApi } from 'lightweight-charts'

export function composeScreenshot(chart: IChartApi, header: string, bg: string, fg: string): HTMLCanvasElement {
  const shot = chart.takeScreenshot(true, false)
  const dpr = shot.width / Math.max(1, chart.chartElement().clientWidth || shot.width)
  const band = Math.round(30 * dpr)
  const out = document.createElement('canvas')
  out.width = shot.width
  out.height = shot.height + band
  const ctx = out.getContext('2d')
  if (!ctx) return shot
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, out.width, out.height)
  ctx.fillStyle = fg
  ctx.font = `600 ${Math.round(13 * dpr)}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`
  ctx.textBaseline = 'middle'
  ctx.fillText(header, Math.round(12 * dpr), band / 2)
  ctx.drawImage(shot, 0, band)
  return out
}

const toBlob = (c: HTMLCanvasElement) => new Promise<Blob | null>((res) => c.toBlob(res, 'image/png'))

type NativeImage = { save(o: { base64: string; fileName?: string }): Promise<unknown> }
const nativeImage = () => (window as unknown as { Capacitor?: { Plugins?: { SignalImage?: NativeImage } } }).Capacitor?.Plugins?.SignalImage
const isApp = () => !!(window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.()

// 结果：'saved' 已存 / 'copied' 已复制 / 'unsupported' 本端不支持 / 'failed'
// Outcome: 'saved' / 'copied' / 'unsupported' / 'failed'
export type ShotResult = 'saved' | 'copied' | 'unsupported' | 'failed'

export async function saveScreenshot(canvas: HTMLCanvasElement, fileName: string): Promise<ShotResult> {
  try {
    if (isApp()) {
      const img = nativeImage()
      if (!img) return 'unsupported'
      await img.save({ base64: canvas.toDataURL('image/png'), fileName })
      return 'saved'
    }
    const blob = await toBlob(canvas)
    if (!blob) return 'failed'
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${fileName}.png`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 4000)
    return 'saved'
  } catch (e) {
    if ((e as { code?: string })?.code === 'UNSUPPORTED') return 'unsupported'
    return 'failed'
  }
}

export async function copyScreenshot(canvas: HTMLCanvasElement): Promise<ShotResult> {
  try {
    const CI = (window as unknown as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem
    if (!CI || !navigator.clipboard?.write) return 'unsupported'
    const blob = await toBlob(canvas)
    if (!blob) return 'failed'
    await navigator.clipboard.write([new CI({ 'image/png': blob })])
    return 'copied'
  } catch {
    return 'failed'
  }
}

export function canCopyImage(): boolean {
  return !isApp() && typeof window !== 'undefined' && 'ClipboardItem' in window && !!navigator.clipboard?.write
}
