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
import { useBackToClose } from '../../utils/useBackToClose'
import ConfirmModal from '../ConfirmModal'
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
  // 降级的二次确认。「延长」那三挡按钮的摩擦是刻意设计的（见文件头），而唯一
  // **不可逆**的那个动作反倒一点即生效：客户立刻失去实时信号、推送与多账号，
  // 代理自己没有恢复入口。同一目录下其它危险操作一律走 ConfirmModal——本文件
  // 第 50 行的注释甚至已经引用了 ConfirmModal，只是没真用上。
  // Confirmation for the downgrade. The three-button friction on "extend" is
  // deliberate (see the file header), yet the one irreversible action took a
  // single click: the client instantly loses live signals, push and multiple
  // accounts, and an agent has no way to restore it. Every other dangerous
  // action in this area goes through ConfirmModal — the comment further down
  // this file already referenced it without using it.
  const [confirmDowngrade, setConfirmDowngrade] = useState(false)

  // 手机上划返回应当关掉弹窗，而不是离开 /agent 整页——全站其它全屏弹窗都接了
  // 这个 hook（见 Layout.tsx 的登出确认）。
  // A back swipe on a phone should dismiss this dialog rather than leave /agent
  // entirely; every other full-screen dialog on the site wires up this hook (see
  // Layout.tsx's logout confirmation).
  useBackToClose(true, onClose)

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
  // 确认框里要说清"现在是什么"，与上面那段 current 文案同源，免得两处各写一份。
  // The dialog states the current membership, reusing the same copy as the line
  // above rather than composing a second description of the same thing.
  const currentText = user.planExpiresAt
    ? t('agent.plan.current', { plan: user.plan, until: t('agent.plan.until', { time: fmtDate(user.planExpiresAt) }) })
    : t('agent.plan.currentPlain', { plan: user.plan })

  return createPortal(
    // 确认框是遮罩的**兄弟**而不是子节点：ConfirmModal 自己也 portal 到 body，
    // 但 React 的合成事件仍沿**组件树**冒泡——放在遮罩里面的话，点确认框的背景
    // （本意是取消）会一路冒到遮罩的 onClick，把整个 PlanDialog 一起关掉。
    // The confirm dialog is a sibling of the overlay, not a child: ConfirmModal
    // portals to body itself, but React's synthetic events still bubble through
    // the *component* tree — nested inside, clicking the confirm dialog's own
    // backdrop (meaning "cancel") would reach the overlay's onClick and dismiss
    // the whole PlanDialog with it.
    <>
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
            onClick={() => setConfirmDowngrade(true)}
          >
            {t('agent.plan.downgrade')}
          </button>
          <button type="button" className="btn-ghost px-3 py-1.5 text-xs" onClick={onClose} disabled={busy}>
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>
      {confirmDowngrade && (
        <ConfirmModal
          center
          danger
          busy={busy}
          title={t('agent.plan.downgradeConfirmTitle')}
          message={t('agent.plan.downgradeConfirmBody', { email: user.email, current: currentText })}
          confirmLabel={t('agent.plan.downgrade')}
          onConfirm={() => {
            setConfirmDowngrade(false)
            void submit({ email: user.email, action: 'downgrade' })
          }}
          onCancel={() => setConfirmDowngrade(false)}
        />
      )}
    </>,
    document.body,
  )
}
