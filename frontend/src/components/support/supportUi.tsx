// 客服台共用的小件：状态 / 优先级的配色、UTC+8 的 datetime-local 换算、出错文案、弹窗外壳。
// Small shared pieces for the support desk: status / priority tones, UTC+8 datetime-local
// conversion, error text and a modal shell.
import { useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { localizeApiError } from '../../api/utils'
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
        className="glass max-h-[90vh] w-full overflow-y-auto rounded-b-none p-5 sm:max-w-md sm:rounded-b-[var(--r-lg)]"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-3 text-base font-semibold text-neutral-100">{title}</h3>
        <div className="space-y-3 text-sm">{children}</div>
        <div className="mt-5 flex justify-end gap-2 pb-[env(safe-area-inset-bottom)]">
          <button type="button" className="btn-ghost px-4 py-2 text-sm" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className={`rounded-xl px-4 py-2 text-sm font-semibold transition disabled:opacity-40 ${
              danger ? 'border border-down/40 bg-down/15 text-down hover:bg-down/25' : 'btn-primary'
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
