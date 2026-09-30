// 群发邮件面板：写信（中英各一份，英文可不填）→ 选收件人（实时数人数）→ 预览 /
// 发测试信给自己 → 确认发送；下面是发送历史与进度。
// 「发送」只是把名单交给后端入队，真正发信在后端的后台循环里一封一封地发（限速、
// 每日上限），所以发送之后这里轮询历史列表看进度，而不是等一个长请求。
// 预览由后端渲染，与真正发出去的信是同一段代码，所见即所发。
// Email broadcast panel: compose (zh + optional en) → pick recipients (live count)
// → preview / test-send to yourself → confirm; history with progress below.
// Sending only enqueues — the backend loop delivers one by one (rate-limited,
// daily cap) — so the history list is polled for progress. The preview is
// rendered by the backend with the same code that builds the real message.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useToast } from '../../utils/useToast'
import { adminApi, isAbortError } from '../../api/client'
import { fmtTime, localizeApiError } from '../../api/utils'
import ConfirmModal from '../ConfirmModal'
import Select from '../Select'
import { SkeletonLine } from '../Skeleton'
import EmailRecipientPicker, { type Picked } from './EmailRecipientPicker'
import { shrinkImageForEmail } from './shrinkImage'
import type {
  EmailAudienceInput,
  EmailAudiencePlan,
  EmailAudienceSummary,
  EmailCampaign,
  EmailContentInput,
  EmailPreview,
  EmailStatus,
} from '../../api/types'

const EMPTY_CONTENT: EmailContentInput = { kind: 'marketing', subjectZh: '', bodyZh: '', subjectEn: '', bodyEn: '' }

// 活跃度下拉的取值 → 请求里的两个字段 / activity dropdown value → the two request fields
const ACTIVITY_OPTIONS = ['', 'active7', 'active30', 'active90', 'inactive30', 'inactive90'] as const
type Activity = (typeof ACTIVITY_OPTIONS)[number]
const PLAN_FILTERS: EmailAudiencePlan[] = ['all', 'FREE', 'PRO', 'TRIAL', 'PAID']

function activityFields(a: Activity): Pick<EmailAudienceInput, 'activeWithinDays' | 'inactiveForDays'> {
  if (a.startsWith('active')) return { activeWithinDays: Number(a.slice(6)), inactiveForDays: null }
  if (a.startsWith('inactive')) return { activeWithinDays: null, inactiveForDays: Number(a.slice(8)) }
  return { activeWithinDays: null, inactiveForDays: null }
}

// 粘贴的邮箱：逗号 / 分号 / 空白分隔都认 / pasted addresses, any common separator
function parseEmails(text: string): string[] {
  return Array.from(new Set(text.split(/[\s,;，；]+/).map((s) => s.trim().toLowerCase()).filter((s) => s.includes('@'))))
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const id = window.setTimeout(() => setV(value), ms)
    return () => window.clearTimeout(id)
  }, [value, ms])
  return v
}

// 正文输入框 + 「插入图片」：选图 → 转成邮件兼容的 JPEG / PNG（shrinkImageForEmail）→ 上传到图片存储
// → 在光标处插入 ![](地址)。图片单独占一段，前后补空行，免得和文字挤在同一行。
// Body textarea with "insert image": pick → convert to mail-safe JPEG / PNG
// (shrinkImageForEmail) → upload → insert ![](url) at the cursor as its own paragraph.
function EmailBodyField({
  label,
  value,
  onChange,
  onError,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  onError: (text: string) => void
}) {
  const { t } = useTranslation()
  const areaRef = useRef<HTMLTextAreaElement | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const [uploading, setUploading] = useState(false)

  const insert = (url: string) => {
    const el = areaRef.current
    const at = el ? el.selectionStart : value.length
    const before = value.slice(0, at).replace(/\s*$/, '')
    const after = value.slice(at).replace(/^\s*/, '')
    const snippet = `![](${url})`
    const next = [before, snippet, after].filter(Boolean).join('\n\n')
    onChange(next)
    // 光标放到图片那一行后面，接着打字就是下一段 / caret after the image, ready for the next paragraph
    const caret = (before ? before.length + 2 : 0) + snippet.length
    window.requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(caret, caret)
    })
  }

  const upload = async (file: File) => {
    setUploading(true)
    try {
      const res = await adminApi.uploadImage(await shrinkImageForEmail(file))
      insert(res.url)
    } catch (err) {
      onError(localizeApiError(err instanceof Error ? err.message : String(err)))
    } finally {
      setUploading(false)
      // 清空：否则再选同一个文件不触发 change / reset so re-picking the same file fires change
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <div className="block">
      <div className="mb-1 flex items-center gap-2">
        <span className="flex-1 text-xs text-neutral-400">{label}</span>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void upload(f)
          }}
        />
        <button
          type="button"
          className="btn-ghost px-2.5 py-0.5 text-xs disabled:opacity-40"
          disabled={uploading}
          onClick={() => fileRef.current?.click()}
        >
          {uploading ? t('admin.email.imageUploading') : t('admin.email.insertImage')}
        </button>
      </div>
      <textarea
        ref={areaRef}
        aria-label={label}
        className="input min-h-[160px] w-full rounded-xl py-2 text-sm leading-relaxed"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={20000}
      />
    </div>
  )
}

