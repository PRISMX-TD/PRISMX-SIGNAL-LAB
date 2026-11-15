// 工单附图：选图 / 粘贴 / 拖入 → 浏览器里先缩一下 → 传进私有桶拿到对象键，发消息时随正文带上；
// 对话里的图显示成缩略图，点开看大图。用户端 SupportPage 与后台工单面板共用，样式在
// styles/support.css（.sup-attach* / .sup-imgs / .sup-lightbox）。
//
// 一选中就开始传，不等点「发送」：截图通常几百 KB，等用户写完字早传完了，发送那一下只是
// 带几串键。传失败的那张直接从列表里拿掉并提示原因——留一张红框图在那里，用户分不清它
// 到底会不会跟着发出去。
//
// Ticket images: pick / paste / drop -> shrink in the browser -> upload to the private bucket
// for an object key, sent along with the message text. Images in a thread render as thumbnails
// that open full size. Shared by SupportPage and the admin tickets panel; styled in
// styles/support.css. Uploads start on selection rather than on Send — a screenshot is a few
// hundred KB and is long done by the time the text is written. A failed upload is removed with
// the reason shown: a red-framed leftover would leave users unsure whether it gets sent.
import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { ApiHttpError, ticketApi } from '../api/client'
import { useBackToClose } from '../utils/useBackToClose'
import { LIGHTBOX_ZOOM, DOUBLE_TAP_MS, TAP_SLOP, clampPan, isDoubleTap, panLimit, zoomPanAt, type Tap } from '../utils/lightboxZoom'
import { releaseVelocity, rubberBand, shouldDismissSheet, type DragSample } from '../utils/useSheetDrag'
import { useDialogA11y } from '../utils/useDialogA11y'
import { shrinkImage } from './admin/shrinkImage'

// 与后端 schemas._TicketMessage 的 images max_length 一致 / matches the backend's per-message cap
export const MAX_TICKET_IMAGES = 6
// 截图里是字：最长边留到 2048，手机长截图缩完仍看得清 / screenshots are text: keep 2048 on the long edge
const TICKET_MAX_EDGE = 2048

interface Pending {
  id: number
  preview: string
  key: string | null
}

export interface TicketImagesState {
  items: Pending[]
  keys: string[]
  uploading: boolean
  add: (files: File[]) => void
  remove: (id: number) => void
  clear: () => void
  onPaste: (e: ClipboardEvent) => void
  dropProps: { onDragOver: (e: DragEvent) => void; onDrop: (e: DragEvent) => void }
}

// 后端认 PNG / JPEG / GIF / WebP。别的格式（个别安卓相册给的 HEIC 之类）浏览器能解就转成 JPEG，
// 解不了就原样送上去，让后端回一句明确的「格式不支持」。
// The backend takes PNG / JPEG / GIF / WebP. Anything else (the odd HEIC from an Android
// gallery) is transcoded to JPEG when the browser can decode it, otherwise sent as is so the
// backend answers with a clear "unsupported format".
async function prepare(file: File): Promise<File> {
  if (/^image\/(png|jpeg|webp)$/.test(file.type)) return shrinkImage(file, TICKET_MAX_EDGE)
  if (file.type === 'image/gif') return file
  try {
    const bitmap = await createImageBitmap(file)
    const k = Math.min(1, TICKET_MAX_EDGE / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * k))
    canvas.height = Math.max(1, Math.round(bitmap.height * k))
    const ctx = canvas.getContext('2d')
    if (!ctx) return file
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close?.()
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.88))
    if (!blob || blob.type !== 'image/jpeg') return file
    return new File([blob], `${file.name.replace(/\.[^.]+$/, '') || 'image'}.jpg`, { type: 'image/jpeg' })
  } catch {
    return file
  }
}

function uploadErrorKey(err: unknown): string {
  if (err instanceof ApiHttpError) {
    if (err.status === 413 || (err.status === 400 && err.message.includes('MB'))) return 'tickets.images.tooBig'
    if (err.status === 400 && err.message.includes('PNG')) return 'tickets.images.badType'
    if (err.status === 429) return 'tickets.images.rateLimited'
    if (err.status === 503) return 'tickets.images.noStorage'
  }
  return 'tickets.images.failed'
}

