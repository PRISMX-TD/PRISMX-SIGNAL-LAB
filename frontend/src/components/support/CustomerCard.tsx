// 客户卡片（设计 §2.3 / §5.3）：顶部固定合规提示；按调用者权限脱敏后的资料（字段缺 = 无权看）；
// 查看完整电话（外包计入每日上限，429 时说清楚）；复制开户链接；跟进状态、下次跟进时间、
// 跟进记录（只追加）；转化时间线；工单；受限操作；「用户要求不再联系」。
// Customer card (design §2.3 / §5.3): a pinned compliance banner; profile data already masked
// for the caller (a missing field means no access); full-phone reveal (counted against the
// outsourced daily cap, 429 explained); copy the open-account link; follow-up status, next
// contact time and append-only notes; conversion timeline; tickets; restricted actions; and
// "the user asked not to be contacted".
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiHttpError, supportApi } from '../../api/client'
import { fmtDate, fmtDay, fmtTime } from '../../api/utils'
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
import { FU_PRIORITY_TONE, FU_STATUS_TONE, TICKET_STATUS_TONE, Tag, errText } from './supportUi'

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-neutral-500">{label}</dt>
      <dd className="min-w-0 break-words text-neutral-200">{children}</dd>
    </>
  )
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mt-4">
      <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">{title}</h3>
      <dl className="grid grid-cols-[minmax(0,6.5rem)_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">{children}</dl>
    </div>
  )
}

function Section({ title, children, extra }: { title: string; children: ReactNode; extra?: ReactNode }) {
  return (
    <section className="glass rounded-2xl p-4">
      <div className="mb-3 flex items-center gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">{title}</h3>
        {extra && <div className="ml-auto">{extra}</div>}
      </div>
      {children}
    </section>
  )
}