export default function EmailPanel({
  presetUserIds,
  onPresetCleared,
}: {
  // 从「用户管理」批量勾选带过来的用户 / users carried over from the Users tab selection
  presetUserIds?: string[]
  onPresetCleared?: () => void
}) {
  const { t } = useTranslation()
  const { toast, showToast } = useToast()
  const showErr = (err: unknown, fallbackKey: string) =>
    showToast('err', err instanceof Error ? localizeApiError(err.message) : t(fallbackKey))

  const [status, setStatus] = useState<EmailStatus | null>(null)
  const [campaigns, setCampaigns] = useState<EmailCampaign[] | null>(null)
  const [content, setContent] = useState<EmailContentInput>(EMPTY_CONTENT)
  const [mode, setMode] = useState<'filter' | 'list'>(presetUserIds?.length ? 'list' : 'filter')
  const [plan, setPlan] = useState<EmailAudiencePlan>('all')
  const [activity, setActivity] = useState<Activity>('')
  // 「指定用户」勾选的人：id → 邮箱（用户管理带来的只有 id）/ picked users: id → email
  const [picked, setPicked] = useState<Picked>(() => Object.fromEntries((presetUserIds ?? []).map((id) => [id, ''])))
  const userIds = useMemo(() => Object.keys(picked), [picked])
  // 从用户管理带来的那批被清空之后，别在下次进页签时又带回来
  // once the carried-over batch is emptied, don't bring it back on the next visit
  useEffect(() => {
    if (userIds.length === 0 && presetUserIds?.length) onPresetCleared?.()
  }, [userIds.length])
  const [emailsText, setEmailsText] = useState('')
  const [summary, setSummary] = useState<EmailAudienceSummary | null>(null)
  const [summaryErr, setSummaryErr] = useState(false)
  const [preview, setPreview] = useState<EmailPreview | null>(null)
  const [showText, setShowText] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [confirmSend, setConfirmSend] = useState(false)
  const [cancelTarget, setCancelTarget] = useState<EmailCampaign | null>(null)

  const zhDone = !!(content.subjectZh.trim() && content.bodyZh.trim())
  const enDone = !!(content.subjectEn.trim() && content.bodyEn.trim())
  const halfFilled =
    !!content.subjectZh.trim() !== !!content.bodyZh.trim() || !!content.subjectEn.trim() !== !!content.bodyEn.trim()
  const contentOk = (zhDone || enDone) && !halfFilled

  const audience: EmailAudienceInput = useMemo(
    () => ({
      mode,
      plan,
      ...activityFields(activity),
      userIds: mode === 'list' ? userIds : [],
      emails: mode === 'list' ? parseEmails(emailsText) : [],
    }),
    [mode, plan, activity, userIds, emailsText],
  )
  const audienceOk = mode === 'filter' || audience.userIds.length > 0 || audience.emails.length > 0

  const refresh = () => {
    adminApi.emailStatus().then(setStatus).catch(() => {})
    adminApi
      .listEmails()
      .then((res) => setCampaigns(res.campaigns))
      .catch((err) => {
        setCampaigns((prev) => prev ?? [])
        showErr(err, 'admin.loadError')
      })
  }
  useEffect(refresh, [])

  // 有在发的就每 5 秒刷一次进度 / poll every 5s while something is sending
  const anySending = !!campaigns?.some((c) => c.status === 'sending')
  useEffect(() => {
    if (!anySending) return
    const id = window.setInterval(refresh, 5000)
    return () => window.clearInterval(id)
  }, [anySending])

  // 人数：条件一变就重数（防抖 + 撤掉上一个请求）/ recount on change, debounced and abortable
  const debouncedAudience = useDebounced(audience, 400)
  const debouncedKind = useDebounced(content.kind, 400)
  useEffect(() => {
    if (!(debouncedAudience.mode === 'filter' || debouncedAudience.userIds.length || debouncedAudience.emails.length)) {
      setSummary(null)
      return
    }
    const ctrl = new AbortController()
    setSummaryErr(false)
    adminApi
      .emailAudience(debouncedKind, debouncedAudience, ctrl.signal)
      .then(setSummary)
      .catch((err) => {
        if (!isAbortError(err)) setSummaryErr(true)
      })
    return () => ctrl.abort()
  }, [debouncedAudience, debouncedKind])

  // 预览：内容填完整了才渲染 / render the preview once the content is complete
  const debouncedContent = useDebounced(content, 500)
  useEffect(() => {
    const c = debouncedContent
    const ok =
      (!!(c.subjectZh.trim() && c.bodyZh.trim()) || !!(c.subjectEn.trim() && c.bodyEn.trim())) &&
      !!c.subjectZh.trim() === !!c.bodyZh.trim() &&
      !!c.subjectEn.trim() === !!c.bodyEn.trim()
    if (!ok) {
      setPreview(null)
      return
    }
    const ctrl = new AbortController()
    adminApi
      .emailPreview(c, ctrl.signal)
      .then(setPreview)
      .catch(() => {})
    return () => ctrl.abort()
  }, [debouncedContent])

  const set = (patch: Partial<EmailContentInput>) => setContent((prev) => ({ ...prev, ...patch }))

  const sendTest = async () => {
    if (busy || !contentOk) return
    setBusy('test')
    try {
      const res = await adminApi.sendTestEmail(content)
      showToast('ok', t('admin.email.testSent', { to: res.to }))
    } catch (err) {
      showErr(err, 'admin.saveError')
    } finally {
      setBusy(null)
    }
  }

  // 防连点：确认框按下后立刻置 busy，请求回来之前按钮都是灰的。
  // Double-submit guard: busy is set the moment the dialog is confirmed.
  const sending = useRef(false)
  const send = async () => {
    if (sending.current) return
    sending.current = true
    setBusy('send')
    try {
      const c = await adminApi.createEmailCampaign(content, audience)
      showToast('ok', t('admin.email.queued', { n: c.total }))
      setConfirmSend(false)
      setContent(EMPTY_CONTENT)
      // 名单也清掉：同一批人紧接着再点一次「发送」多半是误操作
      // clear the list too: sending to the same people again right away is usually a slip
      setPicked({})
      setEmailsText('')
      onPresetCleared?.()
      setCampaigns((prev) => [c, ...(prev ?? [])])
      refresh()
    } catch (err) {
      setConfirmSend(false)
      showErr(err, 'admin.saveError')
    } finally {
      sending.current = false
      setBusy(null)
    }
  }

  const act = async (c: EmailCampaign, action: 'cancel' | 'resume') => {
    if (busy) return
    setBusy(c.id)
    try {
      const updated = action === 'cancel' ? await adminApi.cancelEmailCampaign(c.id) : await adminApi.resumeEmailCampaign(c.id)
      setCampaigns((prev) => (prev ?? []).map((x) => (x.id === c.id ? updated : x)))
      showToast('ok', t('admin.saved'))
    } catch (err) {
      showErr(err, 'admin.saveError')
    } finally {
      setBusy(null)
      setCancelTarget(null)
    }
  }

  const planLabel = (p: EmailAudiencePlan) => t(`admin.email.plan.${p}`)
  const audienceLabel = (c: EmailCampaign) => {
    const a = c.audience
    if (!a) return '-'
    if (a.mode === 'list') return t('admin.email.audienceList', { n: a.listSize ?? 0 })
    const parts = [planLabel(a.plan ?? 'all')]
    if (a.activeWithinDays) parts.push(t('admin.email.activeWithin', { n: a.activeWithinDays }))
    if (a.inactiveForDays) parts.push(t('admin.email.inactiveFor', { n: a.inactiveForDays }))
    return parts.join(' · ')
  }

  // 按每日上限估算要几天发完 / how many days the daily cap stretches this over
  const remainingToday = status && status.dailyCap > 0 ? Math.max(0, status.dailyCap - status.sentToday) : null
  const confirmMessage = () => {
    const n = summary?.count ?? 0
    let msg = t(content.kind === 'notice' ? 'admin.email.confirmBodyNotice' : 'admin.email.confirmBody', { n })
    if (status && status.dailyCap > 0 && remainingToday !== null && n > remainingToday) {
      const days = 1 + Math.ceil((n - remainingToday) / status.dailyCap)
      msg += ' ' + t('admin.email.confirmCapWarn', { cap: status.dailyCap, days })
    }
    return msg
  }

  const field = (label: string, value: string, onChange: (v: string) => void, maxLength: number) => (
    <label className="block">
      <span className="mb-1 block text-xs text-neutral-400">{label}</span>
      <input className="input w-full py-1.5 text-sm" value={value} onChange={(e) => onChange(e.target.value)} maxLength={maxLength} />
    </label>
  )
  const area = (label: string, value: string, onChange: (v: string) => void) => (
    <EmailBodyField label={label} value={value} onChange={onChange} onError={(text) => showToast('err', text)} />
  )

  const statusText = (c: EmailCampaign) => {
    if (c.status === 'paused' && c.lastError?.startsWith('provider_rejected_'))
      return t('admin.email.status.pausedProvider', { code: c.lastError.slice('provider_rejected_'.length) })
    return t(`admin.email.status.${c.status}`)
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

      <div className="grid gap-4 lg:grid-cols-2">
        {/* 写信 / compose */}
        <div className="glass p-4">
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <h3 className="flex-1 font-display text-base font-semibold text-neutral-100">{t('admin.email.compose')}</h3>
            {status && (
              <span className="text-xs text-neutral-500">
                {status.dailyCap > 0
                  ? t('admin.email.quota', { sent: status.sentToday, cap: status.dailyCap })
                  : t('admin.email.quotaUnlimited', { sent: status.sentToday })}
              </span>
            )}
          </div>

          <div className="mb-3 flex flex-wrap gap-4" role="radiogroup" aria-label={t('admin.email.kind')}>
            {(['marketing', 'notice'] as const).map((k) => (
              <label key={k} className="flex cursor-pointer items-center gap-2 text-sm text-neutral-300">
                <input
                  type="radio"
                  name="email-kind"
                  checked={content.kind === k}
                  onChange={() => set({ kind: k })}
                  className="accent-prism-500"
                />
                {t(`admin.email.kind_${k}`)}
              </label>
            ))}
          </div>
          <p className="mb-4 text-xs text-neutral-500">{t(`admin.email.kindHint_${content.kind}`)}</p>

          <div className="space-y-3">
            {field(t('admin.email.subjectZh'), content.subjectZh, (v) => set({ subjectZh: v }), 150)}
            {area(t('admin.email.bodyZh'), content.bodyZh, (v) => set({ bodyZh: v }))}
            {field(t('admin.email.subjectEn'), content.subjectEn, (v) => set({ subjectEn: v }), 150)}
            {area(t('admin.email.bodyEn'), content.bodyEn, (v) => set({ bodyEn: v }))}
          </div>
          <p className="mt-2 text-xs text-neutral-500">{t('admin.email.formatHint')}</p>
          {halfFilled && <p className="mt-2 text-xs text-down">{t('admin.email.halfFilled')}</p>}
        </div>

        {/* 预览 / preview */}
        <div className="glass flex flex-col p-4">
          <div className="mb-3 flex items-center gap-3">
            <h3 className="flex-1 font-display text-base font-semibold text-neutral-100">{t('admin.email.preview')}</h3>
            <button type="button" className="btn-ghost px-3 py-1 text-xs" onClick={() => setShowText((v) => !v)} disabled={!preview}>
              {showText ? t('admin.email.showHtml') : t('admin.email.showText')}
            </button>
          </div>
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
                // 沙箱 iframe：不给脚本、不给同源——正文虽已在后端转义，预览也不该有任何执行能力。
                // Sandboxed with no scripts and no same-origin, even though the body is escaped server-side.
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

      {/* 收件人 / recipients */}
      <div className="glass mt-4 p-4">
        <h3 className="mb-3 font-display text-base font-semibold text-neutral-100">{t('admin.email.recipients')}</h3>
        <div className="mb-3 flex flex-wrap gap-4" role="radiogroup" aria-label={t('admin.email.recipients')}>
          {(['filter', 'list'] as const).map((m) => (
            <label key={m} className="flex cursor-pointer items-center gap-2 text-sm text-neutral-300">
              <input type="radio" name="email-mode" checked={mode === m} onChange={() => setMode(m)} className="accent-prism-500" />
              {t(`admin.email.mode_${m}`)}
            </label>
          ))}
        </div>

        {mode === 'filter' ? (
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-xs text-neutral-500">{t('admin.colPlan')}</span>
            <Select
              value={plan}
              onChange={(v) => setPlan(v as EmailAudiencePlan)}
              ariaLabel={t('admin.colPlan')}
              options={PLAN_FILTERS.map((p) => ({ value: p, label: planLabel(p) }))}
            />
            <span className="text-xs text-neutral-500">{t('admin.email.activity')}</span>
            <Select
              value={activity}
              onChange={(v) => setActivity(v as Activity)}
              ariaLabel={t('admin.email.activity')}
              options={ACTIVITY_OPTIONS.map((a) => ({ value: a, label: t(`admin.email.activityOpt.${a || 'any'}`) }))}
            />
          </div>
        ) : (
          <div className="space-y-3">
            <EmailRecipientPicker
              kind={content.kind}
              picked={picked}
              onChange={setPicked}
              onError={(text) => showToast('err', text)}
            />
            {/* 粘贴邮箱留作补充：手里已经有一份名单时比逐个勾快 / pasting stays as a shortcut for a ready-made list */}
            <details className="group" open={!!emailsText}>
              <summary className="cursor-pointer select-none text-xs text-neutral-400 hover:text-neutral-200">
                {t('admin.email.pasteToggle')}
              </summary>
              <label className="mt-2 block">
                <span className="mb-1 block text-xs text-neutral-400">{t('admin.email.pasteEmails')}</span>
                <textarea
                  className="input min-h-[80px] w-full rounded-xl py-2 text-sm"
                  value={emailsText}
                  onChange={(e) => setEmailsText(e.target.value)}
                  placeholder="a@example.com, b@example.com"
                />
              </label>
            </details>
          </div>
        )}

        <div className="mt-4 rounded-lg bg-white/5 px-3 py-2.5 text-sm">
          {!audienceOk ? (
            <span className="text-neutral-500">{t('admin.email.pickSomeone')}</span>
          ) : summaryErr ? (
            <span className="text-down">{t('admin.loadError')}</span>
          ) : !summary ? (
            <SkeletonLine width="40%" height={14} />
          ) : (
            <div className="space-y-1">
              <div className="font-medium text-neutral-100">{t('admin.email.willReceive', { n: summary.count })}</div>
              <div className="text-xs text-neutral-500">
                {[
                  summary.excludedDisabled > 0 && t('admin.email.excludedDisabled', { n: summary.excludedDisabled }),
                  summary.excludedOptedOut > 0 && t('admin.email.excludedOptedOut', { n: summary.excludedOptedOut }),
                  summary.unmatchedEmails > 0 && t('admin.email.unmatched', { n: summary.unmatchedEmails }),
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
              {summary.sample.length > 0 && (
                <div className="break-all text-xs text-neutral-500">
                  {t('admin.email.sample')} {summary.sample.join(', ')}
                  {summary.count > summary.sample.length ? ' …' : ''}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="mt-4 flex flex-wrap justify-end gap-3">
          <button
            type="button"
            className="btn-ghost px-4 py-2 text-sm disabled:opacity-40"
            disabled={!contentOk || !!busy || status?.configured === false}
            onClick={sendTest}
          >
            {busy === 'test' ? t('common.loading') : t('admin.email.sendTest')}
          </button>
          <button
            type="button"
            className="btn-primary px-5 py-2 text-sm disabled:opacity-40"
            disabled={!contentOk || !audienceOk || !summary?.count || !!busy || status?.configured === false}
            onClick={() => setConfirmSend(true)}
          >
            {busy === 'send' ? t('common.loading') : t('admin.email.send')}
          </button>
        </div>
      </div>

      {/* 发送历史 / history */}
      <div className="glass mt-4 overflow-x-auto p-0">
        <div className="flex items-center gap-3 px-4 pt-4">
          <h3 className="flex-1 font-display text-base font-semibold text-neutral-100">{t('admin.email.history')}</h3>
          <button type="button" className="btn-ghost px-3 py-1 text-xs" onClick={refresh}>
            {t('admin.email.refresh')}
          </button>
        </div>
        {campaigns === null ? (
          <div className="flex flex-col gap-3 p-5">
            <SkeletonLine width="55%" height={14} />
            <SkeletonLine width="40%" height={14} />
          </div>
        ) : campaigns.length === 0 ? (
          <div className="py-10 text-center text-sm text-neutral-500">{t('admin.email.historyEmpty')}</div>
        ) : (
          <table className="mt-3 w-full min-w-[820px] text-left text-sm">
            <thead className="border-b border-white/5 text-xs text-neutral-500">
              <tr>
                <th className="px-4 py-2 font-normal">{t('admin.email.colTime')}</th>
                <th className="px-4 py-2 font-normal">{t('admin.email.colSubject')}</th>
                <th className="px-4 py-2 font-normal">{t('admin.email.colAudience')}</th>
                <th className="px-4 py-2 font-normal">{t('admin.email.colProgress')}</th>
                <th className="px-4 py-2 font-normal">{t('admin.colStatus')}</th>
                <th className="px-4 py-2 font-normal">{t('admin.colAction')}</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((c) => (
                <tr key={c.id} className="border-b border-white/5 align-top last:border-0">
                  <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-neutral-400">
                    {fmtTime(c.createdAt)}
                    {c.createdByEmail && <div className="mt-0.5 font-sans text-neutral-500">{c.createdByEmail}</div>}
                  </td>
                  <td className="max-w-[260px] px-4 py-2.5 text-neutral-200">
                    <div className="truncate" title={c.subject}>{c.subject}</div>
                    <div className="mt-0.5 text-xs text-neutral-500">{t(`admin.email.kind_${c.kind}`)}</div>
                  </td>
                  <td className="px-4 py-2.5 text-xs text-neutral-400">{audienceLabel(c)}</td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-xs text-neutral-300">
                    <div>{t('admin.email.progress', { sent: c.sent, total: c.total })}</div>
                    <div className="mt-0.5 text-neutral-500">
                      {[
                        c.pending > 0 && t('admin.email.pendingN', { n: c.pending }),
                        c.failed > 0 && t('admin.email.failedN', { n: c.failed }),
                        c.skipped > 0 && t('admin.email.skippedN', { n: c.skipped }),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </div>
                  </td>
                  <td className={`px-4 py-2.5 text-xs ${c.status === 'paused' ? 'text-amber-300' : 'text-neutral-300'}`}>
                    {statusText(c)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5">
                    {c.status === 'paused' && (
                      <button
                        type="button"
                        className="mr-2 rounded px-2 py-1 text-xs text-prism-200 hover:bg-white/10 disabled:opacity-40"
                        disabled={!!busy}
                        onClick={() => act(c, 'resume')}
                      >
                        {t('admin.email.resume')}
                      </button>
                    )}
                    {(c.status === 'sending' || c.status === 'paused') && (
                      <button
                        type="button"
                        className="rounded px-2 py-1 text-xs text-down hover:bg-white/10 disabled:opacity-40"
                        disabled={!!busy}
                        onClick={() => setCancelTarget(c)}
                      >
                        {t('admin.email.cancel')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {confirmSend && (
        <ConfirmModal
          title={t('admin.email.confirmTitle')}
          message={confirmMessage()}
          confirmLabel={t('admin.email.send')}
          busy={busy === 'send'}
          onConfirm={send}
          onCancel={() => setConfirmSend(false)}
        />
      )}
      {cancelTarget && (
        <ConfirmModal
          title={t('admin.email.cancelTitle')}
          message={t('admin.email.cancelBody', { n: cancelTarget.pending })}
          confirmLabel={t('admin.email.cancel')}
          cancelLabel={t('admin.email.keepSending')}
          danger
          busy={busy === cancelTarget.id}
          onConfirm={() => act(cancelTarget, 'cancel')}
          onCancel={() => setCancelTarget(null)}
        />
      )}
    </div>
  )
}
