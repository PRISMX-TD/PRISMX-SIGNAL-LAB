// 登录/注册页 / Login & register page
import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../store/auth'
import Logo from '../components/Logo'
import LanguageToggle from '../components/LanguageToggle'

export default function LoginPage() {
  const { t } = useTranslation()
  const { login, register, isAuthed } = useAuth()
  const navigate = useNavigate()

  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  if (isAuthed) {
    navigate('/', { replace: true })
  }

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      if (mode === 'login') await login(email, password)
      else await register(email, password)
      navigate('/', { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : t('auth.errorFailed'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="relative min-h-screen overflow-hidden">
      {/* 背景棱镜网格 / prism grid background */}
      <div className="pointer-events-none absolute inset-0 bg-prism-grid bg-[size:44px_44px] opacity-40" />
      <div className="pointer-events-none absolute -left-40 top-10 h-96 w-96 rounded-full bg-prism-700/20 blur-3xl" />
      <div className="pointer-events-none absolute -right-32 bottom-0 h-96 w-96 rounded-full bg-prism-500/10 blur-3xl" />

      <div className="absolute right-4 top-4 z-10">
        <LanguageToggle />
      </div>

      <div className="relative z-10 flex min-h-screen items-center justify-center px-4">
        <div className="w-full max-w-md">
          <div className="mb-8 flex flex-col items-center text-center">
            <div className="mb-4 animate-glow-pulse rounded-2xl border border-prism-600/40 bg-ink-850/60 p-3">
              <Logo size={44} />
            </div>
            <h1 className="font-display text-3xl font-black tracking-wider text-slate-100">
              PRISMX <span className="text-prism-400">Signal Lab</span>
            </h1>
            <p className="mt-1 text-sm tracking-widest text-slate-500">棱镜信号实验室</p>
            <p className="mt-3 max-w-xs text-sm text-slate-400">{t('auth.tagline')}</p>
          </div>

          <div className="card animate-fade-in-up p-6 shadow-prism-lg">
            <div className="mb-5 flex gap-2 rounded-xl border border-ink-700 bg-ink-900/50 p-1">
              <button
                onClick={() => setMode('login')}
                className={`flex-1 rounded-lg py-2 text-sm font-medium transition ${
                  mode === 'login' ? 'bg-prism-600 text-white' : 'text-slate-400'
                }`}
              >
                {t('auth.loginTitle')}
              </button>
              <button
                onClick={() => setMode('register')}
                className={`flex-1 rounded-lg py-2 text-sm font-medium transition ${
                  mode === 'register' ? 'bg-prism-600 text-white' : 'text-slate-400'
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
                <input
                  type="password"
                  required
                  className="input"
                  placeholder={t('auth.passwordPlaceholder')}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
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
          </div>
        </div>
      </div>
    </div>
  )
}
