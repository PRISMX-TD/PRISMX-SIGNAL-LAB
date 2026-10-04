// 邮箱验证提示（软拦截）。
//
// 没验证的账号照样能登录、能看，只有绑定 MT5 与领 PRO 试用要先验证（后端守门见
// services/deps.require_verified_email）。这里两种形态：
//   - EmailVerifyBanner：挂在 Layout 顶部、跟着用户走每一页，直到验证完；不给关闭
//     按钮——它是用户在这个产品里唯一没做完的一步，也只有新注册的人会看到。
//   - EmailVerifyInline：放在被拦的那个操作旁边（绑定表单、生成 Token、领试用），
//     说清楚「为什么这个按钮用不了」，并就地给一个重新发送。
//
// 只有 user.emailVerified === false 才显示：上线前缓存的 user 没有这个键，
// undefined 不能当成没验证（见 User.emailVerified 的说明）。
//
// Email verification prompt (soft gate). Unverified accounts can sign in and
// browse; binding MT5 and claiming a PRO trial need verification. The banner
// rides on Layout across every page until verified (no dismiss — it's the one
// unfinished step, and only new sign-ups ever see it); the inline variant sits
// next to the blocked action and explains why it's disabled. Shown only when
// emailVerified is strictly false.
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { authApi } from '../api/client'
import { localizeApiError } from '../api/utils'
import { useAuth } from '../store/auth'

// 发完之后按钮冷却多久。国内邮箱经常晚到一两分钟，冷却期挡住「没收到→连点」，
// 后端还有每小时上限兜底。
// Cooldown after a send: mail to Chinese providers often lags a minute or two,
// and this stops "not here yet → click again"; the backend caps per hour too.
const COOLDOWN_S = 60

function useResend() {
  const { t } = useTranslation()
  const [sending, setSending] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [cooldown, setCooldown] = useState(0)

  useEffect(() => {
    if (cooldown <= 0) return
    const id = window.setTimeout(() => setCooldown((s) => s - 1), 1000)
    return () => window.clearTimeout(id)
  }, [cooldown])

  const resend = useCallback(async () => {
    setSending(true)
    setMsg(null)
    try {
      await authApi.resendVerification()
      setMsg({ ok: true, text: t('emailVerify.sent') })
      setCooldown(COOLDOWN_S)
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? localizeApiError(err.message) : t('emailVerify.sendFailed') })
    } finally {
      setSending(false)
    }
  }, [t])

  const label = sending
    ? t('emailVerify.sending')
    : cooldown > 0
      ? t('emailVerify.resendIn', { s: cooldown })
      : t('emailVerify.resend')

  return { resend, sending, msg, label, disabled: sending || cooldown > 0 }
}

export function EmailVerifyBanner() {
  const { t } = useTranslation()
  const { user, refreshUser } = useAuth()
  const unverified = user?.emailVerified === false
  const { resend, msg, label, disabled } = useResend()

  // 切回这个标签页时重新拉一次登录态：用户多半是去邮箱点了链接（常常是在另一个
  // 标签页或手机上）再回来，这时提示条应该自己消失，而不是要他刷新页面。只在
  // 还没验证时挂监听，验证过的人不多发一个请求。
  // Re-fetch the session when the tab becomes visible again: the user most
  // likely just clicked the link in another tab or on their phone, and the
  // banner should vanish on its own. Only listens while unverified.
  useEffect(() => {
    if (!unverified) return
    const onVisible = () => {
      if (document.visibilityState === 'visible') refreshUser()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [unverified, refreshUser])

  if (!unverified) return null

  return (
    <div className="mx-auto w-full max-w-7xl px-4 pt-4 sm:px-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-2.5 text-xs text-amber-300">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
        <span className="font-semibold">{t('emailVerify.bannerTitle')}</span>
        <span className="min-w-0 break-words leading-relaxed opacity-80">
          {t('emailVerify.bannerBody', { email: user?.email ?? '' })}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {msg && <span className={msg.ok ? 'text-up' : 'text-down'} aria-live="polite">{msg.text}</span>}
          <button
            type="button"
            onClick={resend}
            disabled={disabled}
            className="rounded-lg bg-amber-400/20 px-2.5 py-1 font-semibold text-amber-100 transition hover:bg-amber-400/30 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {label}
          </button>
        </div>
      </div>
    </div>
  )
}

// reason 决定第一句说的是哪个被拦的操作 / which blocked action to name
export function EmailVerifyInline({ reason, className = '' }: { reason: 'bind' | 'trial'; className?: string }) {
  const { t } = useTranslation()
  const { user } = useAuth()
  const { resend, msg, label, disabled } = useResend()

  return (
    <div className={`rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-xs leading-relaxed text-amber-300 ${className}`}>
      <p className="font-semibold">
        {reason === 'bind' ? t('emailVerify.inlineBind') : t('emailVerify.inlineTrial')}
      </p>
      <p className="mt-1 break-words opacity-80">{t('emailVerify.inlineBody', { email: user?.email ?? '' })}</p>
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={resend}
          disabled={disabled}
          className="rounded-lg bg-amber-400/20 px-2.5 py-1 font-semibold text-amber-100 transition hover:bg-amber-400/30 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {label}
        </button>
        {msg && <span className={msg.ok ? 'text-up' : 'text-down'} aria-live="polite">{msg.text}</span>}
      </div>
    </div>
  )
}
