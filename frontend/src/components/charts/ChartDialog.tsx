// 图表页的小弹窗外壳（跳转日期、快捷键、图表设置共用）：遮罩 + 居中面板（手机贴底），
// Esc / 遮罩 / 返回键关闭，焦点困在里面（useDialogA11y）。材质与指标库弹窗一致。
// Small dialog shell for the charts page (go-to-date, shortcuts, chart settings): scrim +
// centred panel (bottom sheet on phones), closed by Escape / scrim / back, focus trapped
// (useDialogA11y). Same material as the indicator library.
import { useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useDialogA11y } from '../../utils/useDialogA11y'
import { useBackToClose } from '../../utils/useBackToClose'
import { useScrollLock } from '../../utils/scrollLock'

export default function ChartDialog({ title, onClose, children, footer, wide = false, className = '' }: {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
  className?: string
}) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement>(null)
  useDialogA11y(ref, onClose)
  useBackToClose(true, onClose)
  useScrollLock(true)
  return createPortal(
    <div className="chart-dlg-ov" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div ref={ref} className={`chart-dlg ${wide ? 'wide' : ''} ${className}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
        <div className="chart-dlg-hd">
          <h3>{title}</h3>
          <button type="button" className="ind-close" onClick={onClose} aria-label={String(t('common.close'))}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>
        <div className="chart-dlg-body no-sb">{children}</div>
        {footer && <div className="chart-dlg-ft">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}
