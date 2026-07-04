// 通用确认弹窗：替代原生 confirm()，与玻璃拟态风格保持一致
// Generic confirm modal: replaces native confirm(), matches the glass aesthetic
import { useTranslation } from 'react-i18next'

interface Props {
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export default function ConfirmModal({
  title,
  message,
  confirmLabel,
  cancelLabel,
  danger,
  busy,
  onConfirm,
  onCancel,
}: Props) {
  const { t } = useTranslation()

  return (
    <div className="slide-overlay" onClick={onCancel}>
      <div className="slide-sheet" style={{ width: 360 }} onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-bold text-white">{title}</h3>
        <p className="mt-3 text-sm leading-relaxed text-slate-300">{message}</p>
        <div className="mt-5 flex gap-3">
          <button onClick={onCancel} disabled={busy} className="btn-ghost flex-1 py-2 text-sm">
            {cancelLabel ?? t('common.cancel')}
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className={`flex-1 rounded-xl py-2 text-sm font-semibold transition disabled:opacity-50 ${
              danger
                ? 'border border-down/40 bg-down/15 text-down hover:bg-down/25'
                : 'btn-primary'
            }`}
          >
            {confirmLabel ?? t('common.confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}
