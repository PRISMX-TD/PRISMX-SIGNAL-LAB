// 我的跟进子页面 /support-desk/follow-ups[/<用户 ID>]。
// 桌面：一整块工作台，左边客户名单（按状态标签筛选 / 我的申请），右边没选人时是跟进概览，选了人是
// 宽版客户工作区（左跟进、右资料与操作）。手机：名单一屏，点进去客户资料占满一屏，返回键回名单。
// 名单一次拉完（每页 50、最多 10 页），状态筛选和概览按整份名单算。
// The follow-ups sub-page. Desktop: one workspace, the roster on the left (status filters / my
// requests); on the right the overview when nobody is open, otherwise the wide customer workspace
// (follow-up work left, profile and actions right). Phones: the roster, then a full-screen
// customer view, Back returning to the roster. The whole roster is loaded (50 per page, up to 10
// pages) so filters and the overview count all of it.
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { supportApi } from '../../api/client'
import type { FollowUp, SupportRequest } from '../../api/supportTypes'
import { useMediaQuery } from '../../utils/useMediaQuery'
import CustomerCard from './CustomerCard'
import FollowUpList, { type FuFilter, type FuMode } from './FollowUpList'
import FollowUpOverview from './FollowUpOverview'
import type { DeskCtx } from './SupportDeskPage'
import { IconBack } from './deskIcons'
import { errText, useFitHeight } from './supportUi'

const PAGE = 50
const MAX_PAGES = 10

export default function FollowUpsView({ ctx }: { ctx: DeskCtx }) {
  const { t } = useTranslation()
  const { userId } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const isDesktop = useMediaQuery('(min-width: 1024px)')
  const { onError, reloadKey } = ctx
  const [items, setItems] = useState<FollowUp[]>([])
  const [total, setTotal] = useState(0)
  const [requests, setRequests] = useState<SupportRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<FuFilter>('all')
  const [mode, setMode] = useState<FuMode>('customers')
  const frameRef = useRef<HTMLDivElement>(null)
  const fit = useFitHeight(frameRef, [isDesktop, userId ? 1 : 0], 16, isDesktop ? 560 : 360)

  const load = useCallback(async () => {
    try {
      const [first, req] = await Promise.all([supportApi.followUps(0), supportApi.myRequests()])
      let all = first.items
      for (let page = 1; all.length < first.total && page < MAX_PAGES; page++) {
        const next = await supportApi.followUps(page * PAGE)
        if (next.items.length === 0) break
        all = all.concat(next.items)
      }
      setItems(all)
      setTotal(first.total)
      setRequests(req.items)
    } catch (err) {
      onError(errText(err, t('common.error')))
    } finally {
      setLoading(false)
    }
  }, [onError, t])

  useEffect(() => { void load() }, [load, reloadKey])

  const open = (id: string) => {
    if (id === userId) return
    navigate(`/support-desk/follow-ups/${encodeURIComponent(id)}`, { replace: isDesktop && !!userId, state: { fromList: true } })
  }
  const back = () => {
    if ((location.state as { fromList?: boolean } | null)?.fromList) navigate(-1)
    else navigate('/support-desk/follow-ups', { replace: true })
  }

  const list = (
    <FollowUpList
      items={items}
      total={total}
      requests={requests}
      loading={loading}
      filter={filter}
      onFilter={setFilter}
      mode={mode}
      onMode={setMode}
      selectedUserId={userId ?? null}
      onSelect={open}
    />
  )

  const card = (layout: 'rail' | 'wide') =>
    userId ? (
      <CustomerCard
        key={userId}
        userId={userId}
        layout={layout}
        me={ctx.me}
        onMeChanged={ctx.patchMe}
        onChanged={ctx.bump}
        onOpenTicket={(id) => navigate(`/support-desk/tickets/${encodeURIComponent(id)}`)}
        onToast={ctx.toast}
      />
    ) : null

  // ---- 手机 / phones ----
  if (!isDesktop) {
    if (userId) {
      return (
        <div ref={frameRef} style={fit} className="sd-frame flex flex-col">
          <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--line)] px-2 py-2">
            <button type="button" onClick={back} className="sd-icon-btn" aria-label={t('supportDesk.backToList')}>
              <IconBack size={18} />
            </button>
            <span className="text-sm font-semibold text-neutral-100">{t('supportDesk.drawer.title')}</span>
          </div>
          <div className="sd-scroll min-h-0 flex-1 overflow-y-auto">{card('rail')}</div>
        </div>
      )
    }
    return <div className="sd-frame flex flex-col">{list}</div>
  }

  // ---- 桌面 / desktop ----
  return (
    <div ref={frameRef} style={fit} className="sd-frame grid grid-cols-[340px_minmax(0,1fr)]">
      <aside className="flex min-h-0 min-w-0 flex-col border-r border-[var(--line)]">{list}</aside>
      <section className="sd-well sd-scroll min-h-0 min-w-0 overflow-y-auto">
        {userId ? (
          card('wide')
        ) : (
          <FollowUpOverview
            items={items}
            total={total}
            loading={loading}
            onPick={(s) => {
              setMode('customers')
              setFilter(s)
            }}
          />
        )}
      </section>
    </div>
  )
}
