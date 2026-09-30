// 管理员上传前在浏览器里把图缩小：最长边超过 1600px 就等比缩到 1600，再转 WebP。
//
// 后台上传的海报常常是设计稿导出的几 MB PNG，原样发给所有用户（登录弹窗第一张图）。
// 前端缩一次是零成本的，后端不必加图像库。规则都是「拿不准就传原文件」：
//   · GIF 不动（可能是动图，画布只会留第一帧）；
//   · 没有 createImageBitmap / canvas.toBlob（老 WebView）→ 原文件；
//   · 任何一步抛错 → 原文件；
//   · 结果没有比原文件小 → 原文件（已经压得很好的 JPEG / 小图）；
//   · 不支持 WebP 编码时：PNG 源图回落 PNG（保留透明通道，转 JPEG 会变黑底），JPEG 源图回落 JPEG。
// 后端 image_upload.py 的 magic bytes 判定本来就认 WebP，无需改动。
//
// Shrink an admin image in the browser before upload: longest side capped at 1600px, then
// re-encoded as WebP. Posters exported from design tools are often multi-megabyte PNGs that
// then go to every user, and doing it client-side costs nothing. Every doubt resolves to
// "send the original": GIFs are untouched (may be animated), missing createImageBitmap /
// toBlob or any thrown error means the original, and so does a result that is not smaller.
// Without WebP encoding a PNG source falls back to PNG (JPEG would turn transparency black).

export const MAX_EDGE = 1600

/** 等比缩放后的尺寸；不超过上限则原样。/ Size after proportional shrink; unchanged when within the cap. */
export function fitSize(width: number, height: number, max = MAX_EDGE): { width: number; height: number } {
  const longest = Math.max(width, height)
  if (!(longest > max)) return { width, height }
  const k = max / longest
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) }
}

const EXT: Record<string, string> = { 'image/webp': 'webp', 'image/png': 'png', 'image/jpeg': 'jpg' }

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((b) => resolve(b), type, quality)
    } catch {
      resolve(null)
    }
  })
}

export async function shrinkImage(file: File): Promise<File> {
  try {
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return file
    if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return file

    const bitmap = await createImageBitmap(file)
    const { width, height } = fitSize(bitmap.width, bitmap.height)
    const resized = width !== bitmap.width || height !== bitmap.height
    // 已经是 WebP 且不用缩：可能是动图，别碰 / a WebP that needs no resize may be animated: leave it
    if (file.type === 'image/webp' && !resized) {
      bitmap.close?.()
      return file
    }

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      bitmap.close?.()
      return file
    }
    ctx.drawImage(bitmap, 0, 0, width, height)
    bitmap.close?.()

    let blob = await toBlob(canvas, 'image/webp', 0.82)
    if (!blob) return file
    // 浏览器不支持 WebP 编码时 toBlob 会静默回落成 PNG，类型对不上就走回落分支
    // An engine without WebP encoding silently hands back a PNG; a type mismatch means fallback.
    if (blob.type !== 'image/webp') {
      if (file.type === 'image/jpeg') {
        const jpeg = await toBlob(canvas, 'image/jpeg', 0.85)
        if (!jpeg || jpeg.type !== 'image/jpeg') return file
        blob = jpeg
      } else if (blob.type !== 'image/png') {
        return file
      }
    }
    if (!blob || blob.size >= file.size) return file

    const base = file.name.replace(/\.[^.]+$/, '') || 'image'
    return new File([blob], `${base}.${EXT[blob.type] ?? 'webp'}`, { type: blob.type })
  } catch {
    return file
  }
}

// 邮件插图专用：不出 WebP。Outlook 桌面版和一些老邮件客户端不认 WebP，图会直接空着。
//   · PNG 源图仍出 PNG（保留透明），JPEG / WebP 源图出 JPEG（WebP 的透明区垫白底，否则会变黑）；
//   · 最长边压到 1200：信里按 512 宽显示，高清屏两倍也只要 1024；
//   · WebP 源图必须转，哪怕转完更大；其余「没变小就传原文件」；GIF 不动（可能是动图）。
// For email images: never WebP — desktop Outlook and some older clients show nothing
// for it. PNG stays PNG (transparency), JPEG / WebP become JPEG on a white background,
// longest side capped at 1200 (shown at 512, so 2x is covered). WebP is always
// converted even if larger; otherwise a result that isn't smaller keeps the original.
export const EMAIL_MAX_EDGE = 1200

export async function shrinkImageForEmail(file: File): Promise<File> {
  try {
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return file
    if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return file

    const bitmap = await createImageBitmap(file)
    const { width, height } = fitSize(bitmap.width, bitmap.height, EMAIL_MAX_EDGE)
    const resized = width !== bitmap.width || height !== bitmap.height
    const isWebp = file.type === 'image/webp'
    if (!resized && !isWebp) {
      bitmap.close?.()
      return file
    }

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      bitmap.close?.()
      return file
    }
    const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg'
    if (type === 'image/jpeg') {
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, width, height)
    }
    ctx.drawImage(bitmap, 0, 0, width, height)
    bitmap.close?.()

    const blob = await toBlob(canvas, type, 0.85)
    if (!blob || blob.type !== type) return file
    if (!isWebp && blob.size >= file.size) return file
    const base = file.name.replace(/\.[^.]+$/, '') || 'image'
    return new File([blob], `${base}.${EXT[type]}`, { type })
  } catch {
    return file
  }
}
