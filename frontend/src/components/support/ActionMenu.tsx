// 客户卡片上的受限操作（设计 §4）：重发验证邮件、解绑 MT5、重置试用、补偿天数、站内来信、
// 申请跟进、手动开户标记。每个操作一个小弹窗收齐参数；限制（试用终身一次、补偿超上限转审批、
// 只能联系自己跟进的人）全在后端，这里只把后端的回答说清楚。
// Restricted actions on the customer card (design §4). Each opens a small dialog for its inputs;
// every limit (one trial reset per user, over-cap comp days become a request, only contact your
// own follow-ups) is enforced server-side — this only explains the server's answer.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { supportApi } from '../../api/client'
import { FOLLOW_UP_GOALS, type FollowUpGoal, type SupportCard, type SupportMe } from '../../api/supportTypes'
import Select from '../Select'
import { DeskModal, errText } from './supportUi'

type Action = 'resend' | 'unbind' | 'resetTrial' | 'compDays' | 'message' | 'requestFollowUp' | 'requestConversion'

export default function ActionMenu({
  card,
  me,
  onDone,
  onToast,
}: {
  card: SupportCard
  me: SupportMe
  onDone: () => void
  onToast: (kind: 'ok' | 'err', text: string) => void
}) {
  const { t } = useTranslation()
  const c = card.customer
  const [open, setOpen] = useState<Action | null>(null)
  const [busy, setBusy] = useState(false)
  const [reason, setReason] = useState('')
  const [days, setDays] = useState('3')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [accountId, setAccountId] = useState('')
  const [goal, setGoal] = useState<FollowUpGoal>('open_mt5')
  const [server, setServer] = useState('')
  const [login, setLogin] = useState('')

  const start = (a: Action) => {
    setReason('')
    setDays('3')
    setTitle('')
    setBody('')
    setServer('')
    setLogin('')
    setAccountId(c.mt5Accounts[0]?.id ?? '')
    setOpen(a)
  }

  const run = async (fn: () => Promise<string>) => {
    setBusy(true)
    try {
      onToast('ok', await fn())
      setOpen(null)
      onDone()
    } catch (err) {
      onToast('err', errText(err, t('common.error')))
    } finally {
      setBusy(false)
    }
  }

  const canMessage = (me.isAdmin || !!card.followUp) && !c.doNotContact
  const daysNum = Number(days)
  const actions: { key: Action; show: boolean }[] = [
    { key: 'message', show: canMessage },
    { key: 'resend', show: !c.emailVerified },
    { key: 'compDays', show: true },
    { key: 'resetTrial', show: c.trialUsed },
    { key: 'unbind', show: c.mt5Accounts.length > 0 },
    { key: 'requestFollowUp', show: !card.followUp && !c.doNotContact },
    { key: 'requestConversion', show: true },
  ]

  const accountLabel = (id: string) => {
    const a = c.mt5Accounts.find((x) => x.id === id)
    if (!a) return id
    const kind = a.real == null ? '' : a.real ? t('supportDesk.card.real') : t('supportDesk.card.demo')
    return [a.login, kind, a.broker].filter(Boolean).join(' · ') || t('supportDesk.card.bound')
  }

  const reasonField = (required: boolean) => (
    <label className="block">
      <span className="mb-1 block text-xs text-neutral-400">
        {t('supportDesk.actions.reason')}
        {!required && ` ${t('supportDesk.actions.optional')}`}
      </span>
      <textarea className="input min-h-[64px] w-full" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
    </label>
  )

  return (
    <>
      <div className="flex flex-wrap gap-2">
        {actions.filter((a) => a.show).map((a) => (
          <button key={a.key} type="button" className="btn-ghost px-3 py-1.5 text-xs" onClick={() => start(a.key)}>
            {t(`supportDesk.actions.${a.key}`)}
          </button>
        ))}
      </div>

      {open === 'resend' && (
        <DeskModal
          title={t('supportDesk.actions.resend')}
          busy={busy}
          onClose={() => setOpen(null)}
          onConfirm={() =>
            void run(async () => {
              const r = await supportApi.resendVerification(c.id)
              return r.alreadyVerified ? t('supportDesk.actions.alreadyVerified') : t('supportDesk.actions.resendOk')
            })
          }
        >
          <p className="text-neutral-300">{t('supportDesk.actions.resendBody')}</p>
        </DeskModal>
      )}

      {open === 'unbind' && (
        <DeskModal
          title={t('supportDesk.actions.unbind')}
          busy={busy}
          danger
          disabled={!accountId || !reason.trim()}
          onClose={() => setOpen(null)}
          onConfirm={() =>
            void run(async () => {
              await supportApi.unbindMt5(c.id, accountId, reason.trim())
              return t('supportDesk.actions.unbindOk')
            })
          }
        >
          <p className="text-neutral-300">{t('supportDesk.actions.unbindBody')}</p>
          <Select
            value={accountId}
            onChange={setAccountId}
            ariaLabel={t('supportDesk.card.mt5')}
            options={c.mt5Accounts.map((a) => ({ value: a.id, label: accountLabel(a.id) }))}
          />
          {reasonField(true)}
        </DeskModal>
      )}

      {open === 'resetTrial' && (
        <DeskModal
          title={t('supportDesk.actions.resetTrial')}
          busy={busy}
          onClose={() => setOpen(null)}
          onConfirm={() =>
            void run(async () => {
              await supportApi.resetTrial(c.id, reason.trim())
              return t('supportDesk.actions.resetTrialOk')
            })
          }
        >
          <p className="text-neutral-300">{t(me.isAdmin ? 'supportDesk.actions.resetTrialBodyAdmin' : 'supportDesk.actions.resetTrialBody')}</p>
          {reasonField(false)}
        </DeskModal>
      )}

      {open === 'compDays' && (
        <DeskModal
          title={t('supportDesk.actions.compDays')}
          busy={busy}
          disabled={!Number.isInteger(daysNum) || daysNum < 1 || daysNum > 365 || !reason.trim()}
          onClose={() => setOpen(null)}
          onConfirm={() =>
            void run(async () => {
              const r = await supportApi.compDays(c.id, daysNum, reason.trim())
              return r.applied ? t('supportDesk.actions.compDaysOk', { n: daysNum }) : t('supportDesk.actions.compDaysQueued')
            })
          }
        >
          <p className="text-neutral-300">
            {me.isAdmin ? t('supportDesk.actions.compDaysBodyAdmin') : t('supportDesk.actions.compDaysBody', { n: me.settings.compDaysMax })}
          </p>
          <label className="block">
            <span className="mb-1 block text-xs text-neutral-400">{t('supportDesk.actions.days')}</span>
            <input type="number" min={1} max={365} inputMode="numeric" className="input w-32" value={days} onChange={(e) => setDays(e.target.value)} />
          </label>
          {!me.isAdmin && daysNum > me.settings.compDaysMax && (
            <p className="text-xs text-amber-300">{t('supportDesk.actions.compDaysOverCap')}</p>
          )}
          {reasonField(true)}
        </DeskModal>
      )}

      {open === 'message' && (
        <DeskModal
          title={t('supportDesk.actions.message')}
          busy={busy}
          disabled={!title.trim() || !body.trim()}
          confirmLabel={t('supportDesk.actions.send')}
          onClose={() => setOpen(null)}
          onConfirm={() =>
            void run(async () => {
              await supportApi.message(c.id, title.trim(), body.trim())
              return t('supportDesk.actions.messageOk')
            })
          }
        >
          <p className="text-neutral-300">{t('supportDesk.actions.messageBody')}</p>
          <input className="input w-full" placeholder={t('supportDesk.actions.messageTitle')} maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
          <textarea className="input min-h-[120px] w-full" placeholder={t('supportDesk.actions.messageText')} maxLength={5000} value={body} onChange={(e) => setBody(e.target.value)} />
        </DeskModal>
      )}

      {open === 'requestFollowUp' && (
        <DeskModal
          title={t('supportDesk.actions.requestFollowUp')}
          busy={busy}
          onClose={() => setOpen(null)}
          onConfirm={() =>
            void run(async () => {
              await supportApi.requestFollowUp(c.id, goal, reason.trim())
              return t('supportDesk.actions.requestSent')
            })
          }
        >
          <p className="text-neutral-300">{t('supportDesk.actions.requestFollowUpBody')}</p>
          <Select
            value={goal}
            onChange={(v) => setGoal(v as FollowUpGoal)}
            ariaLabel={t('supportDesk.card.goal')}
            options={FOLLOW_UP_GOALS.map((g) => ({ value: g, label: t(`supportDesk.goal.${g}`) }))}
          />
          {reasonField(false)}
        </DeskModal>
      )}

      {open === 'requestConversion' && (
        <DeskModal
          title={t('supportDesk.actions.requestConversion')}
          busy={busy}
          disabled={!server.trim() || !login.trim()}
          onClose={() => setOpen(null)}
          onConfirm={() =>
            void run(async () => {
              await supportApi.requestConversion(c.id, server.trim(), login.trim(), reason.trim())
              return t('supportDesk.actions.requestSent')
            })
          }
        >
          <p className="text-neutral-300">{t('supportDesk.actions.requestConversionBody')}</p>
          <input className="input w-full" placeholder={t('supportDesk.actions.server')} maxLength={100} value={server} onChange={(e) => setServer(e.target.value)} />
          <input className="input w-full" placeholder={t('supportDesk.actions.login')} maxLength={32} inputMode="numeric" value={login} onChange={(e) => setLogin(e.target.value)} />
          {reasonField(false)}
        </DeskModal>
      )}
    </>
  )
}
