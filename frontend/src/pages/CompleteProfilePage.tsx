// 补录手机号：Google 注册的用户首次登录后被拦在这里，填完才能进主应用。
//
// 为什么需要这个页面：Google 登录是「验证完身份直接建号」，中间没有表单可以插入
// 手机号。要么在这里拦一下，要么就接受 Google 注册的用户没有手机号——产品选择了
// 前者（见 Protected 里的守卫）。
//
// 存量用户不会看到这个页面：needsPhone 由后端算，只有 phone_required 为真且还没
// 填的账号才为真，而迁移已经把上线时已存在的用户全部标成豁免。
//
// Gate for Google-created accounts, which are created straight from a verified
// identity with no form in between to collect a phone. Pre-existing users never
// see it: needsPhone is computed server-side and the migration grandfathered
// everyone who existed at launch.
import { useState, type FormEvent } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../store/auth'
import { localizeApiError } from '../api/utils'
import Logo from '../components/Logo'
import LanguageToggle from '../components/LanguageToggle'
import AuroraBackground from '../components/AuroraBackground'
import PhoneField, { dialCodeOf, type PhoneValue } from '../components/PhoneField'
import { DEFAULT_DIAL_ISO } from '../data/dialCodes'

export default function CompleteProfilePage() {
  const { t } = useTranslation()
  const { user, submitPhone, logout } = useAuth()
  const navigate = useNavigate()

  const [phone, setPhone] = useState<PhoneValue>({ iso: DEFAULT_DIAL_ISO, national: '' })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  // 已经不欠手机号的人不该停在这里（比如手动敲了这个地址，或在另一个标签页填完了）。
  // Anyone who no longer owes a phone shouldn't sit here (hand-typed URL, or
  // filled it in from another tab).
  if (!user) return <Navigate to="/login" replace />
  if (!user.needsPhone) return <Navigate to="/dashboard" replace />

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await submitPhone(dialCodeOf(phone.iso), phone.national)
      navigate('/dashboard', { replace: true })
    } catch (err) {
      setError(err instanceof Error ? localizeApiError(err.message) : t('auth.errorFailed'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="relative min-h-[100dvh] overflow-hidden">
      <AuroraBackground />
      <div className="absolute right-4 top-4 z-10">
        <LanguageToggle />
      </div>

      <div className="relative z-10 flex min-h-[100dvh] items-center justify-center px-4 py-12">
        <div className="w-full max-w-md">
          <div className="mb-8 flex flex-col items-center">
            <Logo size={72} />
            <h1 className="mt-4 font-display text-3xl font-bold">
              <span className="neon-text">{t('auth.completeTitle')}</span>
            </h1>
            <p className="mt-2 text-center text-sm text-neutral-400">{t('auth.completeSubtitle')}</p>
          </div>

          <div className="card p-6">
            <form onSubmit={onSubmit} className="space-y-4">
              <div className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-neutral-300">
                {user.email}
              </div>

              <PhoneField value={phone} onChange={setPhone} autoFocus />

              {error && (
                <div className="rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-sm text-down">
                  {error}
                </div>
              )}

              <button type="submit" disabled={loading} className="btn-primary w-full py-2.5">
                {loading ? t('common.loading') : t('auth.completeSubmit')}
              </button>
            </form>

            {/* 留一个出口。没有它，一个不想填的用户会被永久卡在这一页——既进不去
                也退不出，只能清浏览器数据，那是最糟的死角。
                An exit. Without it a user unwilling to fill this in is stuck on a
                page they can neither pass nor leave, short of clearing site data. */}
            <button
              type="button"
              onClick={() => { logout(); navigate('/login', { replace: true }) }}
              className="mt-4 w-full text-center text-xs text-neutral-500 transition hover:text-neutral-300"
            >
              {t('auth.completeSignOut')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
