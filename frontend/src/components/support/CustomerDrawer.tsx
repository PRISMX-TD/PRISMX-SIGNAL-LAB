// 客户资料抽屉：从右侧滑出（手机上整屏），里面是窄栏版客户资料。搜索结果、没有右栏时的工单会话
// 都从这里看客户，不打断手上正在处理的那张工单。返回键 / Esc / 点遮罩都能关。
// The customer drawer: slides in from the right (full screen on phones) with the rail-layout
// profile. Search results and the thread on screens without a customer pane open it, so the ticket
// at hand is never left. Back, Esc and the scrim all close it.
import { useRef } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useBackToClose } from '../../utils/useBackToClose'
import { useDialogA11y } from '../../utils/useDialogA11y'
import CustomerCard from './CustomerCard'
import type { DeskCtx } from './SupportDeskPage'
import { IconClose } from './deskIcons'

export default function CustomerDrawer({
  userId,
  ctx,
  onClose,
  onOpenTicket,
}: {
  userId: string
  ctx: DeskCtx
  onClose: () => void
  onOpenTicket: (ticketId: string) => void
}) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement>(null)
  useDialogA11y(ref, onClose)
  useBackToClose(true, onClose)

  // portal 到 body：页面里任何带 transform / filter 的祖先都会成为 fixed 的包含块
  // Portalled to body: any transformed / filtered ancestor would otherwise contain `fixed`
  return createPortal(
    <div className="sd-scrim fixed inset-0 z-[60] flex justify-end bg-black/55" onClick={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={t('supportDesk.drawer.title')}
        tabIndex={-1}
        className="sd-drawer flex h-full w-full flex-col bg-[var(--surface)] outline-none sm:max-w-[440px] sm:border-l sm:border-[var(--line-hi)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--line)] px-4 pb-3 pt-[calc(env(safe-area-inset-top,0px)+12px)]">
          <h2 className="text-sm font-semibold text-neutral-100">{t('supportDesk.drawer.title')}</h2>
          <button type="button" className="sd-icon-btn -mr-1.5 ml-auto" onClick={onClose} aria-label={t('common.close')}>
            <IconClose size={18} />
          </button>
        </div>
        <div className="sd-scroll min-h-0 flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom,0px)]">
          <CustomerCard
            key={userId}
            userId={userId}
            layout="rail"
            me={ctx.me}
            onMeChanged={ctx.patchMe}
            onChanged={ctx.bump}
            onOpenTicket={onOpenTicket}
            onToast={ctx.toast}
          />
        </div>
      </div>
    </div>,
    document.body,
  )
}
