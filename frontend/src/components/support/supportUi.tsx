// 客服台共用的小件：状态 / 优先级的配色、UTC+8 的 datetime-local 换算、出错文案、弹窗外壳。
// Small shared pieces for the support desk: status / priority tones, UTC+8 datetime-local
// conversion, error text and a modal shell.
import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { fmtDayShort, localizeApiError, parseTime } from '../../api/utils'
import { useDialogA11y } from '../../utils/useDialogA11y'
import type { FollowUpPriority, FollowUpStatus } from '../../api/supportTypes'

export const TICKET_STATUS_TONE: Record<string, string> = {
  open: 'bg-amber-400/15 text-amber-300',
  in_progress: 'bg-blue-400/15 text-blue-300',
  closed: 'bg-neutral-500/15 text-neutral-400',
}

export const TICKET_PRIORITY_TONE: Record<string, string> = {
  low: 'bg-neutral-500/15 text-neutral-400',
  normal: 'bg-blue-400/15 text-blue-300',
  urgent: 'bg-down/15 text-down',
}

export const FU_STATUS_TONE: Record<FollowUpStatus, string> = {
  pending: 'bg-amber-400/15 text-amber-300',
  contacted: 'bg-blue-400/15 text-blue-300',
  interested: 'bg-prism-600/20 text-prism-200',
  converted: 'bg-up/15 text-up',
  no_interest: 'bg-neutral-500/15 text-neutral-400',
  unreachable: 'bg-neutral-500/15 text-neutral-400',
  revoked: 'bg-neutral-500/15 text-neutral-500',
  expired: 'bg-down/15 text-down',
}

export const FU_PRIORITY_TONE: Record<FollowUpPriority, string> = {
  low: 'bg-neutral-500/15 text-neutral-400',
  normal: 'bg-blue-400/15 text-blue-300',
  high: 'bg-down/15 text-down',
}

export function errText(err: unknown, fallback: string): string {
  return err instanceof Error ? localizeApiError(err.message) : fallback
}

// 全站时间显示固定 UTC+8（见 api/utils 的 fmtTime），datetime-local 的输入也按 UTC+8 解释，
// 免得同一页上「显示的时刻」和「填的时刻」不在一个时区里。
// The site shows every time in UTC+8 (see fmtTime in api/utils), so the datetime-local input is
// read as UTC+8 too — otherwise the shown and the typed time would live in different zones.
const OFFSET_MS = 8 * 3600 * 1000

export function isoToBjInput(iso: string | null | undefined): string {
  if (!iso) return ''
  const hasTz = /[zZ]|[+-]\d{2}:?\d{2}$/.test(iso)
  const d = new Date(hasTz ? iso : `${iso}Z`)
  if (Number.isNaN(d.getTime())) return ''
  return new Date(d.getTime() + OFFSET_MS).toISOString().slice(0, 16)
}