export default function CustomerCard({
  userId,
  me,
  onMeChanged,
  onChanged,
  onOpenTicket,
  onToast,
}: {
  userId: string
  me: SupportMe
  // 查看完整电话后回写今日用量 / reports today's reveal usage after a reveal
  onMeChanged: (patch: Partial<SupportMe>) => void
  // 跟进状态等变了，让列表刷新 / lets the lists refresh after a follow-up change
  onChanged: () => void
  onOpenTicket?: (ticketId: string) => void
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

  const load = useCallback(async () => {
    setLoadErr(null)
    try {
      const c = await supportApi.card(userId)
      setCard(c)
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
      <div className="glass rounded-2xl p-6 text-center text-sm">
        <p className="text-down">{loadErr}</p>
        <button type="button" className="btn-ghost mt-3 px-4 py-1.5 text-xs" onClick={() => void load()}>
          {t('supportDesk.retry')}
        </button>
      </div>
    )
  }
  if (!card) {
    return (
      <div className="glass space-y-3 rounded-2xl p-5">
        <SkeletonLine width="45%" height={14} />
        <SkeletonLine />
        <SkeletonLine width="70%" />
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

  const patchFollowUp = async (patch: { status?: FollowUpStaffStatus; nextContactAt?: string | null }, okMsg: string) => {
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

  return (
    <div className="flex flex-col gap-3">
      {/* 合规提示：吸顶、不可关闭（设计 §5.3）/ compliance strip, sticky and never dismissible (design §5.3) */}
      <div className="z-10 rounded-xl bg-ink-950 lg:sticky lg:top-0">
        <div role="note" className="rounded-xl border border-amber-400/25 bg-amber-400/[0.08] px-3 py-2 text-[11px] leading-relaxed text-amber-100">
          <b className="mr-1 font-semibold">{t('supportDesk.card.complianceTitle')}</b>
          {t('supportDesk.card.compliance')}
        </div>
      </div>

      <section className="glass rounded-2xl p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="min-w-0 truncate font-display text-lg font-semibold text-neutral-50">{c.nickname || t('supportDesk.card.noNickname')}</h2>
          <Tag tone={c.plan === 'PRO' ? 'bg-prism-600/20 text-prism-200' : 'bg-white/5 text-neutral-400'}>
            {c.plan}
            {c.planIsTrial ? ` · ${t('supportDesk.card.trial')}` : ''}
          </Tag>
          <Tag tone={c.emailVerified ? 'bg-up/15 text-up' : 'bg-amber-400/15 text-amber-300'}>
            {c.emailVerified ? t('supportDesk.card.verified') : t('supportDesk.card.unverified')}
          </Tag>
          {c.disabled && <Tag tone="bg-down/15 text-down">{t('supportDesk.card.disabled')}</Tag>}
          {c.doNotContact && <Tag tone="bg-down/15 text-down">{t('supportDesk.card.dncTag')}</Tag>}
        </div>

        <Group title={t('supportDesk.card.groupContact')}>
          <Row label={t('supportDesk.card.email')}>
            <span className="break-all font-mono">{c.email || '-'}</span>
          </Row>
          <Row label={t('supportDesk.card.phone')}>
            {!c.hasPhone ? (
              '-'
            ) : (
              <span className="inline-flex flex-wrap items-center gap-2">
                <span className="font-mono">{phone ?? c.phone}</span>
                {c.phoneMasked && !phone && (
                  <button
                    type="button"
                    onClick={() => void reveal()}
                    disabled={revealing}
                    className="rounded-md bg-white/5 px-2 py-0.5 text-[11px] text-prism-200 transition hover:bg-white/10 disabled:opacity-50"
                  >
                    {revealing ? t('common.loading') : t('supportDesk.card.reveal')}
                  </button>
                )}
                {c.phoneMasked && !phone && revealLeft != null && (
                  <span className="text-[11px] text-neutral-500">{t('supportDesk.card.revealLeft', { n: revealLeft })}</span>
                )}
              </span>
            )}
          </Row>
          <Row label={t('supportDesk.card.region')}>{c.region || '-'}</Row>
        </Group>

        <Group title={t('supportDesk.card.groupAccount')}>
          <Row label={t('supportDesk.card.registered')}>{fmtDay(c.createdAt, '-')}</Row>
          <Row label={t('supportDesk.card.lastActive')}>{c.lastActiveAt ? fmtTime(c.lastActiveAt) : '-'}</Row>
          <Row label={t('supportDesk.card.planExpires')}>
            {c.plan === 'PRO' ? (c.planExpiresAt ? fmtDay(c.planExpiresAt) : t('supportDesk.card.permanent')) : '-'}
          </Row>
          <Row label={t('supportDesk.card.trialUsed')}>{c.trialUsed ? t('supportDesk.yes') : t('supportDesk.no')}</Row>
          <Row label={t('supportDesk.card.online')}>
            {[c.bridgeOnline && 'Bridge', c.gatewayOnline && t('supportDesk.card.gateway')].filter(Boolean).join(' · ') || t('common.offline')}
          </Row>
          {c.competitions.length > 0 && (
            <Row label={t('supportDesk.card.competitions')}>{c.competitions.map((x) => x.name).join(' · ')}</Row>
          )}
          {c.paidTotalUsd != null && <Row label={t('supportDesk.card.paidTotal')}>{`$${c.paidTotalUsd.toFixed(2)}`}</Row>}
        </Group>

        <Group title={t('supportDesk.card.groupSource')}>
          <Row label={t('supportDesk.card.source')}>{c.inviteLabel || c.inviteCode || t('supportDesk.card.noSource')}</Row>
        </Group>

        {c.openAccountUrl && (
          <button type="button" className="btn-primary mt-4 w-full px-4 py-2 text-sm" onClick={() => void copyOpenAccount()}>
            {t('supportDesk.card.copyOpenAccount')}
          </button>
        )}
      </section>

      <Section title={t('supportDesk.card.mt5')}>
        {c.mt5Accounts.length === 0 ? (
          <p className="text-xs text-neutral-500">{t('supportDesk.card.noMt5')}</p>
        ) : (
          <ul className="grid gap-2">
            {c.mt5Accounts.map((a) => (
              <li key={a.id} className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5 text-xs">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-mono text-[13px] text-neutral-100">{a.login || t('supportDesk.card.bound')}</span>
                  {a.real != null && (
                    <Tag tone={a.real ? 'bg-up/15 text-up' : 'bg-white/5 text-neutral-400'}>
                      {a.real ? t('supportDesk.card.real') : t('supportDesk.card.demo')}
                    </Tag>
                  )}
                  <span className={`ml-auto text-[11px] ${a.online ? 'text-up' : 'text-neutral-500'}`}>{a.online ? t('common.online') : t('common.offline')}</span>
                </div>
                <div className="mt-1 break-words text-neutral-500">
                  {[a.broker, a.server].filter(Boolean).join(' · ')}
                </div>
                {(a.balance != null || a.balanceRange) && (
                  <div className="mt-1 text-neutral-400">
                    {t('supportDesk.card.balance')}{' '}
                    <span className="num text-neutral-200">
                      {a.balance != null ? `${a.balance.toFixed(2)}${a.currency ? ` ${a.currency}` : ''}` : a.balanceRange}
                    </span>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {fu && (
        <Section
          title={t('supportDesk.card.followUp')}
          extra={<Tag tone={FU_PRIORITY_TONE[fu.priority]}>{t(`supportDesk.priority.${fu.priority}`)}</Tag>}
        >
          <div className="mb-2 flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-neutral-500">{t('supportDesk.card.goal')}</span>
            <Tag tone="bg-white/5 text-neutral-300">{t(`supportDesk.goal.${fu.goal}`)}</Tag>
          </div>
          {fu.note && <p className="mb-3 whitespace-pre-wrap rounded-xl bg-white/[0.03] px-3 py-2 text-xs text-neutral-300">{fu.note}</p>}
          <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('supportDesk.card.status')}>
            {FOLLOW_UP_STAFF_STATUSES.map((s) => (
              <button
                key={s}
                type="button"
                disabled={saving}
                aria-pressed={fu.status === s}
                onClick={() => s !== fu.status && void patchFollowUp({ status: s }, t('supportDesk.card.statusSaved'))}
                className={`tag transition ${fu.status === s ? FU_STATUS_TONE[s] + ' ring-1 ring-current' : 'bg-white/5 text-neutral-500 hover:bg-white/10'}`}
              >
                {t(`supportDesk.status.${s}`)}
              </button>
            ))}
          </div>

          <h4 className="mb-2 mt-4 text-[11px] font-semibold text-neutral-400">{t('supportDesk.card.notes')}</h4>
          {card.notes.length === 0 ? (
            <p className="text-xs text-neutral-500">{t('supportDesk.card.noNotes')}</p>
          ) : (
            <ol className="space-y-2">
              {card.notes.map((n) => (
                <li key={n.id} className="rounded-xl bg-white/[0.03] px-3 py-2 text-xs">
                  <div className="flex flex-wrap items-center gap-1.5 text-neutral-500">
                    <span className="text-neutral-300">{n.authorName || '-'}</span>
                    <span>{t(`supportDesk.channel.${n.channel}`)}</span>
                    <span className="num ml-auto">{fmtDate(n.createdAt)}</span>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap break-words text-neutral-200">{n.content}</p>
                  {n.outcome && <p className="mt-1 text-neutral-400">{t('supportDesk.card.outcome')}: {n.outcome}</p>}
                </li>
              ))}
            </ol>
          )}
          <div className="mt-3 space-y-2 rounded-xl border border-white/[0.06] p-2.5">
            <div className="flex flex-wrap gap-2">
              <Select
                value={noteChannel}
                onChange={(v) => setNoteChannel(v as FollowUpChannel)}
                className="select-tight"
                ariaLabel={t('supportDesk.card.channel')}
                options={FOLLOW_UP_CHANNELS.map((ch) => ({ value: ch, label: t(`supportDesk.channel.${ch}`) }))}
              />
              <input
                className="input min-w-0 flex-1 py-1 text-xs"
                placeholder={t('supportDesk.card.outcomePlaceholder')}
                maxLength={200}
                value={noteOutcome}
                onChange={(e) => setNoteOutcome(e.target.value)}
              />
            </div>
            <textarea
              className="input min-h-[72px] w-full rounded-xl py-2 text-sm leading-relaxed"
              placeholder={t('supportDesk.card.notePlaceholder')}
              maxLength={5000}
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
            />
            <div className="flex items-center gap-2">
              <p className="min-w-0 flex-1 text-[11px] text-neutral-500">{t('supportDesk.card.appendOnly')}</p>
              <button type="button" className="btn-primary shrink-0 px-4 py-1.5 text-xs disabled:opacity-40" disabled={saving || !noteText.trim()} onClick={() => void addNote()}>
                {t('supportDesk.card.addNote')}
              </button>
            </div>
          </div>
        </Section>
      )}

      <Section title={t('supportDesk.card.actions')}>
        <ActionMenu card={card} me={me} onDone={() => { onChanged(); void load() }} onToast={onToast} />
        {!c.doNotContact && (
          <div className="mt-3 border-t border-white/[0.06] pt-3">
            <button
              type="button"
              className="w-full rounded-xl border border-down/30 px-3 py-1.5 text-xs text-down transition hover:bg-down/10"
              onClick={() => setDncConfirm(true)}
            >
              {t('supportDesk.card.dnc')}
            </button>
          </div>
        )}
      </Section>

      <Section title={t('supportDesk.card.tickets')}>
        {card.tickets.length === 0 ? (
          <p className="text-xs text-neutral-500">{t('tickets.empty')}</p>
        ) : (
          <ul className="-mx-2 space-y-0.5">
            {card.tickets.map((tk) => (
              <li key={tk.id}>
                <button
                  type="button"
                  disabled={!onOpenTicket}
                  onClick={() => onOpenTicket?.(tk.id)}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition hover:bg-white/5 disabled:hover:bg-transparent"
                >
                  <span className="min-w-0 flex-1 truncate text-neutral-200">{tk.title}</span>
                  <Tag tone={TICKET_STATUS_TONE[tk.status] ?? ''}>{t(`tickets.status.${tk.status}`)}</Tag>
                  <span className="num text-neutral-500">{fmtDay(tk.updatedAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={t('supportDesk.card.conversions')}>
        <ConversionTimeline items={card.conversions} />
      </Section>

      {dncConfirm && (
        <ConfirmModal
          center
          danger
          busy={saving}
          title={t('supportDesk.card.dnc')}
          message={t('supportDesk.card.dncBody')}
          onConfirm={() => void doNotContact()}
          onCancel={() => setDncConfirm(false)}
        />
      )}
    </div>
  )
}
