import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { TFunction } from 'i18next'
import { useDialogA11y } from '../../utils/useDialogA11y'

// 比赛简介：按后台填写的换行/空行原样显示；超过限高就折叠，底部渐隐 +「查看更多」，
// 点开弹窗看全文。是否溢出靠实测 scrollHeight，而不是数字数——空行多的短文同样会超高。
// Competition blurb: newlines/blank lines render as typed in admin; past the max
// height it clamps with a fade and a "Read more" that opens the full text in a
// dialog. Overflow is measured (scrollHeight), not counted in characters — a
// short text with many blank lines can still overflow.
export default function CompetitionDesc({ title, text, t }: { title: string; text: string; t: TFunction }) {
  const boxRef = useRef<HTMLParagraphElement>(null)
  const [overflows, setOverflows] = useState(false)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 1)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [text])

  return (
    <>
      <p ref={boxRef} className={`cmp-desc is-clamped${overflows ? ' is-overflowing' : ''}`}>{text}</p>
      {overflows && (
        <button type="button" className="cmp-desc-more" onClick={() => setOpen(true)}>
          {t('competition.readMore')} →
        </button>
      )}
      {open && <CompetitionDescModal title={title} text={text} onClose={() => setOpen(false)} t={t} />}
    </>
  )
}

function CompetitionDescModal({ title, text, onClose, t }: { title: string; text: string; onClose: () => void; t: TFunction }) {
  const panel = useRef<HTMLDivElement>(null)
  const titleId = useId()
  useDialogA11y(panel, onClose)

  // 弹窗开着时锁住背后页面滚动，免得滚到底把整页带着走。
  // Lock the page behind while open so scrolling past the end doesn't drag it.
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [])

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm sm:p-6"
      onClick={onClose}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="glass-card relative flex max-h-[85vh] w-full max-w-2xl flex-col p-5 outline-none supports-[height:100dvh]:max-h-[85dvh] sm:p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label={t('competition.descClose')}
          className="absolute right-4 top-4 text-2xl leading-none text-neutral-400 transition hover:text-neutral-200"
        >
          ×
        </button>
        <h3 id={titleId} className="pr-8 text-lg font-bold text-white">{title}</h3>
        <p className="cmp-desc mt-4 min-h-0 flex-1 overflow-y-auto pr-1">{text}</p>
      </div>
    </div>,
    document.body
  )
}
