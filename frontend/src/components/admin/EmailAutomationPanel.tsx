// 自动邮件面板：规则列表（开关、情景、近 7 天发送情况）→ 编辑规则（情景 + 延迟 + 模板，实时预览、
// 估算人数、发测试信）→ 每条规则的发送记录。
// 规则建出来是关着的；打开 = 从现在起满足条件的人才发，之前就满足的不补发（后端 activated_at）。
// 判定和发送都在后端：每 5 分钟扫一遍条件，信由群发那条发送循环发出（共用每日上限，自动邮件优先），
// 每人每天最多一封。这里只管规则本身。
// Automated email: rule list (toggle, trigger, last-7-day numbers) → rule editor (trigger + delay +
// template, live preview, estimate, test send) → each rule's send log. Rules start disabled; enabling
// counts only events from then on (no backfill). Matching and sending live in the backend (5-minute
// scan, shared broadcast send loop and daily cap, one automated email per person per day).
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { adminApi, isAbortError } from '../../api/client'
import { fmtTime, localizeApiError } from '../../api/utils'
import type {
  EmailAudiencePlan,
  EmailAutomation,
  EmailAutomationCondition,
  EmailAutomationEstimate,
  EmailAutomationInput,
  EmailAutomationList,
  EmailAutomationSend,
  EmailAutomationSendStatus,
  EmailAutomationTrigger,
  EmailContentInput,
  EmailPreview,
  EmailStatus,
} from '../../api/types'
import { useToast } from '../../utils/useToast'
import ConfirmModal from '../ConfirmModal'
import Select from '../Select'
import { SkeletonLine } from '../Skeleton'
import { EmailBodyField, useDebounced } from './EmailPanel'
import { MIN_DELAY, PRESETS, TRIGGER_ORDER } from './emailAutomationTemplates'

const PLAN_FILTERS: EmailAudiencePlan[] = ['all', 'FREE', 'PRO', 'TRIAL', 'PAID']
const UNITS = { minutes: 1, hours: 60, days: 24 * 60 } as const
type Unit = keyof typeof UNITS
const SEND_STATUSES: Array<EmailAutomationSendStatus | ''> = ['', 'sent', 'pending', 'failed', 'skipped']
const SENDS_PAGE = 50
// 变量：点一下插进当前聚焦的那个框 / variables: click to insert into the focused field
const VARIABLES_ZH = ['{昵称}', '{邮箱}', '{到期日期}', '{剩余天数}', '{MT5账号}', '{网站链接}']
const VARIABLES_EN = ['{nickname}', '{email}', '{expiry_date}', '{days_left}', '{mt5_login}', '{site_url}']

// 分钟数 → 最顺手的单位 / minutes → the most natural unit
function splitDelay(minutes: number): { value: number; unit: Unit } {
  if (minutes > 0 && minutes % UNITS.days === 0) return { value: minutes / UNITS.days, unit: 'days' }
  if (minutes > 0 && minutes % UNITS.hours === 0) return { value: minutes / UNITS.hours, unit: 'hours' }
  return { value: minutes, unit: 'minutes' }
}

interface Draft {
  id: string | null
  name: string
  trigger: EmailAutomationTrigger
  delayValue: number
  delayUnit: Unit
  planFilter: EmailAudiencePlan
  maxTimes: number | null
  priority: number
  content: EmailContentInput
}

function draftFromPreset(trigger: EmailAutomationTrigger): Draft {
  const p = PRESETS[trigger]
  const d = splitDelay(p.delayMinutes)
  return {
    id: null,
    name: p.name,
    trigger,
    delayValue: d.value,
    delayUnit: d.unit,
    planFilter: 'all',
    maxTimes: p.maxTimes,
    priority: 100,
    content: { kind: p.kind, subjectZh: p.subjectZh, bodyZh: p.bodyZh, subjectEn: p.subjectEn, bodyEn: p.bodyEn },
  }
}

function draftFromRule(r: EmailAutomation): Draft {
  const d = splitDelay(r.delayMinutes)
  return {
    id: r.id,
    name: r.name,
    trigger: r.trigger,
    delayValue: d.value,
    delayUnit: d.unit,
    planFilter: r.planFilter,
    maxTimes: r.maxTimes,
    priority: r.priority,
    content: { kind: r.kind, subjectZh: r.subjectZh, bodyZh: r.bodyZh, subjectEn: r.subjectEn, bodyEn: r.bodyEn },
  }
}