export function bjInputToIso(v: string): string | null {
  if (!v) return null
  const d = new Date(`${v}:00+08:00`)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

// 工单状态：点 + 词（同用户端工单页 .sup-status 的语言）。待处理 = 橙、处理中 = 品牌紫（在手里）、已关闭 = 灰。
// Ticket status as dot + word (the user-side .sup-status language): open orange, in progress violet, closed grey.
const TICKET_DOT: Record<string, string> = {
  open: 'bg-[var(--mid)]',
  in_progress: 'bg-[var(--purple-hi)]',
  closed: 'bg-neutral-500',
}
const TICKET_WORD: Record<string, string> = {
  open: 'text-[var(--mid)]',
  in_progress: 'text-[var(--purple-hi)]',
  closed: 'text-neutral-500',
}

export function TicketStatus({ status, label }: { status: string; label: string }) {
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 text-[11px] font-medium ${TICKET_WORD[status] ?? 'text-neutral-500'}`}>
      <i className={`h-1.5 w-1.5 rounded-full ${TICKET_DOT[status] ?? 'bg-neutral-500'}`} aria-hidden="true" />
      {label}
    </span>
  )
}

/** 字母头像：客户中性灰，工作人员品牌紫实色，内部备注琥珀。/ Monogram: customers grey, staff violet, notes amber. */
export function Avatar({ name, size = 32, tone = 'neutral' }: { name: string | null | undefined; size?: number; tone?: 'neutral' | 'staff' | 'note' }) {
  const ch = Array.from((name || '').trim())[0]
  const cls =
    tone === 'staff' ? 'bg-[var(--purple)] text-white' : tone === 'note' ? 'bg-amber-400/20 text-amber-200' : 'bg-[var(--nest)] text-neutral-300'
  return (
    <span
      aria-hidden="true"
      className={`inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold leading-none ${cls}`}
      style={{ width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.4)) }}
    >
      {ch ? ch.toUpperCase() : '?'}
    </span>
  )
}

// UTC+8 的日期键与钟点，供列表时间（今天显示时刻，其余显示日期）和会话的按天分隔用。
// UTC+8 day keys and clock times for list times (today → time, else date) and the thread's day dividers.
export function bjDayKey(iso: string | null | undefined): string {
  const d = parseTime(iso)
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }) : ''
}

export function fmtClock(iso: string | null | undefined): string {
  const d = parseTime(iso)
  return d && !Number.isNaN(d.getTime())
    ? d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit' })
    : ''
}

export function fmtListTime(iso: string | null | undefined): string {
  if (!iso) return ''
  return bjDayKey(iso) === bjDayKey(new Date().toISOString()) ? fmtClock(iso) : fmtDayShort(iso)
}

/**
 * 工作台撑满一屏：高度 = 可视视口 − 元素在文档里的顶边 − 手机底栏 − 底部留白。实测而不是写死常量，
 * 横幅、节日卡、页头折行都不会把它顶出屏幕；手机键盘弹出时可视视口变矮，回复框跟着留在键盘上方。
 * Fits the workspace to one screen: visual viewport − the element's document top − the phone tab bar
 * − a bottom gap. Measured rather than a constant, so banners or a wrapped header never push it off
 * screen; when the phone keyboard opens the visual viewport shrinks and the composer stays above it.
 */
export function useFitHeight(ref: RefObject<HTMLElement | null>, deps: unknown[], gap = 16, floor = 520): CSSProperties {
  const [h, setH] = useState<number | null>(null)
  const calc = useCallback(() => {
    const el = ref.current
    if (!el) return
    const top = el.getBoundingClientRect().top + window.scrollY
    const vh = window.visualViewport?.height ?? window.innerHeight
    const tabbar = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--app-tabbar')) || 0
    setH(Math.max(floor, Math.round(vh - top - tabbar - gap)))
  }, [ref, gap, floor])
  useLayoutEffect(() => {
    calc()
    const vv = window.visualViewport
    window.addEventListener('resize', calc)
    vv?.addEventListener('resize', calc)
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(calc) : null
    ro?.observe(document.body)
    return () => {
      window.removeEventListener('resize', calc)
      vv?.removeEventListener('resize', calc)
      ro?.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [calc, ...deps])
  return h == null ? { height: 'calc(var(--app-vh, 100dvh) - 14rem)', minHeight: floor } : { height: h }
}

export function Tag({ tone, children }: { tone: string; children: ReactNode }) {
  return <span className={`tag whitespace-nowrap ${tone}`}>{children}</span>
}

/** 简单的居中弹窗：标题 + 内容 + 取消 / 确认。/ A plain centred dialog. */
export function DeskModal({
  title,
  children,
  confirmLabel,
  busy,
  danger,
  disabled,
  onConfirm,
  onClose,
}: {
  title: string
  children: ReactNode
  confirmLabel?: string
  busy?: boolean
  danger?: boolean
  disabled?: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement>(null)
  useDialogA11y(ref, () => { if (!busy) onClose() })
  // portal 到 body：.glass 卡片的 backdrop-filter 会成为 fixed 的包含块（同 ConfirmModal）
  // Portalled to body: a .glass card's backdrop-filter would contain `fixed` (as in ConfirmModal)
  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4" onClick={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="glass max-h-[90vh] w-full overflow-y-auto rounded-b-none p-6 sm:max-w-md sm:rounded-b-[var(--r-lg)]"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-4 font-display text-[17px] font-semibold text-neutral-50">{title}</h3>
        <div className="space-y-3 text-sm">{children}</div>
        <div className="mt-5 flex justify-end gap-2 pb-[env(safe-area-inset-bottom)]">
          <button type="button" className="btn btn-ghost h-10 px-5 text-sm" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className={`btn h-10 px-5 text-sm font-semibold ${
              danger ? 'border-[rgb(var(--down-rgb)/0.4)] bg-[var(--down-bg)] text-[var(--down)] hover:bg-[rgb(var(--down-rgb)/0.22)]' : 'btn-primary'
            }`}
            disabled={busy || disabled}
            onClick={onConfirm}
          >
            {busy ? t('common.loading') : confirmLabel ?? t('common.confirm')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
