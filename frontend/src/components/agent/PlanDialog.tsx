// 代理调整某个客户的会员：延长 PRO（7 / 30 / 60 天三挡）或降回 FREE。
//
// 三挡按钮而不是一个天数输入框：后端单次上限 60 天，输入框只会让人填 365 再吃一个
// 422。要开一年就点六次 60 天——摩擦是故意的（见后端 AgentPlanUpdate）。
//
// 不限期会员（PRO 且没有到期日）是管理员手动给的，代理改不动：按钮在名单里就是
// 禁用态，这里再挡一次文案，免得有人直接调接口后看不懂 409。
//
// Agent-side membership change for one client: extend PRO (7/30/60 days) or drop
// to FREE. Three buttons rather than a free-text day count, because the server
// caps a single change at 60 days — a text field would just earn a 422. A year
// takes six clicks; the friction is the point. Never-expiring members are an
// admin's manual grant and are refused (the row's button is disabled too).
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { agentApi } from '../../api/client'
import { fmtDate, localizeApiError } from '../../api/utils'
import type { AgentLinkUser, AgentPlanChange } from '../../api/types'

const EXTEND_OPTIONS = [7, 30, 60]

export default function PlanDialog({
  linkId,
  user,
  onDone,
  onClose,
}: {
  linkId: string
  user: AgentLinkUser
  onDone: (updated: AgentLinkUser) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (body: AgentPlanChange) => {
    setBusy(true)
    setError(null)
    try {
      onDone(await agentApi.setUserPlan(linkId, body))
    } catch (err: unknown) {
      setError(localizeApiError(err instanceof Error ? err.message : String(err)))
      setBusy(false)
    }
  }

  // 必须 portal 到 body：调用点在 .glass 卡片内部，那层 backdrop-filter 会成为
  // fixed 定位的包含块，遮罩的 inset:0 只会铺满那张卡（同 ConfirmModal 的注释）。
  // Portal to body: the call site sits inside a .glass card whose backdrop-filter
  // becomes the containing block for fixed positioning (see ConfirmModal).
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <div className="glass-card w-full max-w-sm p-6" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <h3 className="font-display text-base text-neutral-100">{t('agent.plan.title')}</h3>
        <p className="num mt-1 break-all text-xs text-neutral-400">{user.email}</p>
        {/* FREE 没有到期日可言，别把「不限期」那句套上去——那是给管理员手动开的
            不限期 PRO 用的，套在免费用户身上会读成"他是永久会员"。
            A FREE row has no expiry to speak of; reusing the "no expiry" wording
            there would read as "this person is a lifetime member". */}
        <p className="mt-3 text-xs text-neutral-400">
          {user.planExpiresAt
            ? t('agent.plan.current', { plan: user.plan, until: t('agent.plan.until', { time: fmtDate(user.planExpiresAt) }) })
            : user.plan === 'PRO'
              ? t('agent.plan.current', { plan: user.plan, until: t('agent.plan.noExpiry') })
              : t('agent.plan.currentPlain', { plan: user.plan })}
        </p>

        {error && (
          <div className="mt-3 rounded-lg border border-down/40 bg-down/15 px-3 py-2 text-xs text-down" role="alert">
            {error}
          </div>
        )}

        <p className="mt-4 text-[11px] uppercase tracking-wide text-neutral-500">{t('agent.plan.extend')}</p>
        <div className="mt-2 grid grid-cols-3 gap-2">
          {EXTEND_OPTIONS.map((days) => (
            <button
              key={days}
              type="button"
              disabled={busy}
              className="btn-ghost py-2 text-xs disabled:opacity-40"
              onClick={() => void submit({ email: user.email, action: 'extend', days })}
            >
              {t('agent.plan.days', { days })}
            </button>
          ))}
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-neutral-500">{t('agent.plan.extendHint')}</p>

        <div className="mt-5 flex items-center justify-between gap-3 border-t border-white/10 pt-4">
          <button
            type="button"
            disabled={busy || user.plan !== 'PRO'}
            className="text-xs text-down disabled:opacity-40"
            onClick={() => void submit({ email: user.email, action: 'downgrade' })}
          >
            {t('agent.plan.downgrade')}
          </button>
          <button type="button" className="btn-ghost px-3 py-1.5 text-xs" onClick={onClose} disabled={busy}>
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
