// 管理后台的抽屉 / 弹窗外壳：邀请链接的编辑与新建、比赛的公开页预览 / 完整性报告 /
// 终审检查共用。用 .slide-overlay / .slide-sheet（手机贴底、桌面居中），宽度只能走
// Tailwind 的 sm: 前缀——内联 style 会盖掉 .slide-sheet 的手机媒体查询（见 ConfirmModal）。
// 必须 portal 到 body：调用点在 .glass 卡片里，带 backdrop-filter 的祖先会成为 fixed
// 的包含块。右上角先放一个 × 按钮：useDialogA11y 会把焦点给第一个可聚焦元素，若第一个
// 是输入框，手机上一打开抽屉就弹键盘。
// .slide-overlay 的 z-index 是 80，高于 ConfirmModal center 版的 z-50——所以在抽屉里
// 再弹确认框必须用非 center 的 ConfirmModal（同样是 slide-overlay，后挂载的在上面）。
// Shell for admin drawers/dialogs (invite edit/create, competition preview / integrity /
// settle). Width goes through the sm: prefix only — an inline style would clobber
// .slide-sheet's phone media query (see ConfirmModal). Portaled to body because call
// sites sit inside .glass cards. A × button comes first so useDialogA11y's initial focus
// lands on it, not on an input (which would pop the phone keyboard on open).
// .slide-overlay is z-index 80, above ConfirmModal's centered z-50, so a confirm opened
// from inside a sheet must be the non-centered ConfirmModal (also a slide-overlay; the
// later mount wins).
import { useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useBackToClose } from '../../utils/useBackToClose'
import { useDialogA11y } from '../../utils/useDialogA11y'

export default function AdminSheet({
  title,
  badge,
  onClose,
  widthClass = 'sm:w-[520px]',
  children,
}: {
  title: string
  badge?: ReactNode
  onClose: () => void
  widthClass?: string
  children: ReactNode
}) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()
  useBackToClose(true, onClose)
  useDialogA11y(ref, onClose)

  return createPortal(
    <div className="slide-overlay" onClick={onClose}>
      <div
        ref={ref}
        className={`slide-sheet ${widthClass}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h3 id={titleId} className="text-lg font-bold text-white">
              {title}
            </h3>
            {badge}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="-mr-1 shrink-0 rounded-lg px-2 py-1 text-lg leading-none text-neutral-500 transition hover:bg-white/5 hover:text-neutral-200"
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  )
}
