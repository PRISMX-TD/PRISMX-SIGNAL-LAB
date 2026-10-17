// 工单子页面 /support-desk/tickets[/<工单号>]。
// ≥1280：一整块工作台里三栏，队列 | 会话 | 提交人资料，各自滚动；1024–1279：队列 | 会话，
// 客户资料从会话头的按钮拉出抽屉；手机：列表一屏，点进去会话占满一屏（回复框贴底），返回键回列表。
// 选中哪张工单写在地址里，刷新、分享、返回键都对得上。
// The tickets sub-page. ≥1280: one workspace, three panes (queue | thread | submitter), each
// scrolling on its own; 1024–1279: queue | thread, with the customer in a drawer; phones: the list,
// then a full-screen thread with the composer docked, Back returning to the list. The open ticket
// lives in the URL so reloads, links and Back all agree.
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { useMediaQuery } from '../../utils/useMediaQuery'
import CustomerCard from './CustomerCard'
import TicketQueue from './TicketQueue'
import TicketThread from './TicketThread'
import type { DeskCtx } from './SupportDeskPage'
import { IconBack, IconInbox, IconUser } from './deskIcons'
import { useFitHeight } from './supportUi'

export default function TicketsView({ ctx }: { ctx: DeskCtx }) {
  const { t } = useTranslation()
  const { ticketId } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const isDesktop = useMediaQuery('(min-width: 1024px)')
  const isWide = useMediaQuery('(min-width: 1280px)')
  const [submitter, setSubmitter] = useState<{ ticketId: string; userId: string } | null>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const fit = useFitHeight(frameRef, [isDesktop, ticketId ? 1 : 0], 16, isDesktop ? 560 : 360)

  useEffect(() => { setSubmitter(null) }, [ticketId])
  const customerId = submitter && submitter.ticketId === ticketId ? submitter.userId : null

  const open = (id: string) => {
    if (id === ticketId) return
    // 桌面上在工单之间切换不堆历史；手机上从列表进详情要能用返回键回来
    // Switching tickets on desktop doesn't pile up history; on phones list → detail must be undoable
    navigate(`/support-desk/tickets/${encodeURIComponent(id)}`, { replace: isDesktop && !!ticketId, state: { fromList: true } })
  }
  const back = () => {
    if ((location.state as { fromList?: boolean } | null)?.fromList) navigate(-1)
    else navigate('/support-desk/tickets', { replace: true })
  }

  const queue = (
    <TicketQueue
      selectedId={ticketId ?? null}
      onSelect={open}
      reloadKey={ctx.reloadKey}
      onError={ctx.onError}
    />
  )

  const thread = ticketId ? (
    <TicketThread
      key={ticketId}
      ticketId={ticketId}
      me={ctx.me}
      onChanged={ctx.bump}
      onToast={ctx.toast}
      onLoaded={(userId) => setSubmitter({ ticketId, userId })}
      onOpenCustomer={isWide ? undefined : ctx.openCustomer}
      leading={
        isDesktop ? undefined : (
          <button type="button" onClick={back} className="sd-icon-btn -ml-1.5" aria-label={t('supportDesk.backToList')}>
            <IconBack size={18} />
          </button>
        )
      }
    />
  ) : null

  // ---- 手机 / phones ----
  if (!isDesktop) {
    if (thread) {
      return (
        <div ref={frameRef} style={fit} className="sd-frame flex flex-col">
          {thread}
        </div>
      )
    }
    return <div className="sd-frame flex flex-col">{queue}</div>
  }

  // ---- 桌面 / desktop ----
  const idle = (
    <div className="flex h-full flex-col items-center justify-center px-8 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--nest)] text-neutral-400">
        <IconInbox size={24} />
      </span>
      <p className="mt-4 font-display text-[15px] font-semibold text-neutral-100">{t('supportDesk.queue.pickTitle')}</p>
      <p className="mt-1.5 max-w-[19rem] text-xs leading-relaxed text-neutral-500">{t('supportDesk.queue.pickHint')}</p>
    </div>
  )

  return (
    <div
      ref={frameRef}
      style={fit}
      className={`sd-frame grid ${isWide ? 'grid-cols-[340px_minmax(0,1fr)_minmax(320px,380px)]' : 'grid-cols-[320px_minmax(0,1fr)]'}`}
    >
      <aside className="flex min-h-0 min-w-0 flex-col border-r border-[var(--line)]">{queue}</aside>
      <section className="sd-well flex min-h-0 min-w-0 flex-col">{thread ?? idle}</section>
      {isWide && (
        <aside className="sd-scroll min-h-0 min-w-0 overflow-y-auto border-l border-[var(--line)]">
          {customerId ? (
            <CustomerCard
              key={customerId}
              userId={customerId}
              layout="rail"
              me={ctx.me}
              onMeChanged={ctx.patchMe}
              onChanged={ctx.bump}
              onOpenTicket={open}
              currentTicketId={ticketId}
              onToast={ctx.toast}
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center px-8 text-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--nest)] text-neutral-500">
                <IconUser size={20} />
              </span>
              <p className="mt-3 max-w-[15rem] text-xs leading-relaxed text-neutral-500">
                {ticketId ? t('supportDesk.pickCustomer') : t('supportDesk.railIdle')}
              </p>
            </div>
          )}
        </aside>
      )}
    </div>
  )
}
