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
import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { ApiHttpError, ticketApi } from '../api/client'
import { useBackToClose } from '../utils/useBackToClose'
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

function Lightbox({ url, onClose }: { url: string; onClose: () => void }) {
  const { t } = useTranslation()
  useBackToClose(true, onClose)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  // 挂到 body：卡片带 backdrop-filter，fixed 定位在它里面会相对卡片而不是视口。
  // Portalled to body: the cards use backdrop-filter, which would make position: fixed
  // resolve against the card instead of the viewport.
  return createPortal(
    <div className="sup-lightbox" role="dialog" aria-modal="true" aria-label={t('tickets.images.view')} onClick={onClose}>
      <img src={url} alt="" />
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