function imageFiles(list: FileList | DataTransferItemList | null | undefined): File[] {
  if (!list) return []
  const out: File[] = []
  for (const entry of Array.from(list as ArrayLike<File | DataTransferItem>)) {
    const file = entry instanceof File ? entry : entry.kind === 'file' ? entry.getAsFile() : null
    if (file && file.type.startsWith('image/')) out.push(file)
  }
  return out
}

/** 一个输入框的待发附图。onError 收到的是已翻译好的提示 / pending images for one composer;
 *  onError receives an already-translated message. */
export function useTicketImages(onError: (msg: string) => void): TicketImagesState {
  const { t } = useTranslation()
  // 列表以 ref 为准、state 只负责触发重渲染：连着两次选图（或选图后马上粘贴）时，第二次
  // 读到的必须是第一次刚加进去的那几张，否则 6 张的上限会被一起放过去。
  // The ref is the source of truth and state only triggers renders: two picks in a row must
  // see what the first just added, or both slip past the 6-image cap together.
  const listRef = useRef<Pending[]>([])
  const [, setTick] = useState(0)
  const seq = useRef(0)
  const alive = useRef(true)
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError

  const commit = useCallback((next: Pending[]) => {
    listRef.current = next
    setTick((n) => n + 1)
  }, [])

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      listRef.current.forEach((p) => URL.revokeObjectURL(p.preview))
    }
  }, [])

  const drop = useCallback((id: number) => {
    const hit = listRef.current.find((p) => p.id === id)
    if (!hit) return
    URL.revokeObjectURL(hit.preview)
    commit(listRef.current.filter((p) => p.id !== id))
  }, [commit])

  const add = useCallback((files: File[]) => {
    const images = files.filter((f) => f.type.startsWith('image/'))
    if (!images.length) return
    const room = MAX_TICKET_IMAGES - listRef.current.length
    if (images.length > room) onErrorRef.current(t('tickets.images.limit', { max: MAX_TICKET_IMAGES }))
    for (const file of images.slice(0, Math.max(0, room))) {
      const id = ++seq.current
      commit([...listRef.current, { id, preview: URL.createObjectURL(file), key: null }])
      void (async () => {
        try {
          const { key } = await ticketApi.uploadImage(await prepare(file))
          // 传的过程中被用户删掉了：那张图就成了桶里没人引用的孤儿，无害，不必追着删
          // Removed while uploading: the object is left unreferenced in the bucket — harmless
          if (!alive.current || !listRef.current.some((p) => p.id === id)) return
          commit(listRef.current.map((p) => (p.id === id ? { ...p, key } : p)))
        } catch (err) {
          if (!alive.current) return
          onErrorRef.current(t(uploadErrorKey(err)))
          drop(id)
        }
      })()
    }
  }, [commit, drop, t])

  const clear = useCallback(() => {
    listRef.current.forEach((p) => URL.revokeObjectURL(p.preview))
    commit([])
  }, [commit])

  // 粘贴截图：剪贴板里有图就收下；同时带着文字（从网页复制的图文）时文字照常粘进去。
  // Pasting a screenshot: take any images; when text comes along (copied web content) the
  // text still pastes normally.
  const onPaste = useCallback((e: ClipboardEvent) => {
    const files = imageFiles(e.clipboardData?.files?.length ? e.clipboardData.files : e.clipboardData?.items)
    if (!files.length) return
    if (!e.clipboardData.getData('text/plain')) e.preventDefault()
    add(files)
  }, [add])

  const dropProps = {
    onDragOver: (e: DragEvent) => {
      if (Array.from(e.dataTransfer?.types ?? []).includes('Files')) e.preventDefault()
    },
    onDrop: (e: DragEvent) => {
      const files = imageFiles(e.dataTransfer?.files)
      if (!files.length) return
      e.preventDefault()
      add(files)
    },
  }

  const items = listRef.current
  return {
    items,
    keys: items.flatMap((p) => (p.key ? [p.key] : [])),
    uploading: items.some((p) => !p.key),
    add,
    remove: drop,
    clear,
    onPaste,
    dropProps,
  }
}

