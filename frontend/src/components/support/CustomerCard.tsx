// 客户资料（设计 §2.3 / §5.3）：吸顶合规提示；按调用者权限脱敏后的资料（字段缺 = 无权看）；
// 查看完整电话（外包计入每日上限，429 时说清楚）；复制开户链接；跟进状态标签与只追加的跟进记录；
// 转化时间线；工单；受限操作；「用户要求不再联系」。
// 两种排版：rail 是一条窄栏（工单页右栏、抽屉），各块之间用发丝线分开；wide 是跟进页的客户工作区，
// 左边跟进工作（状态、记录）、右边资料与操作，各块是独立的面。
// Customer profile (design §2.3 / §5.3): sticky compliance note; data already masked for the
// caller (a missing field means no access); full-phone reveal (counted against the outsourced
// daily cap, 429 explained); copy the open-account link; follow-up labels and append-only notes;
// conversions; tickets; restricted actions; "the user asked not to be contacted".
// Two layouts: `rail` is a narrow column (the tickets page's right pane, the drawer) split by
// hairlines; `wide` is the follow-ups page's customer workspace, follow-up work on the left and
// profile + actions on the right, each block its own plane.
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiHttpError, supportApi } from '../../api/client'
import { fmtDate, fmtDay } from '../../api/utils'
import {
  FOLLOW_UP_CHANNELS,
  FOLLOW_UP_STAFF_STATUSES,
  type FollowUpChannel,
  type FollowUpStaffStatus,
  type SupportCard,
  type SupportMe,
} from '../../api/supportTypes'
import ConfirmModal from '../ConfirmModal'
import Select from '../Select'
import { SkeletonLine } from '../Skeleton'
import { copyText } from '../admin/invite/CopyLinkButton'
import ActionMenu from './ActionMenu'
import ConversionTimeline from './ConversionTimeline'
import { IconShield } from './deskIcons'
import { Avatar, FU_PRIORITY_TONE, FU_STATUS_TONE, Tag, TicketStatus, errText, fmtListTime } from './supportUi'

type Layout = 'rail' | 'wide'

// 跟进状态标签选中时的字色（边框跟 currentColor）/ text colour of a selected follow-up label (border follows)
const LABEL_ON: Record<FollowUpStaffStatus, string> = {
  pending: 'text-amber-300 bg-amber-400/10',
  contacted: 'text-blue-300 bg-blue-400/10',
  interested: 'text-[var(--purple-hi)] bg-[rgb(var(--purple-rgb)/0.14)]',
  converted: 'text-[var(--up)] bg-[var(--up-bg)]',
  no_interest: 'text-neutral-300 bg-white/[0.05]',
  unreachable: 'text-neutral-300 bg-white/[0.05]',
}

function Rows({ children }: { children: ReactNode }) {
  return <dl className="grid grid-cols-[minmax(0,6rem)_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-xs">{children}</dl>
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-neutral-500">{label}</dt>
      <dd className="min-w-0 break-words text-neutral-200">{children}</dd>
    </>
  )
}

function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="sd-fact">
      <div className="truncate text-[11px] text-neutral-500">{label}</div>
      <div className="mt-1 truncate text-[13px] font-medium text-neutral-100">{value}</div>
    </div>
  )
}

