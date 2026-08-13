// 登录/注册页 / Login & register page
import { useState, type FormEvent } from 'react'
import { Navigate, useNavigate, useSearchParams, Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../store/auth'
import { localizeApiError } from '../api/utils'
import Logo from '../components/Logo'
import LanguageToggle from '../components/LanguageToggle'
import AuroraBackground from '../components/AuroraBackground'
import GoogleLoginButton from '../components/GoogleLoginButton'
import PhoneField, { dialCodeOf, type PhoneValue } from '../components/PhoneField'
import { DEFAULT_DIAL_ISO } from '../data/dialCodes'

export default function LoginPage() {
  const { t } = useTranslation()
  const { login, register, loginWithGoogle, isAuthed } = useAuth()
  const navigate = useNavigate()
  const [params] = useSearchParams()

  const [mode, setMode] = useState<'login' | 'register'>(
    params.get('mode') === 'register' ? 'register' : 'login',
  )
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [phone, setPhone] = useState<PhoneValue>({ iso: DEFAULT_DIAL_ISO, national: '' })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  // 已登录直接重定向；渲染期间调用 navigate 是反模式 / declarative redirect
  if (isAuthed) return <Navigate to="/dashboard" replace />

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      if (mode === 'login') await login(email, password)
      else await register(email, password, dialCodeOf(phone.iso), phone.national)
      navigate('/dashboard', { replace: true })
    } catch (err) {
      setError(err instanceof Error ? localizeApiError(err.message) : t('auth.errorFailed'))
    } finally {
      setLoading(false)
    }
  }

  const onGoogleCredential = async (credential: string) => {
    setError('')
    setLoading(true)
    try {
      await loginWithGoogle(credential)
      navigate('/dashboard', { replace: true })
    } catch (err) {
      setError(err instanceof Error ? localizeApiError(err.message) : t('auth.googleError'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="relative min-h-[100dvh] overflow-hidden">
      <AuroraBackground />

      {/* top-[calc(1rem+env(safe-area-inset-top))]：这个容器是 min-h-[100dvh] 从物理
          屏幕顶部起算，固定 top-4 会被 iOS 刘海/灵动岛盖住、点击被系统截获
          （用户反馈的"顶部按键按不了"就是这个）。
          top-[calc(1rem+env(safe-area-inset-top))]: this container spans from the
          physical screen top, so a bare top-4 sits under the iOS notch/Dynamic
          Island and taps get swallowed by the system — this is the "top buttons
          don't respond" report. */}
      <div className="absolute left-4 top-[calc(1rem+env(safe-area-inset-top))] z-20">
        <Link to="/" className="chip transition hover:border-prism-500/50 hover:text-neutral-100">
          <span aria-hidden>←</span> Signal Lab
        </Link>
      </div>
      <div className="absolute right-4 top-[calc(1rem+env(safe-area-inset-top))] z-20">
        <LanguageToggle />
      </div>

      <div className="relative z-10 flex min-h-[100dvh] items-center justify-center px-4">
        <div className="w-full max-w-md">
          {/* 品牌区改为左对齐。登录页此前是「居中 logo + 居中渐变标题 + 居中副标 +
              居中卡片」的四层同轴堆叠——这正是被反复点名的居中英雄模板。左对齐之后
              标题与下方表单的 label 共用同一条左基线，眼睛从品牌读到第一个输入框
              是一条直线，而不是先回到中轴再折返。
              Logo 上原本挂着一层 16px 紫色 drop-shadow 光晕，与全站去发光的方向直接
              冲突，已移除。
              The brand block is now left-aligned. This page used to stack a centred
              logo, a centred gradient headline, a centred subtitle and a centred card
              on one axis — the centred-hero template. Left-aligned, the headline
              shares a left baseline with the form labels below it, so the eye travels
              from brand to first input in a straight line instead of returning to the
              centre axis and back out.
              The 16px violet drop-shadow halo on the logo contradicted the system-wide
              removal of glow and is gone. */}
          <div className="mb-8">
            <Logo size={44} />
            <h1 className="mt-5 font-display-xl text-[2rem] text-white">Signal Lab</h1>
            <p className="mt-1.5 text-[11px] font-medium uppercase tracking-[0.16em] text-neutral-500">by PRISMX</p>
            <p className="mt-4 max-w-xs text-[13px] leading-relaxed text-neutral-400">{t('auth.tagline')}</p>
          </div>

          <div className="glass animate-fade-in-up p-6">
            {/* 登录/注册切换沿用全站分段控制器的形状与尺寸（.seg），不再是这一页
                独有的一套写法。选中态是实色紫、无外发光阴影。
                The login/register switch now uses the app-wide segmented control's
                shape and metrics (.seg) instead of a one-off implementation on this
                page. The selected state is flat violet with no glow shadow. */}
            <div className="seg mb-5 w-full">
              <button
                onClick={() => setMode('login')}
                className={`flex-1 ${mode === 'login' ? 'on' : ''}`}
              >
                {t('auth.loginTitle')}
              </button>
              <button
                onClick={() => setMode('register')}
                className={`flex-1 ${mode === 'register' ? 'on' : ''}`}
              >
                {t('auth.registerTitle')}
              </button>
            </div>

            <form onSubmit={onSubmit} className="space-y-4">
              <div>
                <label className="label">{t('auth.email')}</label>
                <input
                  type="email"
                  required
                  className="input"
                  placeholder={t('auth.emailPlaceholder')}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <div>
                <label className="label">{t('auth.password')}</label>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    required
                    // 注册要求密码至少 8 位（与后端一致）；不加限制时短密码会被
                    // 后端 422 拒绝，错误信息还会显示得很难懂。
                    // Registration requires ≥8 chars (matches the backend);
                    // without this a short password is rejected by the backend
                    // 422 with a hard-to-read message.
                    minLength={mode === 'register' ? 8 : undefined}
                    className="input pr-10"
                    placeholder={t('auth.passwordPlaceholder')}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-200 transition"
                    title={showPassword ? t('auth.hidePassword') : t('auth.showPassword')}
                    aria-label={showPassword ? t('auth.hidePassword') : t('auth.showPassword')}
                  >
                    {showPassword ? (
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-4.803m5.596-3.856a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z" />
                      </svg>
                    ) : (
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                      </svg>
                    )}
                  </button>
                </div>
              </div>

              {/* 手机号：仅注册时出现且必填。放在密码之后——注册表单的字段顺序
                  应该跟用户的心理预期一致（先账号密码，再联系方式）。
                  Phone: register-only and required, placed after the password so
                  the field order matches what a signup form is expected to ask. */}
              {mode === 'register' && (
                <PhoneField value={phone} onChange={setPhone} />
              )}

              {error && (
                <div className="rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-sm text-down">
                  {error}
                </div>
              )}

              <button type="submit" disabled={loading} className="btn btn-primary w-full">
                {loading ? t('common.loading') : mode === 'login' ? t('auth.login') : t('auth.register')}
              </button>
            </form>

            <div className="my-5 flex items-center gap-3">
              <span className="h-px flex-1 bg-white/10" />
              <span className="text-xs uppercase tracking-widest text-neutral-500">{t('auth.or')}</span>
              <span className="h-px flex-1 bg-white/10" />
            </div>

            <GoogleLoginButton onCredential={onGoogleCredential} onError={setError} />
          </div>
        </div>
      </div>
    </div>
  )
}