/** 输入框下方的「添加图片」与待发缩略图 / the "add images" control and pending thumbnails */
export function TicketImagePicker({ state, disabled }: { state: TicketImagesState; disabled?: boolean }) {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLInputElement>(null)
  const full = state.items.length >= MAX_TICKET_IMAGES
  return (
    <div className="sup-attach">
      {state.items.length > 0 && (
        <ul className="sup-attach-list">
          {state.items.map((p) => (
            <li key={p.id} className={`sup-attach-item${p.key ? '' : ' busy'}`}>
              <img src={p.preview} alt="" />
              {!p.key && <span className="sup-attach-spin" role="status" aria-label={t('tickets.images.uploading')} />}
              <button type="button" className="sup-attach-x" onClick={() => state.remove(p.id)} aria-label={t('tickets.images.remove')}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="sup-attach-bar">
        <button type="button" className="sup-attach-btn" onClick={() => inputRef.current?.click()} disabled={disabled || full}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="4" width="18" height="16" rx="3" />
            <circle cx="9" cy="10" r="1.6" />
            <path d="M21 16l-5-5-8 8" />
          </svg>
          {t('tickets.images.add')}
          {state.items.length > 0 && <span className="num">{state.items.length}/{MAX_TICKET_IMAGES}</span>}
        </button>
        <span className="sup-attach-hint">{t('tickets.images.hint', { max: MAX_TICKET_IMAGES })}</span>
      </div>
      {/* accept 用 image/*：写死四种 MIME 在部分安卓上会弹文件管理器而不是相册。
          accept="image/*": listing four MIME types opens a file manager instead of the
          gallery on some Android builds. */}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          state.add(Array.from(e.target.files ?? []))
          e.target.value = ''
        }}
      />
    </div>
  )
}

function Thumb({ url, onOpen }: { url: string; onOpen: () => void }) {
  const { t } = useTranslation()
  // 签名链接几小时后过期：页面开着太久再点进来就会 403，这时显示占位，别留一个破图标。
  // Signed URLs expire after a few hours, so a page left open long enough gets 403s; show the
  // placeholder instead of a broken-image icon.
  const [failed, setFailed] = useState(false)
  if (failed) return <span className="sup-img missing">{t('tickets.images.unavailable')}</span>
  return (
    <button type="button" className="sup-img" onClick={onOpen} aria-label={t('tickets.images.view')}>
      <img src={url} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />
    </button>
  )
}

interface LightboxDrag {
  id: number
  sx: number
  sy: number
  ox: number
  oy: number
  mode: 'tap' | 'pan' | 'swipe'
  samples: DragSample[]
}

function Lightbox({ url, onClose }: { url: string; onClose: () => void }) {
  const { t } = useTranslation()
  useBackToClose(true, onClose)
  // Esc、Tab、焦点进出走 useDialogA11y 的栈：灯箱开在客服抽屉里时，一下 Esc 只关灯箱。
  // Escape/Tab/focus via useDialogA11y's stack: inside the support drawer one Escape
  // closes only the lightbox.
  const boxRef = useRef<HTMLDivElement>(null)
  useDialogA11y(boxRef, onClose)
  // 灯箱手势：双击（双点）在点到的位置放大到 2 倍、再双击还原；放大时拖动平移，平移不出图片
  // 边界；原大时往下拖关闭（与底部弹层同一套判定，utils/useSheetDrag）。全站缩放是锁死的
  // （index.html 的 user-scalable=no、main.tsx 的 gesturestart），截图里的小字只能在这里放大看。
  // 原大时单击图片仍是关闭，但要等 300ms 确认不是双击；放大时单击不做事，免得平移中误关。
  // Lightbox gestures: double-tap zooms to 2× at the tapped point and double-tap again
  // restores; while zoomed a drag pans, clamped to the image's edges; at 1× a downward drag
  // closes (the bottom-sheet rules from utils/useSheetDrag). Zoom is locked app-wide
  // (user-scalable=no in index.html, gesturestart in main.tsx), so this is the only place
  // to enlarge small text in a screenshot. At 1× a single tap on the image still closes,
  // after 300ms to rule out a double-tap; while zoomed a single tap does nothing, so
  // panning never closes it by accident.
  const imgRef = useRef<HTMLImageElement>(null)
  const bgRef = useRef<HTMLDivElement>(null)
  const [zoomed, setZoomed] = useState(false)
  const view = useRef({ s: 1, x: 0, y: 0 })
  const drag = useRef<LightboxDrag | null>(null)
  const lastTap = useRef<Tap | null>(null)
  const tapTimer = useRef(0)
  const exitTimer = useRef(0)
  const sawPointer = useRef(false)
  useEffect(() => () => {
    window.clearTimeout(tapTimer.current)
    window.clearTimeout(exitTimer.current)
  }, [])
  const reduced = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  const paint = (transition: string) => {
    const img = imgRef.current
    if (!img) return
    const v = view.current
    img.style.transition = transition
    img.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.s})`
  }
  const limitOf = (img: HTMLImageElement, s: number) =>
    panLimit({ w: img.offsetWidth, h: img.offsetHeight }, { w: window.innerWidth, h: window.innerHeight }, s)
  const toggleZoom = (px: number, py: number) => {
    const img = imgRef.current
    if (!img) return
    if (view.current.s > 1) {
      view.current = { s: 1, x: 0, y: 0 }
      setZoomed(false)
    } else {
      const r = img.getBoundingClientRect()
      const at = zoomPanAt(px, py, r.left + r.width / 2, r.top + r.height / 2, LIGHTBOX_ZOOM)
      view.current = { s: LIGHTBOX_ZOOM, ...clampPan(at.x, at.y, limitOf(img, LIGHTBOX_ZOOM)) }
      setZoomed(true)
    }
    paint(reduced() ? 'none' : 'transform var(--dur-base) var(--ease-out)')
  }
  const fadeBg = (opacity: string, transition: string) => {
    const bg = bgRef.current
    if (!bg) return
    bg.style.transition = transition
    bg.style.opacity = opacity
  }
  const settle = () => {
    view.current = { s: 1, x: 0, y: 0 }
    paint(reduced() ? 'none' : 'transform var(--dur-base) var(--ease-out)')
    fadeBg('', reduced() ? 'none' : 'opacity var(--dur-base) var(--ease-out)')
  }
  // 下拉甩走：图片顺势下落淡出、背景淡出，--dur-fast（140ms）后真正关闭。减弱动效直接关。
  // Swiped away: the image drops and fades with the backdrop, then closes after --dur-fast
  // (140ms). Reduced motion closes at once.
  const flingOut = () => {
    if (reduced()) { onClose(); return }
    const img = imgRef.current
    if (img) {
      img.style.transition = 'transform var(--dur-fast) var(--ease-in), opacity var(--dur-fast) var(--ease-in)'
      img.style.transform = `translate(0px, ${view.current.y + 160}px) scale(1)`
      img.style.opacity = '0'
    }
    fadeBg('0', 'opacity var(--dur-fast) var(--ease-in)')
    exitTimer.current = window.setTimeout(onClose, 140)
  }
  const onPointerDown = (e: ReactPointerEvent<HTMLImageElement>) => {
    sawPointer.current = true
    if (drag.current || !e.isPrimary) return
    if (e.pointerType === 'mouse' && e.button !== 0) return
    const v = view.current
    drag.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: v.x, oy: v.y, mode: 'tap', samples: [{ y: e.clientY, t: e.timeStamp }] }
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLImageElement>) => {
    const d = drag.current
    if (!d || e.pointerId !== d.id) return
    const dx = e.clientX - d.sx
    const dy = e.clientY - d.sy
    if (d.mode === 'tap') {
      if (Math.hypot(dx, dy) < TAP_SLOP) return
      if (view.current.s > 1) d.mode = 'pan'
      else if (Math.abs(dy) > Math.abs(dx)) d.mode = 'swipe'
      else { drag.current = null; return }
      // 开始拖了：上一次单击排着的关闭作废。/ A drag began: cancel the close queued by the last tap.
      window.clearTimeout(tapTimer.current)
      lastTap.current = null
      e.currentTarget.setPointerCapture(e.pointerId)
    }
    if (d.mode === 'pan') {
      view.current = { s: view.current.s, ...clampPan(d.ox + dx, d.oy + dy, limitOf(e.currentTarget, view.current.s)) }
      paint('none')
      return
    }
    const y = rubberBand(dy)
    view.current = { s: 1, x: 0, y }
    paint('none')
    d.samples.push({ y: e.clientY, t: e.timeStamp })
    if (d.samples.length > 6) d.samples.shift()
    const h = e.currentTarget.offsetHeight
    fadeBg(String(h > 0 ? Math.max(0, 1 - Math.max(0, y) / h) : 1), 'none')
  }
  const onPointerUp = (e: ReactPointerEvent<HTMLImageElement>) => {
    const d = drag.current
    if (!d || e.pointerId !== d.id) return
    drag.current = null
    if (d.mode === 'pan') return
    if (d.mode === 'swipe') {
      d.samples.push({ y: e.clientY, t: e.timeStamp })
      if (shouldDismissSheet(view.current.y, releaseVelocity(d.samples), e.currentTarget.offsetHeight)) flingOut()
      else settle()
      return
    }
    const tap = { x: e.clientX, y: e.clientY, t: e.timeStamp }
    window.clearTimeout(tapTimer.current)
    if (isDoubleTap(lastTap.current, tap)) {
      lastTap.current = null
      toggleZoom(tap.x, tap.y)
      return
    }
    lastTap.current = tap
    if (view.current.s === 1) tapTimer.current = window.setTimeout(onClose, DOUBLE_TAP_MS)
  }
  // 系统取消（返回手势、来电）：下拉中的弹回，不关。/ System cancel: a swipe in progress settles, never closes.
  const onPointerCancel = (e: ReactPointerEvent<HTMLImageElement>) => {
    const d = drag.current
    if (!d || e.pointerId !== d.id) return
    drag.current = null
    if (d.mode === 'swipe') settle()
  }
  // 挂到 body：卡片带 backdrop-filter，fixed 定位在它里面会相对卡片而不是视口。
  // Portalled to body: the cards use backdrop-filter, which would make position: fixed
  // resolve against the card instead of the viewport.
  return createPortal(
    <div ref={boxRef} className="sup-lightbox" role="dialog" aria-modal="true" aria-label={t('tickets.images.view')} tabIndex={-1} onClick={onClose}>
      {/* 背景单独一层：下拉关闭时只让背景变淡，不能连图一起淡。点背景仍冒泡到外层、立即关闭。
          The backdrop is its own layer so a swipe-down fades it without fading the image.
          Taps on it still bubble to the outer layer and close at once. */}
      <div ref={bgRef} className="sup-lightbox-bg" aria-hidden="true" />
      {/* 图片上的点按交给上面的指针逻辑（单击延迟关闭、双击放大），不再冒泡到外层直接关。
          没有指针事件的老浏览器（iOS 12）照旧：点图片就关。
          Taps on the image go to the pointer logic above (delayed close, double-tap zoom)
          instead of bubbling up to close. Browsers without pointer events (iOS 12) keep
          the old behaviour: a tap on the image closes. */}
      <img
        ref={imgRef}
        src={url}
        alt=""
        draggable={false}
        className={zoomed ? 'zoomed' : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onClick={(e) => { e.stopPropagation(); if (!sawPointer.current) onClose() }}
      />
      <button type="button" className="sup-lightbox-x" onClick={onClose} aria-label={t('common.close')}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
      </button>
    </div>,
    document.body,
  )
}

/** 一条消息里的图。count 比 urls 多出来的那几张是没签出来的，显示占位。
 *  The images of one message; any count beyond urls failed to sign and shows a placeholder. */
export function TicketImageGrid({ urls = [], count = 0 }: { urls?: string[]; count?: number }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState<string | null>(null)
  const close = useCallback(() => setOpen(null), [])
  const missing = Math.max(0, count - urls.length)
  if (!urls.length && !missing) return null
  return (
    <>
      <div className="sup-imgs">
        {urls.map((u) => <Thumb key={u} url={u} onOpen={() => setOpen(u)} />)}
        {Array.from({ length: missing }, (_, i) => (
          <span key={`missing-${i}`} className="sup-img missing">{t('tickets.images.unavailable')}</span>
        ))}
      </div>
      {open && <Lightbox url={open} onClose={close} />}
    </>
  )
}
