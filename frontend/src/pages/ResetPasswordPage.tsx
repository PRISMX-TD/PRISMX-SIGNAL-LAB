// 找回密码 / Password reset
//
// 一个组件挂两条路由，按 ?token= 在两个阶段之间切换：
//   /forgot-password            → 填邮箱，申请链接
//   /reset-password?token=...   → 设新密码（邮件里的链接落在这里）
//
// 不拆成两个页面，是因为两者共用登录页那套品牌外壳（Aurora 背景 + 左对齐 logo
// + glass 卡片）。拆开就要么复制一遍外壳、要么再抽一层布局组件，而这两个阶段
// 是同一条流程的前后两步，放在一起读反而更清楚。
//
// One component on two routes, switching on ?token=. They share the login page's
// branded shell, and splitting them would mean either duplicating that shell or
// extracting another layout component for what is really two steps of one flow.
import { useState, type FormEvent } from 'react'
import { Link, Navigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../store/auth'
import { authApi } from '../api/client'
import { localizeApiError } from '../api/utils'
import Logo from '../components/Logo'
import LanguageToggle from '../components/LanguageToggle'
import AuroraBackground from '../components/AuroraBackground'

export default function ResetPasswordPage() {
  const { t } = useTranslation()
  const { isAuthed } = useAuth()
  const [params] = useSearchParams()
  const token = params.get('token') || ''

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [sent, setSent] = useState(false)
  const [done, setDone] = useState(false)
  const [loading, setLoading] = useState(false)

  // 已登录的人不该停在这里——要改密码去账户页，那条路要验旧密码，更合适。
  // Already signed in? Changing a password belongs in the account page, which
  // verifies the old one.
  if (isAuthed) return <Navigate to="/account" replace />

  const requestLink = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await authApi.forgotPassword(email.trim())
      // 成功与否都进同一个画面：后端刻意不告诉我们这个邮箱在不在库里，前端
      // 也就没有"这个邮箱没注册"这种话可说。
      setSent(true)
    } catch (err) {
      setError(err instanceof Error ? localizeApiError(err.message) : t('auth.resetRequestError'))
    } finally {
      setLoading(false)
    }
  }

  const submitNewPassword = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    // 两次不一致在本地就挡下来。这一步后端没有、也不该有——它只收一个密码；
    // "再输一遍"是纯粹的输入防错，属于界面的事。
    if (password !== confirm) {
      setError(t('auth.resetMismatch'))
      return
    }
    setLoading(true)
    try {
      await authApi.resetPassword(token, password)
      setDone(true)
    } catch (err) {
      setError(err instanceof Error ? localizeApiError(err.message) : t('auth.resetError'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="relative min-h-screen bg-base">
      <AuroraBackground />
      <div className="absolute right-4 top-4 z-20">
        <LanguageToggle />
      </div>
      <div className="relative z-10 flex min-h-screen items-center justify-center px-4 py-10">
        <div className="w-full max-w-md">
          <div className="mb-8">
            <Logo size={44} />
            <h1 className="mt-5 font-display-xl text-[2rem] text-white">Signal Lab</h1>
            <p className="mt-1.5 text-[11px] font-medium uppercase tracking-[0.16em] text-neutral-500">by PRISMX</p>
          </div>

          <div className="glass animate-fade-in-up p-6">
            {/* 阶段三：改完了 */}
            {done ? (
              <>
                <h2 className="font-display text-lg font-semibold text-neutral-100">{t('auth.resetDoneTitle')}</h2>
                <p className="mt-2 text-sm leading-relaxed text-neutral-400">{t('auth.resetDoneBody')}</p>
                <Link to="/login" className="btn btn-primary mt-5 w-full">{t('auth.login')}</Link>
              </>
            ) : sent ? (
              /* 阶段二：申请过了。这里的措辞必须和后端一样含糊——说成「已发送到
                 你的邮箱」会变相确认这个邮箱是注册用户。 */
              <>
                <h2 className="font-display text-lg font-semibold text-neutral-100">{t('auth.resetSentTitle')}</h2>
                <p className="mt-2 text-sm leading-relaxed text-neutral-400">{t('auth.resetSentBody')}</p>
                <p className="mt-3 text-xs leading-relaxed text-neutral-500">{t('auth.resetSentHint')}</p>
                <Link to="/login" className="btn btn-ghost mt-5 w-full">{t('auth.backToLogin')}</Link>
              </>
            ) : token ? (
              /* 阶段 1b：邮件链接落地，设新密码 */
              <>
                <h2 className="font-display text-lg font-semibold text-neutral-100">{t('auth.resetTitle')}</h2>
                <p className="mt-2 mb-5 text-sm leading-relaxed text-neutral-400">{t('auth.resetSubtitle')}</p>
                <form onSubmit={submitNewPassword} className="space-y-4">
                  <div>
                    <label className="label">{t('auth.newPassword')}</label>
                    <div className="relative">
                      <input
                        className="input pr-11"
                        type={showPassword ? 'text' : 'password'}
                        autoComplete="new-password"
                        minLength={8}
                        maxLength={128}
                        required
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder={t('auth.passwordPlaceholder')}
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword((v) => !v)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-neutral-300"
                        aria-label={showPassword ? t('auth.hidePassword') : t('auth.showPassword')}
                      >
                        {showPassword ? (
                          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-4.803m5.596-3.856a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z" />
                          </svg>
                        ) : (
                          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                          </svg>
                        )}
                      </button>
                    </div>
                  </div>
                  <div>
                    <label className="label">{t('auth.confirmPassword')}</label>
                    <input
                      className="input"
                      type={showPassword ? 'text' : 'password'}
                      autoComplete="new-password"
                      minLength={8}
                      maxLength={128}
                      required
                      value={confirm}
                      onChange={(e) => setConfirm(e.target.value)}
                      placeholder={t('auth.passwordPlaceholder')}
                    />
                  </div>
                  {error && (
                    <div className="rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-sm text-down">
                      {error}
                    </div>
                  )}
                  <button type="submit" disabled={loading} className="btn btn-primary w-full">
                    {loading ? t('common.loading') : t('auth.resetSubmit')}
                  </button>
                </form>
                <Link to="/login" className="mt-4 block text-center text-xs text-neutral-500 hover:text-neutral-300">
                  {t('auth.backToLogin')}
                </Link>
              </>
            ) : (
              /* 阶段 1a：申请链接 */
              <>
                <h2 className="font-display text-lg font-semibold text-neutral-100">{t('auth.forgotTitle')}</h2>
                <p className="mt-2 mb-5 text-sm leading-relaxed text-neutral-400">{t('auth.forgotSubtitle')}</p>
                <form onSubmit={requestLink} className="space-y-4">
                  <div>
                    <label className="label">{t('auth.email')}</label>
                    <input
                      className="input"
                      type="email"
                      autoComplete="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder={t('auth.emailPlaceholder')}
                    />
                  </div>
                  {error && (
                    <div className="rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-sm text-down">
                      {error}
                    </div>
                  )}
                  <button type="submit" disabled={loading} className="btn btn-primary w-full">
                    {loading ? t('common.loading') : t('auth.forgotSubmit')}
                  </button>
                </form>
                <Link to="/login" className="mt-4 block text-center text-xs text-neutral-500 hover:text-neutral-300">
                  {t('auth.backToLogin')}
                </Link>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
