// 图片画线的选图与压缩：画线整份存云端（每个品种 512KB 封顶），所以图片缩到最长边 640px、
// 压成 webp / jpeg，超过 IMAGE_MAX_BYTES 就再缩，实在压不下来就报错。
// Picking and squeezing images for the image drawing: drawings are stored whole in the cloud (512KB per
// symbol), so images are scaled to 640px on the long side and encoded as webp / jpeg, shrunk further
// while above IMAGE_MAX_BYTES, and refused if they still don't fit.

export const IMAGE_MAX_BYTES = 150 * 1024
const MAX_SIDE = 640

// 弹出系统选图框；必须在用户手势（点击 / 抬起）里同步调用 / opens the file chooser; call it synchronously inside a user gesture
export function pickImageFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/png,image/jpeg,image/webp,image/gif'
    input.style.display = 'none'
    let done = false
    const finish = (f: File | null) => { if (done) return; done = true; input.remove(); resolve(f) }
    input.addEventListener('change', () => finish(input.files?.[0] ?? null))
    input.addEventListener('cancel', () => finish(null))
    document.body.appendChild(input)
    input.click()
  })
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const im = new Image()
    im.onload = () => { URL.revokeObjectURL(url); resolve(im) }
    im.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode')) }
    im.src = url
  })
}
const bytesOf = (dataUrl: string) => Math.floor((dataUrl.length - dataUrl.indexOf(',') - 1) * 0.75)

// 压成 data URL；返回 null = 压不到上限以内 / squeezed into a data URL; null = can't get under the cap
export async function compressImage(file: File): Promise<{ url: string; w: number; h: number } | null> {
  const im = await loadImage(file)
  let scale = Math.min(1, MAX_SIDE / Math.max(im.naturalWidth, im.naturalHeight, 1))
  for (let attempt = 0; attempt < 6; attempt++) {
    const w = Math.max(1, Math.round(im.naturalWidth * scale)), h = Math.max(1, Math.round(im.naturalHeight * scale))
    const cv = document.createElement('canvas')
    cv.width = w; cv.height = h
    const ctx = cv.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(im, 0, 0, w, h)
    // webp 保留透明；不支持编码 webp 的浏览器（老 Safari）会退回 png，再试 jpeg
    // webp keeps transparency; browsers that can't encode webp (old Safari) fall back to png, then jpeg
    for (const [type, q] of [['image/webp', 0.85], ['image/jpeg', 0.82]] as const) {
      const url = cv.toDataURL(type, q)
      if (url.startsWith(`data:${type}`) && bytesOf(url) <= IMAGE_MAX_BYTES) return { url, w, h }
    }
    scale *= 0.7
  }
  return null
}
