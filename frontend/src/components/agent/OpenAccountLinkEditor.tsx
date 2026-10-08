// 代理页每张链接卡里的「我的开户链接」：显示当前值（或「未设置」），一个输入框 + 保存 / 清除。
// 发请求前用 isAgentOpenUrl 做同口径预检（只收 Make Capital 的 https 地址），后端仍是权威。
// 保存成功后把后端回来的整条链接交给 onSaved，由页面替换那张卡。
// 链接卡整张可点（切换下方名单）且 Enter / 空格会选卡：这里的点击与按键一律 stopPropagation，
// 否则在输入框里敲空格会被卡片吃掉。
// "My open-account link" inside each agent link card: current value (or "not set"), an
// input with Save / Clear, a client-side pre-check mirroring the backend rule, and the
// updated link handed back via onSaved. The card is itself clickable and selects on
// Enter/Space, so clicks and keys here stop propagating — otherwise typing a space in the
// input would be swallowed by the card.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { agentApi } from '../../api/client'
import { localizeApiError } from '../../api/utils'
import { isAgentOpenUrl } from '../../utils/openAccountLink'
import type { AgentLink } from '../../api/types'

type Feedback = { kind: 'ok' | 'err'; text: string } | null

export default function OpenAccountLinkEditor({
  link,
  onSaved,
}: {
  link: AgentLink
  onSaved: (updated: AgentLink) => void
}) {
  const { t } = useTranslation()
  const current = link.openAccountUrl ?? null
  const [draft, setDraft] = useState(current ?? '')
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<Feedback>(null)

  useEffect(() => {
    setDraft(current ?? '')
  }, [link.id, current])

  const trimmed = draft.trim()
  const invalid = trimmed !== '' && !isAgentOpenUrl(trimmed)
  const canSave = !busy && trimmed !== '' && !invalid && trimmed !== current

  const send = async (url: string | null) => {
    setBusy(true)
    setFeedback(null)
    try {
      const updated = await agentApi.setOpenAccountUrl(link.id, url)
      onSaved(updated)
      setFeedback({ kind: 'ok', text: t(url ? 'agent.openAccount.saved' : 'agent.openAccount.cleared') })
    } catch (err) {
      setFeedback({ kind: 'err', text: localizeApiError(err instanceof Error ? err.message : String(err)) })
    } finally {
      setBusy(false)
    }
  }

  const inputId = `agent-open-url-${link.id}`

  return (
    <div
      className="mt-4 border-t border-white/5 pt-3"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <label htmlFor={inputId} className="text-[11px] uppercase tracking-wide text-neutral-500">
        {t('agent.openAccount.title')}
      </label>
      <p className={`mt-1 break-all text-xs ${current ? 'num text-neutral-200' : 'text-neutral-500'}`}>
        {current ?? t('agent.openAccount.unset')}
      </p>
      <form
        className="mt-2 flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (canSave) void send(trimmed)
        }}
      >
        <input
          id={inputId}
          className="input min-w-0 flex-1 text-xs"
          type="url"
          inputMode="url"
          value={draft}
          maxLength={500}
          placeholder={t('agent.openAccount.placeholder')}
          aria-invalid={invalid || undefined}
          disabled={busy}
          onChange={(e) => {
            setDraft(e.target.value)
            setFeedback(null)
          }}
        />
        <button type="submit" className="btn-primary px-3 py-1.5 text-xs disabled:opacity-40" disabled={!canSave}>
          {busy ? t('agent.openAccount.saving') : t('agent.openAccount.save')}
        </button>
        {current && (
          <button
            type="button"
            className="btn-ghost px-3 py-1.5 text-xs disabled:opacity-40"
            disabled={busy}
            onClick={() => void send(null)}
          >
            {t('agent.openAccount.clear')}
          </button>
        )}
      </form>
      {invalid ? (
        <p className="mt-1 text-[11px] text-down" role="alert">{t('agent.openAccount.invalid')}</p>
      ) : feedback ? (
        <p className={`mt-1 text-[11px] ${feedback.kind === 'ok' ? 'text-up' : 'text-down'}`} role={feedback.kind === 'err' ? 'alert' : 'status'}>
          {feedback.text}
        </p>
      ) : null}
      <p className="mt-1 text-[11px] leading-snug text-neutral-500">{t('agent.openAccount.explain')}</p>
    </div>
  )
}
