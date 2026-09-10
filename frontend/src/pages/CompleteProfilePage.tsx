// 补全资料：还欠手机号或昵称的用户被拦在这里，填完才能进主应用。
//
// 两件事共用一页，因为它们的性质相同——账号缺一个必填项，而缺口只能在登录后
// 补。分成两页的话，两样都欠的 Google 新用户要连过两道门，中间那次跳转除了
// 多一次白屏什么也不做。
//
// 手机号：Google 登录是「验证完身份直接建号」，中间没有表单可以插入手机号，
// 所以只能在这里拦。存量用户不会看到这一项：needsPhone 由后端算，只有
// phone_required 为真且还没填的账号才为真，迁移已把上线时已存在的用户全部
// 标成豁免。
//
// 昵称：全员必填（2026-09-10 起），**包括存量用户**——没有对应的豁免列，空
// 即是欠。所以老用户下次进来也会在这里被拦一次，填完就再也不会看到。
//
// Gate for accounts still missing a required field that can only be collected
// after login. Both live on one page because a Google-created account owes
// both, and splitting them would only add a blank redirect in between.
// Phone: Google accounts are created straight from a verified identity with no
// form in between; pre-existing users are grandfathered server-side.
// Nickname: required of everyone from 2026-09-10, existing users included —
// there is no grandfathering column, so empty simply means owed.
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
  const { user, submitPhone, submitNickname, logout } = useAuth()
  const navigate = useNavigate()

  const [phone, setPhone] = useState<PhoneValue>({ iso: DEFAULT_DIAL_ISO, national: '' })
  const [nickname, setNickname] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  // 已经什么都不欠的人不该停在这里（比如手动敲了这个地址，或在另一个标签页填完了）。
  // Anyone who owes nothing shouldn't sit here (hand-typed URL, or filled it in
  // from another tab).
  if (!user) return <Navigate to="/login" replace />
  const needsPhone = !!user.needsPhone
  const needsNickname = !!user.needsNickname
  if (!needsPhone && !needsNickname) return <Navigate to="/dashboard" replace />

  const subtitle = needsPhone && needsNickname
    ? t('auth.completeSubtitleBoth')
    : needsPhone
      ? t('auth.completeSubtitle')
      : t('auth.completeSubtitleNickname')

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      // 顺序提交，不并发：两个接口都写 users 同一行，并发时后写的那次
      // db.refresh 可能看不到另一次的改动。先手机号后昵称——昵称有重名这条
      // 会真的失败的校验，放在后面，失败时手机号已经落库，页面会重画成
      // 「只差昵称」，用户不用把号码再敲一遍。
      // Sequential, not concurrent: both endpoints write the same users row.
      // Phone first because the nickname has a check that genuinely fails
      // (already taken) — on failure the phone is already saved and the page
      // redraws asking only for the nickname, with nothing to re-type.
      if (needsPhone) await submitPhone(dialCodeOf(phone.iso), phone.national)
      if (needsNickname) await submitNickname(nickname.trim())
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
            <p className="mt-2 text-center text-sm text-neutral-400">{subtitle}</p>
          </div>

          <div className="card p-6">
            <form onSubmit={onSubmit} className="space-y-4">
              <div className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-neutral-300">
                {user.email}
              </div>

              {needsPhone && <PhoneField value={phone} onChange={setPhone} autoFocus />}

              {needsNickname && (
                <div>
                  <label className="label" htmlFor="complete-nickname">
                    {t('gamification.profile.nickname')}
                  </label>
                  <input
                    id="complete-nickname"
                    className="input"
                    value={nickname}
                    onChange={(e) => setNickname(e.target.value)}
                    maxLength={20}
                    autoFocus={!needsPhone}
                    autoComplete="nickname"
                    placeholder={t('auth.nicknamePlaceholder')}
                  />
                  <p className="mt-1.5 text-xs text-neutral-500">{t('auth.nicknameHint')}</p>
                </div>
              )}

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