export default function CustomerCard({
  userId,
  me,
  layout = 'rail',
  onMeChanged,
  onChanged,
  onOpenTicket,
  currentTicketId,
  onToast,
}: {
  userId: string
  me: SupportMe
  layout?: Layout
  // 查看完整电话后回写今日用量 / reports today's reveal usage after a reveal
  onMeChanged: (patch: Partial<SupportMe>) => void
  // 跟进状态等变了，让列表刷新 / lets the lists refresh after a follow-up change
  onChanged: () => void
  onOpenTicket?: (ticketId: string) => void
  // 工单页里正在看的那张，在工单列表里标出来 / the ticket being viewed, marked in the ticket list
  currentTicketId?: string
  onToast: (kind: 'ok' | 'err', text: string) => void
}) {
  const { t } = useTranslation()
  const [card, setCard] = useState<SupportCard | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [phone, setPhone] = useState<string | null>(null)
  const [revealing, setRevealing] = useState(false)
  const [noteChannel, setNoteChannel] = useState<FollowUpChannel>('phone')
  const [noteText, setNoteText] = useState('')
  const [noteOutcome, setNoteOutcome] = useState('')
  const [saving, setSaving] = useState(false)
  const [dncConfirm, setDncConfirm] = useState(false)
  const wide = layout === 'wide'

  const load = useCallback(async () => {
    setLoadErr(null)
    try {
      setCard(await supportApi.card(userId))
    } catch (err) {
      setLoadErr(errText(err, t('common.error')))
    }
  }, [userId, t])

  useEffect(() => {
    setCard(null)
    setPhone(null)
    setNoteText('')
    setNoteOutcome('')
    void load()
  }, [load])

  if (loadErr) {
    return (
      <div className="p-8 text-center text-sm">
        <p className="text-down">{loadErr}</p>
        <button type="button" className="btn btn-ghost mt-4 h-9 px-5 text-xs" onClick={() => void load()}>
          {t('supportDesk.retry')}
        </button>
      </div>
    )
  }
  if (!card) {
    return (
      <div className={wide ? 'space-y-4 p-6' : 'space-y-4 p-5'}>
        <div className="flex items-center gap-3">
          <SkeletonLine width={44} height={44} />
          <div className="flex-1 space-y-2">
            <SkeletonLine width="45%" height={14} />
            <SkeletonLine width="60%" height={10} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <SkeletonLine height={52} />
          <SkeletonLine height={52} />
          <SkeletonLine height={52} />
          <SkeletonLine height={52} />
        </div>
        <SkeletonLine width="80%" />
        <SkeletonLine width="60%" />
      </div>
    )
  }

  const c = card.customer
  const fu = card.followUp

  const reveal = async () => {
    setRevealing(true)
    try {
      const r = await supportApi.revealPhone(c.id)
      setPhone(r.phone)
      if (r.revealsToday != null) onMeChanged({ revealsToday: r.revealsToday, revealLimit: r.revealLimit })
    } catch (err) {
      onToast('err', err instanceof ApiHttpError && err.status === 429 ? t('supportDesk.card.revealLimitHit') : errText(err, t('common.error')))
    } finally {
      setRevealing(false)
    }
  }

  const copyOpenAccount = async () => {
    if (!c.openAccountUrl) return
    const ok = await copyText(c.openAccountUrl)
    onToast(ok ? 'ok' : 'err', ok ? t('supportDesk.card.linkCopied') : t('supportDesk.card.copyFailed'))
  }

  const patchFollowUp = async (patch: { status?: FollowUpStaffStatus }, okMsg: string) => {
    if (!fu) return
    setSaving(true)
    try {
      await supportApi.patchFollowUp(fu.id, patch)
      onToast('ok', okMsg)
      onChanged()
      await load()
    } catch (err) {
      onToast('err', errText(err, t('common.error')))
    } finally {
      setSaving(false)
    }
  }

  const addNote = async () => {
    if (!fu || !noteText.trim()) return
    setSaving(true)
    try {
      await supportApi.addNote(fu.id, { channel: noteChannel, content: noteText.trim(), outcome: noteOutcome.trim() || null })
      setNoteText('')
      setNoteOutcome('')
      onToast('ok', t('supportDesk.card.noteAdded'))
      onChanged()
      await load()
    } catch (err) {
      onToast('err', errText(err, t('common.error')))
    } finally {
      setSaving(false)
    }
  }

  const doNotContact = async () => {
    setSaving(true)
    try {
      await supportApi.doNotContact(c.id)
      setDncConfirm(false)
      onToast('ok', t('supportDesk.card.dncDone'))
      onChanged()
      await load()
    } catch (err) {
      onToast('err', errText(err, t('common.error')))
    } finally {
      setSaving(false)
    }
  }

  const revealLeft = me.revealLimit != null && me.revealsToday != null ? Math.max(0, me.revealLimit - me.revealsToday) : null
  const online = [c.bridgeOnline && 'Bridge', c.gatewayOnline && t('supportDesk.card.gateway')].filter(Boolean).join(' · ')

  // 一块内容：rail 用发丝线分隔，wide 是独立的面 / a block: hairline-separated in the rail, its own plane when wide
  const block = (title: string | null, body: ReactNode, extra?: ReactNode, key?: string) => (
    <section key={key ?? title ?? undefined} className={wide ? 'sd-block' : 'border-t border-[var(--line)] px-5 py-5'}>
      {title && (
        <div className="mb-3.5 flex items-center gap-2">
          <h3 className="text-[13px] font-semibold text-neutral-100">{title}</h3>
          {extra && <div className="ml-auto flex items-center gap-1.5">{extra}</div>}
        </div>
      )}
      {body}
    </section>
  )

  // ---- 合规提示 / compliance ----
  const compliance = (
    <div className={`sticky top-0 z-10 ${wide ? 'sd-well -mx-1 px-1 pb-3 pt-0' : 'bg-[var(--surface)]'}`}>
      <div
        role="note"
        className={`flex items-start gap-2 text-[11px] leading-relaxed text-amber-100/90 ${
          wide
            ? 'rounded-2xl border border-amber-400/25 bg-amber-400/[0.07] px-4 py-2.5'
            : 'border-b border-amber-400/20 bg-amber-400/[0.07] px-5 py-2.5'
        }`}
      >
        <span className="mt-px text-amber-300"><IconShield size={14} /></span>
        <p>
          <b className="mr-1 font-semibold text-amber-200">{t('supportDesk.card.complianceTitle')}</b>
          {t('supportDesk.card.compliance')}
        </p>
      </div>
    </div>
  )

  // ---- 头部：头像、昵称、邮箱、标签 / identity ----
  const chips = (
    <div className="mt-2 flex flex-wrap gap-1.5">
      <Tag tone={c.plan === 'PRO' ? 'bg-[rgb(var(--purple-rgb)/0.22)] text-[var(--purple-hi)]' : 'bg-white/[0.06] text-neutral-400'}>
        {c.plan}
        {c.planIsTrial ? ` · ${t('supportDesk.card.trial')}` : ''}
      </Tag>
      <Tag tone={c.emailVerified ? 'bg-[var(--up-bg)] text-[var(--up)]' : 'bg-amber-400/15 text-amber-300'}>
        {c.emailVerified ? t('supportDesk.card.verified') : t('supportDesk.card.unverified')}
      </Tag>
      {c.disabled && <Tag tone="bg-[var(--down-bg)] text-[var(--down)]">{t('supportDesk.card.disabled')}</Tag>}
      {c.doNotContact && <Tag tone="bg-[var(--down-bg)] text-[var(--down)]">{t('supportDesk.card.dncTag')}</Tag>}
    </div>
  )

  const openAccountBtn = c.openAccountUrl && (
    <button type="button" className={`btn btn-primary h-10 px-5 text-[13px] ${wide ? '' : 'w-full'}`} onClick={() => void copyOpenAccount()}>
      {t('supportDesk.card.copyOpenAccount')}
    </button>
  )

  const facts = (
    <div className={`grid gap-2 ${wide ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-2'}`}>
      <Fact
        label={t('supportDesk.card.planExpires')}
        value={c.plan === 'PRO' ? (c.planExpiresAt ? fmtDay(c.planExpiresAt) : t('supportDesk.card.permanent')) : '-'}
      />
      <Fact label={t('supportDesk.card.lastActive')} value={c.lastActiveAt ? fmtListTime(c.lastActiveAt) : '-'} />
      <Fact label={t('supportDesk.card.registered')} value={fmtDay(c.createdAt, '-')} />
      <Fact
        label={t('supportDesk.card.online')}
        value={online ? <span className="text-[var(--up)]">{online}</span> : <span className="text-neutral-500">{t('common.offline')}</span>}
      />
    </div>
  )

  const identity = (
    <div className="flex items-start gap-3.5">
      <Avatar name={c.nickname || c.email} size={wide ? 52 : 44} />
      <div className="min-w-0 flex-1">
        <h2 className={`truncate font-display font-semibold leading-tight text-neutral-50 ${wide ? 'text-xl' : 'text-[17px]'}`}>
          {c.nickname || t('supportDesk.card.noNickname')}
        </h2>
        <p className="mt-0.5 truncate font-mono text-xs text-neutral-500">{c.email || '-'}</p>
        {chips}
      </div>
      {wide && openAccountBtn && <div className="hidden shrink-0 sm:block">{openAccountBtn}</div>}
    </div>
  )

  // ---- 资料 / profile rows ----
  const phoneCell = !c.hasPhone ? (
    '-'
  ) : (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span className="font-mono">{phone ?? c.phone}</span>
      {c.phoneMasked && !phone && (
        <button
          type="button"
          onClick={() => void reveal()}
          disabled={revealing}
          className="rounded-full border border-[var(--line-hi)] px-2.5 py-0.5 text-[11px] text-[var(--purple-hi)] transition hover:bg-white/[0.05] disabled:opacity-50"
        >
          {revealing ? t('common.loading') : t('supportDesk.card.reveal')}
        </button>
      )}
      {c.phoneMasked && !phone && revealLeft != null && (
        <span className="text-[11px] text-neutral-500">{t('supportDesk.card.revealLeft', { n: revealLeft })}</span>
      )}
    </span>
  )

  const profile = block(
    null,
    <div className="space-y-5">
      <div>
        <h4 className="mb-2.5 text-[11px] font-medium text-neutral-500">{t('supportDesk.card.groupContact')}</h4>
        <Rows>
          <Row label={t('supportDesk.card.email')}>
            <span className="break-all font-mono">{c.email || '-'}</span>
          </Row>
          <Row label={t('supportDesk.card.phone')}>{phoneCell}</Row>
          <Row label={t('supportDesk.card.region')}>{c.region || '-'}</Row>
        </Rows>
      </div>
      <div>
        <h4 className="mb-2.5 text-[11px] font-medium text-neutral-500">{t('supportDesk.card.groupAccount')}</h4>
        <Rows>
          <Row label={t('supportDesk.card.trialUsed')}>{c.trialUsed ? t('supportDesk.yes') : t('supportDesk.no')}</Row>
          {c.competitions.length > 0 && <Row label={t('supportDesk.card.competitions')}>{c.competitions.map((x) => x.name).join(' · ')}</Row>}
          {c.paidTotalUsd != null && <Row label={t('supportDesk.card.paidTotal')}>{`$${c.paidTotalUsd.toFixed(2)}`}</Row>}
          <Row label={t('supportDesk.card.source')}>{c.inviteLabel || c.inviteCode || t('supportDesk.card.noSource')}</Row>
        </Rows>
      </div>
    </div>,
    undefined,
    'profile',
  )

  // ---- MT5 ----
  const mt5 = block(
    t('supportDesk.card.mt5'),
    c.mt5Accounts.length === 0 ? (
      <p className="text-xs text-neutral-500">{t('supportDesk.card.noMt5')}</p>
    ) : (
      <ul className="grid gap-2">
        {c.mt5Accounts.map((a) => (
          <li key={a.id} className="rounded-2xl border border-[var(--line)] bg-white/[0.02] px-3.5 py-3 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[13px] font-medium text-neutral-100">{a.login || t('supportDesk.card.bound')}</span>
              {a.real != null && (
                <Tag tone={a.real ? 'bg-[var(--up-bg)] text-[var(--up)]' : 'bg-white/[0.06] text-neutral-400'}>
                  {a.real ? t('supportDesk.card.real') : t('supportDesk.card.demo')}
                </Tag>
              )}
              <span className={`ml-auto inline-flex items-center gap-1.5 text-[11px] ${a.online ? 'text-[var(--up)]' : 'text-neutral-500'}`}>
                <i className={`h-1.5 w-1.5 rounded-full ${a.online ? 'bg-[var(--up)]' : 'bg-neutral-600'}`} aria-hidden="true" />
                {a.online ? t('common.online') : t('common.offline')}
              </span>
            </div>
            {(a.broker || a.server) && <div className="mt-1.5 break-words text-neutral-500">{[a.broker, a.server].filter(Boolean).join(' · ')}</div>}
            {(a.balance != null || a.balanceRange) && (
              <div className="mt-1 text-neutral-400">
                {t('supportDesk.card.balance')}{' '}
                <span className="num font-medium text-neutral-100">
                  {a.balance != null ? `${a.balance.toFixed(2)}${a.currency ? ` ${a.currency}` : ''}` : a.balanceRange}
                </span>
              </div>
            )}
          </li>
        ))}
      </ul>
    ),
    undefined,
    'mt5',
  )

  // ---- 跟进 / follow-up ----
  const followUp =
    fu &&
    block(
      t('supportDesk.card.followUp'),
      <div>
        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
          <span className="text-neutral-500">{t('supportDesk.card.goal')}</span>
          <span className="font-medium text-neutral-100">{t(`supportDesk.goal.${fu.goal}`)}</span>
        </div>
        {fu.note && (
          <div className="mb-4 rounded-xl border-l-2 border-[var(--purple-hi)] bg-white/[0.025] px-3.5 py-2.5">
            <div className="mb-0.5 text-[11px] text-neutral-500">{t('supportDesk.card.assignNote')}</div>
            <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-neutral-200">{fu.note}</p>
          </div>
        )}
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('supportDesk.card.status')}>
          {FOLLOW_UP_STAFF_STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              disabled={saving}
              aria-pressed={fu.status === s}
              onClick={() => s !== fu.status && void patchFollowUp({ status: s }, t('supportDesk.card.statusSaved'))}
              className={`sd-label ${fu.status === s ? `is-on ${LABEL_ON[s]}` : ''}`}
            >
              {t(`supportDesk.status.${s}`)}
            </button>
          ))}
        </div>

        {/* 写一条记录 / add a note */}
        <div className="sd-composer mt-5">
          <div className="flex flex-wrap items-center gap-2 border-b border-[var(--line)] px-3 py-2">
            <Select
              value={noteChannel}
              onChange={(v) => setNoteChannel(v as FollowUpChannel)}
              className="select-tight"
              ariaLabel={t('supportDesk.card.channel')}
              options={FOLLOW_UP_CHANNELS.map((ch) => ({ value: ch, label: t(`supportDesk.channel.${ch}`) }))}
            />
            <input
              className="min-w-0 flex-1 bg-transparent px-1 text-xs text-neutral-100 outline-none placeholder:text-neutral-500"
              placeholder={t('supportDesk.card.outcomePlaceholder')}
              maxLength={200}
              value={noteOutcome}
              onChange={(e) => setNoteOutcome(e.target.value)}
              aria-label={t('supportDesk.card.outcome')}
            />
          </div>
          <textarea
            rows={3}
            placeholder={t('supportDesk.card.notePlaceholder')}
            maxLength={5000}
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            aria-label={t('supportDesk.card.notes')}
          />
          <div className="flex items-center gap-3 px-3 pb-3">
            <p className="min-w-0 flex-1 text-[11px] leading-snug text-neutral-500">{t('supportDesk.card.appendOnly')}</p>
            <button type="button" className="btn btn-primary h-8 shrink-0 px-4 text-xs" disabled={saving || !noteText.trim()} onClick={() => void addNote()}>
              {t('supportDesk.card.addNote')}
            </button>
          </div>
        </div>

        {/* 记录时间线，新的在上 / note timeline, newest first */}
        <h4 className="mb-3 mt-6 text-[11px] font-medium text-neutral-500">{t('supportDesk.card.notes')}</h4>
        {card.notes.length === 0 ? (
          <p className="text-xs text-neutral-500">{t('supportDesk.card.noNotes')}</p>
        ) : (
          <ol className="relative ml-[13px] space-y-4 border-l border-[var(--line-hi)] pl-5">
            {[...card.notes].reverse().map((n) => (
              <li key={n.id} className="relative">
                <span className="absolute -left-[34px] top-0 ring-4 ring-[var(--surface)] rounded-full">
                  <Avatar name={n.authorName} size={26} tone="staff" />
                </span>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-neutral-500">
                  <span className="font-medium text-neutral-200">{n.authorName || '-'}</span>
                  <span className="rounded-full bg-white/[0.06] px-1.5 py-px text-neutral-400">{t(`supportDesk.channel.${n.channel}`)}</span>
                  <span className="num ml-auto">{fmtDate(n.createdAt)}</span>
                </div>
                <p className="mt-1.5 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-neutral-200">{n.content}</p>
                {n.outcome && (
                  <p className="mt-1.5 text-xs text-neutral-400">
                    <span className="text-neutral-500">{t('supportDesk.card.outcome')}</span> · {n.outcome}
                  </p>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>,
      <>
        <Tag tone={FU_STATUS_TONE[fu.status]}>{t(`supportDesk.status.${fu.status}`)}</Tag>
        {fu.priority !== 'normal' && <Tag tone={FU_PRIORITY_TONE[fu.priority]}>{t(`supportDesk.priority.${fu.priority}`)}</Tag>}
      </>,
      'followUp',
    )

  // ---- 操作 / actions ----
  const actions = block(
    t('supportDesk.card.actions'),
    <>
      <ActionMenu card={card} me={me} onDone={() => { onChanged(); void load() }} onToast={onToast} />
      {!c.doNotContact && (
        <button
          type="button"
          className="mt-4 w-full rounded-full border border-[rgb(var(--down-rgb)/0.3)] px-3 py-2 text-xs font-medium text-[var(--down)] transition hover:bg-[var(--down-bg)]"
          onClick={() => setDncConfirm(true)}
        >
          {t('supportDesk.card.dnc')}
        </button>
      )}
    </>,
    undefined,
    'actions',
  )

  // ---- 工单 / tickets ----
  const tickets = block(
    t('supportDesk.card.tickets'),
    card.tickets.length === 0 ? (
      <p className="text-xs text-neutral-500">{t('tickets.empty')}</p>
    ) : (
      <ul className="-mx-2 space-y-0.5">
        {card.tickets.map((tk) => {
          const current = tk.id === currentTicketId
          return (
            <li key={tk.id}>
              <button
                type="button"
                disabled={!onOpenTicket || current}
                onClick={() => onOpenTicket?.(tk.id)}
                className={`flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left text-xs transition ${
                  current ? 'bg-white/[0.05]' : 'hover:bg-white/[0.04] disabled:hover:bg-transparent'
                }`}
              >
                <span className={`min-w-0 flex-1 truncate ${current ? 'font-medium text-neutral-50' : 'text-neutral-200'}`}>{tk.title}</span>
                <TicketStatus status={tk.status} label={t(`tickets.status.${tk.status}`)} />
                <span className="num w-10 shrink-0 text-right text-[11px] text-neutral-500">{fmtListTime(tk.updatedAt)}</span>
              </button>
            </li>
          )
        })}
      </ul>
    ),
    undefined,
    'tickets',
  )

  const conversions = block(t('supportDesk.card.conversions'), <ConversionTimeline items={card.conversions} />, undefined, 'conversions')

  const dncModal = dncConfirm && (
    <ConfirmModal
      center
      danger
      busy={saving}
      title={t('supportDesk.card.dnc')}
      message={t('supportDesk.card.dncBody')}
      onConfirm={() => void doNotContact()}
      onCancel={() => setDncConfirm(false)}
    />
  )

  if (wide) {
    return (
      <div className="px-4 pb-6 pt-4 sm:px-6 sm:pb-8 sm:pt-5">
        {compliance}
        <div className="space-y-4">
          <section className="sd-block">
            {identity}
            {openAccountBtn && <div className="mt-4 sm:hidden">{openAccountBtn}</div>}
            <div className="mt-5">{facts}</div>
          </section>
          <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
            <div className="space-y-4">
              {followUp}
              {conversions}
            </div>
            <div className="space-y-4">
              {profile}
              {mt5}
              {actions}
              {tickets}
            </div>
          </div>
        </div>
        {dncModal}
      </div>
    )
  }

  return (
    <div className="pb-4">
      {compliance}
      <div className="space-y-4 px-5 pb-5 pt-5">
        {identity}
        {facts}
        {openAccountBtn}
      </div>
      {profile}
      {mt5}
      {followUp}
      {actions}
      {tickets}
      {conversions}
      {dncModal}
    </div>
  )
}
