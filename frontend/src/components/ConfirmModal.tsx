// 通用确认弹窗：替代原生 confirm()，与玻璃拟态风格保持一致
// Generic confirm modal: replaces native confirm(), matches the glass aesthetic
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'

interface Props {
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  busy?: boolean
  center?: boolean
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
  center,
  onConfirm,
  onCancel,
}: Props) {
  const { t } = useTranslation()

  const overlayClass = center
    ? 'fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-6'
    : 'slide-overlay'
  // 非 center 分支的宽度用 Tailwind 的 sm: 前缀，不要用内联 style——.slide-sheet
  // 的移动端媒体查询（<640px 变成贴底全宽抽屉）是纯类选择器，内联 style 优先级
  // 更高会把它整段废掉，手机上就退化成一个居中的窄框。同样的坑在指标设置弹窗和
  // 纪律分说明弹窗的注释里都记过。
  // The non-center width uses Tailwind's sm: prefix, never an inline style —
  // .slide-sheet's mobile media query (full-width bottom sheet below 640px) is a
  // plain class selector, and an inline style's higher specificity would clobber
  // it, degrading the phone layout into a narrow centered box. Same lesson noted
  // in the indicator-settings and discipline-help modals.
  const sheetClass = center
    ? 'glass-card w-full max-w-sm p-6'
    : 'slide-sheet sm:w-[360px]'

  // 必须 portal 到 body：本弹窗的调用点包括 .glass / .glass-neon 卡片内部
  // （如 PositionCard 的平仓确认），这类卡片带 backdrop-filter，会成为 fixed
  // 定位的包含块，让遮罩的 inset:0 只铺满那张卡片而不是整个视口——表现是弹窗
  // 偏离屏幕中心、背景模糊只糊住一小块。外层 .page-enter 的 transform 动画同理
  // （见 SlideOrderModal/ChartOrderModal 的同类注释）。
  // Portal to body, mandatory: call sites include the inside of .glass /
  // .glass-neon cards (e.g. PositionCard's close confirmation); those carry a
  // backdrop-filter, which becomes the containing block for fixed positioning
  // and shrinks the overlay's inset:0 to that one card instead of the viewport —
  // an off-center dialog with the blur confined to a small area. The .page-enter
  // wrapper's transform does the same (see SlideOrderModal/ChartOrderModal).
  return createPortal(
    <div className={overlayClass} onClick={onCancel}>
      <div className={sheetClass} onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-bold text-white">{title}</h3>
        <p className="mt-3 text-sm leading-relaxed text-neutral-300">{message}</p>
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
    </div>,
    document.body,
  )
}
