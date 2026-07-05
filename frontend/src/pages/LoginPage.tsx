// 登录/注册页 / Login & register page
import { useState, type FormEvent } from 'react'
import { Navigate, useNavigate, useSearchParams, Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../store/auth'
import Logo from '../components/Logo'
import LanguageToggle from '../components/LanguageToggle'
import AuroraBackground from '../components/AuroraBackground'
import GoogleLoginButton from '../components/GoogleLoginButton'

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
      else await register(email, password)
      navigate('/dashboard', { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : t('auth.errorFailed'))
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
      setError(err instanceof Error ? err.message : t('auth.googleError'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="relative min-h-screen overflow-hidden">
      <AuroraBackground />

      <div className="absolute left-4 top-4 z-10">
        <Link to="/" className="chip transition hover:border-prism-500/50 hover:text-slate-100">
          <span aria-hidden>←</span> PRISMX
        </Link>
      </div>
      <div className="absolute right-4 top-4 z-10">
        <LanguageToggle />
      </div>

      <div className="relative z-10 flex min-h-screen items-center justify-center px-4">
        <div className="w-full max-w-md">
          <div className="mb-8 flex flex-col items-center text-center">
            <div className="mb-4 animate-glow-pulse rounded-2xl border border-prism-600/40 bg-white/[0.04] p-3 backdrop-blur-xl">
              <Logo size={44} />
            </div>
            <h1 className="font-display text-3xl font-black tracking-wider text-slate-100">
              PRISMX <span className="neon-text animate-gradient-x">Signal Lab</span>
            </h1>
            <p className="mt-1 text-sm tracking-widest text-slate-500">{t('app.subtitle')}</p>
            <p className="mt-3 max-w-xs text-sm text-slate-400">{t('auth.tagline')}</p>
          </div>

          <div className="glass animate-fade-in-up p-6 shadow-glass-lg">
            <div className="mb-5 flex gap-2 rounded-xl border border-white/10 bg-white/[0.03] p-1">
              <button
                onClick={() => setMode('login')}
                className={`flex-1 rounded-lg py-2 text-sm font-medium transition ${
                  mode === 'login'
                    ? 'bg-prism-600 text-white shadow-prism'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {t('auth.loginTitle')}
              </button>
              <button
                onClick={() => setMode('register')}
                className={`flex-1 rounded-lg py-2 text-sm font-medium transition ${
                  mode === 'register'
                    ? 'bg-prism-600 text-white shadow-prism'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
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
                    className="input pr-10"
                    placeholder={t('auth.passwordPlaceholder')}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200 transition"
                    title={showPassword ? 'Hide password' : 'Show password'}
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

              {error && (
                <div className="rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-sm text-down">
                  {error}
                </div>
              )}

              <button type="submit" disabled={loading} className="btn-primary w-full py-2.5">
                {loading ? t('common.loading') : mode === 'login' ? t('auth.login') : t('auth.register')}
              </button>
            </form>

            <div className="my-5 flex items-center gap-3">
              <span className="h-px flex-1 bg-white/10" />
              <span className="text-xs uppercase tracking-widest text-slate-500">{t('auth.or')}</span>
              <span className="h-px flex-1 bg-white/10" />
            </div>

            <GoogleLoginButton onCredential={onGoogleCredential} onError={setError} />
          </div>
        </div>
      </div>
    </div>
  )
}