function conditionOf(d: Draft): EmailAutomationCondition {
  return {
    trigger: d.trigger,
    delayMinutes: Math.max(0, Math.round((Number(d.delayValue) || 0) * UNITS[d.delayUnit])),
    planFilter: d.planFilter,
    maxTimes: d.trigger === 'inactive' ? d.maxTimes : null,
    kind: d.content.kind,
  }
}

function contentComplete(c: EmailContentInput): boolean {
  const zh = !!(c.subjectZh.trim() && c.bodyZh.trim())
  const en = !!(c.subjectEn.trim() && c.bodyEn.trim())
  const half = !!c.subjectZh.trim() !== !!c.bodyZh.trim() || !!c.subjectEn.trim() !== !!c.bodyEn.trim()
  return (zh || en) && !half
}

export default function EmailAutomationPanel() {
  const { t } = useTranslation()
  const { toast, showToast } = useToast()
  const showErr = (err: unknown, fallbackKey: string) =>
    showToast('err', err instanceof Error ? localizeApiError(err.message) : t(fallbackKey))

  const [status, setStatus] = useState<EmailStatus | null>(null)
  const [list, setList] = useState<EmailAutomationList | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<{ kind: 'enable' | 'disable' | 'delete'; rule: EmailAutomation } | null>(null)
  const [logRule, setLogRule] = useState<EmailAutomation | null>(null)

  const refresh = () => {
    adminApi.emailStatus().then(setStatus).catch(() => {})
    adminApi
      .listEmailAutomations()
      .then(setList)
      .catch((err) => {
        setList((prev) => prev ?? { rules: [], pause: null })
        showErr(err, 'admin.loadError')
      })
  }
  useEffect(refresh, [])

  const delayText = (trigger: EmailAutomationTrigger, minutes: number) => {
    const { value, unit } = splitDelay(minutes)
    const amount = minutes === 0 ? '' : t(`admin.emailAuto.unitN.${unit}`, { n: value })
    return t(`admin.emailAuto.desc.${trigger}${minutes === 0 ? 'Now' : ''}`, { delay: amount })
  }

  const toggle = async (rule: EmailAutomation, enabled: boolean) => {
    if (busy) return
    setBusy(rule.id)
    try {
      const updated = await adminApi.setEmailAutomationEnabled(rule.id, enabled)
      setList((prev) => prev && { ...prev, rules: prev.rules.map((r) => (r.id === rule.id ? updated : r)) })
      showToast('ok', t(enabled ? 'admin.emailAuto.enabledOk' : 'admin.emailAuto.disabledOk'))
    } catch (err) {
      showErr(err, 'admin.saveError')
    } finally {
      setBusy(null)
      setConfirm(null)
    }
  }

  const remove = async (rule: EmailAutomation) => {
    if (busy) return
    setBusy(rule.id)
    try {
      await adminApi.deleteEmailAutomation(rule.id)
      setList((prev) => prev && { ...prev, rules: prev.rules.filter((r) => r.id !== rule.id) })
      if (logRule?.id === rule.id) setLogRule(null)
      showToast('ok', t('admin.saved'))
    } catch (err) {
      showErr(err, 'admin.saveError')
    } finally {
      setBusy(null)
      setConfirm(null)
    }
  }

  const resumeAll = async () => {
    if (busy) return
    setBusy('resume')
    try {
      await adminApi.resumeEmailAutomations()
      refresh()
      showToast('ok', t('admin.saved'))
    } catch (err) {
      showErr(err, 'admin.saveError')
    } finally {
      setBusy(null)
    }
  }

  const pauseText = (reason: string) => {
    if (reason === 'quota_daily') return t('admin.emailAuto.pause.quotaDaily')
    if (reason === 'quota_monthly') return t('admin.emailAuto.pause.quotaMonthly')
    if (reason.startsWith('provider_rejected_')) return t('admin.emailAuto.pause.provider', { code: reason.slice('provider_rejected_'.length) })
    return reason
  }

  return (
    <div>
      {toast && (
        <div
          className={`mb-4 rounded-lg border px-4 py-2.5 text-sm ${
            toast.kind === 'err' ? 'border-down/40 bg-down/15 text-down' : 'border-up/40 bg-up/15 text-up'
          }`}
        >
          {toast.text}
        </div>
      )}
      {status && !status.configured && (
        <div className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-200">
          {t('admin.email.notConfigured')}
        </div>
      )}
      {list?.pause && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-200">
          <span className="flex-1">
            {pauseText(list.pause.reason)} {t('admin.emailAuto.pause.until', { time: fmtTime(list.pause.until) })}
          </span>
          <button type="button" className="btn-ghost px-3 py-1 text-xs" disabled={!!busy} onClick={resumeAll}>
            {t('admin.emailAuto.pause.resume')}
          </button>
        </div>
      )}

      {draft ? (
        <RuleEditor
          draft={draft}
          original={draft.id ? list?.rules.find((r) => r.id === draft.id) ?? null : null}
          configured={status?.configured !== false}
          onChange={setDraft}
          onCancel={() => setDraft(null)}
          onSaved={(rule, created) => {
            setList((prev) =>
              prev && {
                ...prev,
                rules: created ? [...prev.rules, rule] : prev.rules.map((r) => (r.id === rule.id ? rule : r)),
              },
            )
            setDraft(null)
            showToast('ok', t(created ? 'admin.emailAuto.createdOk' : 'admin.saved'))
          }}
          onToast={showToast}
          delayText={delayText}
        />
      ) : (
        <div className="glass overflow-x-auto p-0">
          <div className="flex flex-wrap items-center gap-3 px-4 pt-4">
            <div className="min-w-0 flex-1">
              <h3 className="font-display text-base font-semibold text-neutral-100">{t('admin.emailAuto.title')}</h3>
              <p className="mt-1 text-xs text-neutral-500">{t('admin.emailAuto.intro')}</p>
            </div>
            {status && (
              <span className="text-xs text-neutral-500">
                {status.dailyCap > 0
                  ? t('admin.email.quota', { sent: status.sentToday, cap: status.dailyCap })
                  : t('admin.email.quotaUnlimited', { sent: status.sentToday })}
              </span>
            )}
            <button type="button" className="btn-ghost px-3 py-1 text-xs" onClick={refresh}>
              {t('admin.email.refresh')}
            </button>
            <button type="button" className="btn-primary px-4 py-1.5 text-sm" onClick={() => setDraft(draftFromPreset('signup'))}>
              {t('admin.emailAuto.create')}
            </button>
          </div>
          {list === null ? (
            <div className="flex flex-col gap-3 p-5">
              <SkeletonLine width="55%" height={14} />
              <SkeletonLine width="40%" height={14} />
            </div>
          ) : list.rules.length === 0 ? (
            <div className="py-10 text-center text-sm text-neutral-500">{t('admin.emailAuto.empty')}</div>
          ) : (
            <table className="mt-3 w-full min-w-[860px] text-left text-sm">
              <thead className="border-b border-white/5 text-xs text-neutral-500">
                <tr>
                  <th className="px-4 py-2 font-normal">{t('admin.emailAuto.colEnabled')}</th>
                  <th className="px-4 py-2 font-normal">{t('admin.emailAuto.colRule')}</th>
                  <th className="px-4 py-2 font-normal">{t('admin.emailAuto.colPriority')}</th>
                  <th className="px-4 py-2 font-normal">{t('admin.emailAuto.col7d')}</th>
                  <th className="px-4 py-2 font-normal">{t('admin.emailAuto.colTotal')}</th>
                  <th className="px-4 py-2 font-normal">{t('admin.colAction')}</th>
                </tr>
              </thead>
              <tbody>
                {list.rules.map((r) => (
                  <tr key={r.id} className="border-b border-white/5 align-top last:border-0">
                    <td className="px-4 py-2.5">
                      <button
                        type="button"
                        role="switch"
                        aria-checked={r.enabled}
                        aria-label={t('admin.emailAuto.colEnabled')}
                        disabled={!!busy}
                        onClick={() => setConfirm({ kind: r.enabled ? 'disable' : 'enable', rule: r })}
                        className={`relative h-5 w-9 rounded-full transition-colors disabled:opacity-40 ${
                          r.enabled ? 'bg-prism-500' : 'bg-white/15'
                        }`}
                      >
                        <span
                          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${r.enabled ? 'left-[18px]' : 'left-0.5'}`}
                        />
                      </button>
                    </td>
                    <td className="max-w-[340px] px-4 py-2.5">
                      <div className="truncate text-neutral-100" title={r.name}>{r.name}</div>
                      <div className="mt-0.5 text-xs text-neutral-400">
                        {delayText(r.trigger, r.delayMinutes)}
                        {r.trigger === 'inactive' && r.maxTimes ? ` · ${t('admin.emailAuto.maxTimesN', { n: r.maxTimes })}` : ''}
                      </div>
                      <div className="mt-0.5 text-xs text-neutral-500">
                        {[
                          t(`admin.email.kind_${r.kind}`),
                          r.planFilter !== 'all' && t(`admin.email.plan.${r.planFilter}`),
                          r.enabled && r.activatedAt && t('admin.emailAuto.since', { time: fmtTime(r.activatedAt) }),
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs text-neutral-400">{r.priority}</td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-xs text-neutral-300">
                      <div>{t('admin.emailAuto.sentN', { n: r.sent7d })}</div>
                      <div className="mt-0.5 text-neutral-500">
                        {[
                          r.pending > 0 && t('admin.email.pendingN', { n: r.pending }),
                          r.failed7d > 0 && t('admin.email.failedN', { n: r.failed7d }),
                          r.skipped7d > 0 && t('admin.email.skippedN', { n: r.skipped7d }),
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs text-neutral-400">{r.sentTotal}</td>
                    <td className="whitespace-nowrap px-4 py-2.5">
                      <button
                        type="button"
                        className="mr-1 rounded px-2 py-1 text-xs text-prism-200 hover:bg-white/10"
                        onClick={() => setDraft(draftFromRule(r))}
                      >
                        {t('admin.emailAuto.edit')}
                      </button>
                      <button
                        type="button"
                        className="mr-1 rounded px-2 py-1 text-xs text-neutral-300 hover:bg-white/10"
                        onClick={() => setLogRule(logRule?.id === r.id ? null : r)}
                      >
                        {t('admin.emailAuto.log')}
                      </button>
                      <button
                        type="button"
                        className="rounded px-2 py-1 text-xs text-down hover:bg-white/10 disabled:opacity-40"
                        disabled={!!busy}
                        onClick={() => setConfirm({ kind: 'delete', rule: r })}
                      >
                        {t('admin.emailAuto.delete')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {!draft && logRule && <SendLog key={logRule.id} rule={logRule} onClose={() => setLogRule(null)} />}

      {confirm && (
        <ConfirmModal
          title={t(`admin.emailAuto.confirm.${confirm.kind}Title`, { name: confirm.rule.name })}
          message={t(`admin.emailAuto.confirm.${confirm.kind}Body`, { n: confirm.rule.pending })}
          confirmLabel={t(`admin.emailAuto.confirm.${confirm.kind}`)}
          danger={confirm.kind !== 'enable'}
          busy={busy === confirm.rule.id}
          onConfirm={() => (confirm.kind === 'delete' ? remove(confirm.rule) : toggle(confirm.rule, confirm.kind === 'enable'))}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  )
}

function RuleEditor({
  draft,
  original,
  configured,
  onChange,
  onCancel,
  onSaved,
  onToast,
  delayText,
}: {
  draft: Draft
  original: EmailAutomation | null
  configured: boolean
  onChange: (d: Draft) => void
  onCancel: () => void
  onSaved: (rule: EmailAutomation, created: boolean) => void
  onToast: (kind: 'ok' | 'err', text: string) => void
  delayText: (trigger: EmailAutomationTrigger, minutes: number) => string
}) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState<string | null>(null)
  const [preview, setPreview] = useState<EmailPreview | null>(null)
  const [showText, setShowText] = useState(false)
  const [estimate, setEstimate] = useState<EmailAutomationEstimate | null>(null)
  const [estimateErr, setEstimateErr] = useState(false)
  // 最近聚焦的输入框：点变量就插到这里 / the last focused field receives a clicked variable
  const focused = useRef<{ key: keyof EmailContentInput; el: HTMLInputElement | HTMLTextAreaElement } | null>(null)

  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch })
  const setContent = (patch: Partial<EmailContentInput>) => onChange({ ...draft, content: { ...draft.content, ...patch } })

  const condition = useMemo(() => conditionOf(draft), [draft])
  const minDelay = MIN_DELAY[draft.trigger]
  const delayOk = condition.delayMinutes >= minDelay
  const contentOk = contentComplete(draft.content)
  const canSave = !!draft.name.trim() && delayOk && contentOk && Number(draft.priority) >= 1

  // 改了触发条件的已开启规则：保存后排队中的信不再发、从现在重新算 / condition change on a live rule
  const conditionChanged =
    !!original?.enabled &&
    (original.trigger !== condition.trigger ||
      original.delayMinutes !== condition.delayMinutes ||
      original.planFilter !== condition.planFilter ||
      (original.maxTimes ?? null) !== (condition.maxTimes ?? null) ||
      original.kind !== condition.kind)

  // 换情景：新建的规则顺手换成那个情景的默认模板；已有规则只换情景，不动正文
  // switching trigger: a new rule takes that trigger's preset; an existing rule keeps its text
  const changeTrigger = (trigger: EmailAutomationTrigger) => {
    if (draft.id) {
      const floor = MIN_DELAY[trigger]
      const cur = conditionOf(draft).delayMinutes
      const d = cur < floor ? splitDelay(floor) : { value: draft.delayValue, unit: draft.delayUnit }
      set({ trigger, delayValue: d.value, delayUnit: d.unit, maxTimes: trigger === 'inactive' ? draft.maxTimes ?? 2 : null })
    } else {
      onChange({ ...draftFromPreset(trigger), planFilter: draft.planFilter, priority: draft.priority })
    }
  }

  const debouncedCondition = useDebounced(condition, 400)
  useEffect(() => {
    if (debouncedCondition.delayMinutes < MIN_DELAY[debouncedCondition.trigger]) {
      setEstimate(null)
      return
    }
    const ctrl = new AbortController()
    setEstimateErr(false)
    adminApi
      .estimateEmailAutomation(debouncedCondition, ctrl.signal)
      .then(setEstimate)
      .catch((err) => {
        if (!isAbortError(err)) setEstimateErr(true)
      })
    return () => ctrl.abort()
  }, [debouncedCondition])

  const debouncedContent = useDebounced(draft.content, 500)
  const debouncedTrigger = useDebounced(draft.trigger, 500)
  useEffect(() => {
    if (!contentComplete(debouncedContent)) {
      setPreview(null)
      return
    }
    const ctrl = new AbortController()
    adminApi
      .previewEmailAutomation(debouncedTrigger, debouncedContent, ctrl.signal)
      .then(setPreview)
      .catch(() => {})
    return () => ctrl.abort()
  }, [debouncedContent, debouncedTrigger])

  const insertVariable = (v: string) => {
    const f = focused.current
    if (!f) return
    const el = f.el
    const value = draft.content[f.key] as string
    const start = el.selectionStart ?? value.length
    const end = el.selectionEnd ?? start
    setContent({ [f.key]: value.slice(0, start) + v + value.slice(end) } as Partial<EmailContentInput>)
    window.requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(start + v.length, start + v.length)
    })
  }

  const payload = (): EmailAutomationInput => ({
    name: draft.name.trim(),
    condition,
    content: draft.content,
    priority: Math.round(Number(draft.priority) || 100),
  })

  const save = async () => {
    if (busy || !canSave) return
    setBusy('save')
    try {
      const rule = draft.id
        ? await adminApi.updateEmailAutomation(draft.id, payload())
        : await adminApi.createEmailAutomation(payload())
      onSaved(rule, !draft.id)
    } catch (err) {
      onToast('err', err instanceof Error ? localizeApiError(err.message) : t('admin.saveError'))
    } finally {
      setBusy(null)
    }
  }

  const sendTest = async () => {
    if (busy || !contentOk) return
    setBusy('test')
    try {
      const res = await adminApi.testEmailAutomation(draft.trigger, draft.content)
      onToast('ok', t('admin.email.testSent', { to: res.to }))
    } catch (err) {
      onToast('err', err instanceof Error ? localizeApiError(err.message) : t('admin.saveError'))
    } finally {
      setBusy(null)
    }
  }

  const textField = (key: 'subjectZh' | 'subjectEn', label: string) => (
    <label className="block">
      <span className="mb-1 block text-xs text-neutral-400">{label}</span>
      <input
        className="input w-full py-1.5 text-sm"
        value={draft.content[key]}
        maxLength={150}
        onFocus={(e) => (focused.current = { key, el: e.currentTarget })}
        onChange={(e) => setContent({ [key]: e.target.value } as Partial<EmailContentInput>)}
      />
    </label>
  )
  const bodyField = (key: 'bodyZh' | 'bodyEn', label: string) => (
    <div onFocusCapture={(e) => {
      if (e.target instanceof HTMLTextAreaElement) focused.current = { key, el: e.target }
    }}>
      <EmailBodyField
        label={label}
        value={draft.content[key]}
        onChange={(v) => setContent({ [key]: v } as Partial<EmailContentInput>)}
        onError={(text) => onToast('err', text)}
      />
    </div>
  )

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="glass p-4">
        <div className="mb-4 flex items-center gap-3">
          <h3 className="flex-1 font-display text-base font-semibold text-neutral-100">
            {draft.id ? t('admin.emailAuto.editTitle') : t('admin.emailAuto.createTitle')}
          </h3>
        </div>

        <div className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs text-neutral-400">{t('admin.emailAuto.name')}</span>
            <input className="input w-full py-1.5 text-sm" value={draft.name} maxLength={60} onChange={(e) => set({ name: e.target.value })} />
          </label>

          <div>
            <span className="mb-1 block text-xs text-neutral-400">{t('admin.emailAuto.trigger')}</span>
            <Select
              value={draft.trigger}
              onChange={(v) => changeTrigger(v as EmailAutomationTrigger)}
              ariaLabel={t('admin.emailAuto.trigger')}
              options={TRIGGER_ORDER.map((tr) => ({ value: tr, label: t(`admin.emailAuto.trig.${tr}`) }))}
              className="w-full"
            />
            <p className="mt-1 text-xs text-neutral-500">{t(`admin.emailAuto.trigHint.${draft.trigger}`)}</p>
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <label className="block">
              <span className="mb-1 block text-xs text-neutral-400">{t(`admin.emailAuto.delayLabel.${draft.trigger}`)}</span>
              <input
                type="number"
                min={0}
                className="input w-28 py-1.5 text-sm"
                value={draft.delayValue}
                onChange={(e) => set({ delayValue: Math.max(0, Number(e.target.value)) })}
              />
            </label>
            <Select
              value={draft.delayUnit}
              onChange={(v) => set({ delayUnit: v as Unit })}
              ariaLabel={t(`admin.emailAuto.delayLabel.${draft.trigger}`)}
              options={(Object.keys(UNITS) as Unit[]).map((u) => ({ value: u, label: t(`admin.emailAuto.unit.${u}`) }))}
            />
            {draft.trigger === 'inactive' && (
              <label className="block">
                <span className="mb-1 block text-xs text-neutral-400">{t('admin.emailAuto.maxTimes')}</span>
                <input
                  type="number"
                  min={1}
                  max={20}
                  className="input w-24 py-1.5 text-sm"
                  value={draft.maxTimes ?? ''}
                  onChange={(e) => set({ maxTimes: e.target.value ? Math.min(20, Math.max(1, Number(e.target.value))) : null })}
                />
              </label>
            )}
          </div>
          <p className={`text-xs ${delayOk ? 'text-neutral-400' : 'text-down'}`}>
            {delayOk
              ? delayText(draft.trigger, condition.delayMinutes)
              : t('admin.emailAuto.minDelay', { delay: t(`admin.emailAuto.unitN.${splitDelay(minDelay).unit}`, { n: splitDelay(minDelay).value }) })}
          </p>

          <div className="flex flex-wrap items-end gap-3">
            <div>
              <span className="mb-1 block text-xs text-neutral-400">{t('admin.colPlan')}</span>
              <Select
                value={draft.planFilter}
                onChange={(v) => set({ planFilter: v as EmailAudiencePlan })}
                ariaLabel={t('admin.colPlan')}
                options={PLAN_FILTERS.map((p) => ({ value: p, label: t(`admin.email.plan.${p}`) }))}
              />
            </div>
            <label className="block">
              <span className="mb-1 block text-xs text-neutral-400">{t('admin.emailAuto.priority')}</span>
              <input
                type="number"
                min={1}
                max={999}
                className="input w-24 py-1.5 text-sm"
                value={draft.priority}
                onChange={(e) => set({ priority: Number(e.target.value) })}
              />
            </label>
          </div>
          <p className="text-xs text-neutral-500">{t('admin.emailAuto.priorityHint')}</p>

          <div className="flex flex-wrap gap-4" role="radiogroup" aria-label={t('admin.email.kind')}>
            {(['marketing', 'notice'] as const).map((k) => (
              <label key={k} className="flex cursor-pointer items-center gap-2 text-sm text-neutral-300">
                <input
                  type="radio"
                  name="auto-email-kind"
                  checked={draft.content.kind === k}
                  onChange={() => setContent({ kind: k })}
                  className="accent-prism-500"
                />
                {t(`admin.email.kind_${k}`)}
              </label>
            ))}
          </div>
          <p className="text-xs text-neutral-500">{t(`admin.email.kindHint_${draft.content.kind}`)}</p>

          <div className="rounded-lg bg-white/5 px-3 py-2.5 text-sm">
            {!delayOk ? (
              <span className="text-neutral-500">-</span>
            ) : estimateErr ? (
              <span className="text-down">{t('admin.loadError')}</span>
            ) : !estimate ? (
              <SkeletonLine width="40%" height={14} />
            ) : (
              <div className="space-y-1">
                <div className="font-medium text-neutral-100">
                  {t(estimate.capped ? 'admin.emailAuto.estimateCapped' : 'admin.emailAuto.estimate', { n: estimate.count, days: estimate.days })}
                </div>
                {estimate.sample.length > 0 && (
                  <div className="break-all text-xs text-neutral-500">
                    {t('admin.email.sample')} {estimate.sample.join(', ')}
                    {estimate.count > estimate.sample.length ? ' …' : ''}
                  </div>
                )}
                <div className="text-xs text-neutral-500">{t('admin.emailAuto.estimateHint')}</div>
              </div>
            )}
          </div>

          <div className="space-y-3 border-t border-white/5 pt-3">
            {textField('subjectZh', t('admin.email.subjectZh'))}
            {bodyField('bodyZh', t('admin.email.bodyZh'))}
            {textField('subjectEn', t('admin.email.subjectEn'))}
            {bodyField('bodyEn', t('admin.email.bodyEn'))}
          </div>
          <div>
            <span className="mb-1 block text-xs text-neutral-400">{t('admin.emailAuto.variables')}</span>
            <div className="flex flex-wrap gap-1.5">
              {[...VARIABLES_ZH, ...VARIABLES_EN].map((v) => (
                <button
                  key={v}
                  type="button"
                  className="rounded-md bg-white/5 px-2 py-0.5 font-mono text-xs text-prism-200 hover:bg-white/10"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => insertVariable(v)}
                >
                  {v}
                </button>
              ))}
            </div>
            <p className="mt-1 text-xs text-neutral-500">{t('admin.emailAuto.variablesHint')}</p>
          </div>
          <p className="text-xs text-neutral-500">{t('admin.email.formatHint')}</p>
          {conditionChanged && <p className="text-xs text-amber-300">{t('admin.emailAuto.conditionChangedWarn')}</p>}
        </div>

        <div className="mt-4 flex flex-wrap justify-end gap-3">
          <button type="button" className="btn-ghost px-4 py-2 text-sm" onClick={onCancel} disabled={busy === 'save'}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn-ghost px-4 py-2 text-sm disabled:opacity-40"
            disabled={!contentOk || !!busy || !configured}
            onClick={sendTest}
          >
            {busy === 'test' ? t('common.loading') : t('admin.email.sendTest')}
          </button>
          <button type="button" className="btn-primary px-5 py-2 text-sm disabled:opacity-40" disabled={!canSave || !!busy} onClick={save}>
            {busy === 'save' ? t('common.loading') : t('admin.emailAuto.save')}
          </button>
        </div>
        {!draft.id && <p className="mt-2 text-right text-xs text-neutral-500">{t('admin.emailAuto.createHint')}</p>}
      </div>

      <div className="glass flex flex-col p-4">
        <div className="mb-3 flex items-center gap-3">
          <h3 className="flex-1 font-display text-base font-semibold text-neutral-100">{t('admin.email.preview')}</h3>
          <button type="button" className="btn-ghost px-3 py-1 text-xs" onClick={() => setShowText((v) => !v)} disabled={!preview}>
            {showText ? t('admin.email.showHtml') : t('admin.email.showText')}
          </button>
        </div>
        <p className="mb-2 text-xs text-neutral-500">{t('admin.emailAuto.previewHint')}</p>
        {preview ? (
          <>
            <div className="mb-2 truncate text-sm text-neutral-300">
              <span className="text-neutral-500">{t('admin.email.subjectLabel')}</span> {preview.subject}
            </div>
            {showText ? (
              <pre className="min-h-[420px] flex-1 overflow-auto whitespace-pre-wrap rounded-lg bg-black/30 p-3 text-xs text-neutral-300">
                {preview.text}
              </pre>
            ) : (
              // 沙箱 iframe：不给脚本、不给同源 / sandboxed: no scripts, no same-origin
              <iframe
                title={t('admin.email.preview')}
                sandbox=""
                srcDoc={`<!doctype html><meta charset="utf-8"><body style="margin:0;background:#fff">${preview.html}</body>`}
                className="min-h-[420px] w-full flex-1 rounded-lg bg-white"
              />
            )}
          </>
        ) : (
          <div className="flex min-h-[420px] flex-1 items-center justify-center rounded-lg border border-dashed border-white/10 text-sm text-neutral-500">
            {t('admin.email.previewEmpty')}
          </div>
        )}
      </div>
    </div>
  )
}

function SendLog({ rule, onClose }: { rule: EmailAutomation; onClose: () => void }) {
  const { t } = useTranslation()
  const [status, setStatus] = useState<EmailAutomationSendStatus | ''>('')
  const [offset, setOffset] = useState(0)
  const [data, setData] = useState<{ sends: EmailAutomationSend[]; total: number } | null>(null)
  const [err, setErr] = useState(false)

  useEffect(() => {
    let alive = true
    setErr(false)
    adminApi
      .listEmailAutomationSends(rule.id, status, SENDS_PAGE, offset)
      .then((res) => alive && setData(res))
      .catch(() => alive && setErr(true))
    return () => {
      alive = false
    }
  }, [rule.id, status, offset])

  const reason = (s: EmailAutomationSend) => {
    if (!s.error) return ''
    const key = `admin.emailAuto.reason.${s.error}`
    const text = t(key)
    return text === key ? s.error : text
  }

  return (
    <div className="glass mt-4 overflow-x-auto p-0">
      <div className="flex flex-wrap items-center gap-3 px-4 pt-4">
        <h3 className="min-w-0 flex-1 truncate font-display text-base font-semibold text-neutral-100">
          {t('admin.emailAuto.logTitle', { name: rule.name })}
        </h3>
        <Select
          value={status}
          onChange={(v) => {
            setStatus(v as EmailAutomationSendStatus | '')
            setOffset(0)
          }}
          ariaLabel={t('admin.colStatus')}
          options={SEND_STATUSES.map((s) => ({ value: s, label: t(`admin.emailAuto.sendStatus.${s || 'all'}`) }))}
        />
        <button type="button" className="btn-ghost px-3 py-1 text-xs" onClick={onClose}>
          {t('common.close')}
        </button>
      </div>
      {err ? (
        <div className="py-10 text-center text-sm text-down">{t('admin.loadError')}</div>
      ) : data === null ? (
        <div className="flex flex-col gap-3 p-5">
          <SkeletonLine width="55%" height={14} />
        </div>
      ) : data.sends.length === 0 ? (
        <div className="py-10 text-center text-sm text-neutral-500">{t('admin.emailAuto.logEmpty')}</div>
      ) : (
        <>
          <table className="mt-3 w-full min-w-[720px] text-left text-sm">
            <thead className="border-b border-white/5 text-xs text-neutral-500">
              <tr>
                <th className="px-4 py-2 font-normal">{t('admin.email.colUser')}</th>
                <th className="px-4 py-2 font-normal">{t('admin.colStatus')}</th>
                <th className="px-4 py-2 font-normal">{t('admin.emailAuto.colQueued')}</th>
                <th className="px-4 py-2 font-normal">{t('admin.emailAuto.colSent')}</th>
              </tr>
            </thead>
            <tbody>
              {data.sends.map((s) => (
                <tr key={s.id} className="border-b border-white/5 align-top last:border-0">
                  <td className="px-4 py-2.5">
                    <div className="text-neutral-200">{s.email ?? s.userId}</div>
                    {s.nickname && <div className="mt-0.5 text-xs text-neutral-500">{s.nickname}</div>}
                  </td>
                  <td className="px-4 py-2.5 text-xs">
                    <div className={s.status === 'failed' ? 'text-down' : s.status === 'sent' ? 'text-up' : 'text-neutral-300'}>
                      {t(`admin.emailAuto.sendStatus.${s.status}`)}
                    </div>
                    {reason(s) && <div className="mt-0.5 text-neutral-500">{reason(s)}</div>}
                    {s.status === 'pending' && s.dueAt && s.error === 'deferred' && (
                      <div className="mt-0.5 text-neutral-500">{t('admin.emailAuto.dueAt', { time: fmtTime(s.dueAt) })}</div>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-neutral-400">{fmtTime(s.createdAt)}</td>
                  <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-neutral-400">{s.sentAt ? fmtTime(s.sentAt) : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.total > SENDS_PAGE && (
            <div className="flex items-center justify-end gap-3 px-4 py-3 text-xs text-neutral-400">
              <span>
                {offset + 1}–{Math.min(offset + SENDS_PAGE, data.total)} / {data.total}
              </span>
              <button
                type="button"
                className="btn-ghost px-2.5 py-1 disabled:opacity-40"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - SENDS_PAGE))}
              >
                ‹
              </button>
              <button
                type="button"
                className="btn-ghost px-2.5 py-1 disabled:opacity-40"
                disabled={offset + SENDS_PAGE >= data.total}
                onClick={() => setOffset(offset + SENDS_PAGE)}
              >
                ›
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
