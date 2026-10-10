// 邮箱验证落地页：/verify-email?token=...（验证邮件里的链接落在这里）
//
// 打开即自动提交，不让用户再点一个「确认」——他点邮件链接就是在确认。后端幂等
// （同一个链接点两次都成功），所以 React 开发模式的双发、邮件网关预抓取都不会把
// 用户弄成「链接已失效」。
//
// 登录与否都能用：常见情形是在手机上点开邮件、而登录态在电脑上。已登录就顺手刷新
// 一次登录态，让提示条立刻消失；没登录就给一个去登录的按钮。验证本身**不登录**
// （理由同找回密码：邮件链接会被转发、被预抓取）。
//
// Verification landing page. Submits on open — clicking the mail link is the
// confirmation. The backend is idempotent, so a dev-mode double effect or a
// gateway prefetch can't turn into "link expired". Works signed in or out (the
// mail is often opened on a phone); verifying never signs anyone in.
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../store/auth'
import { authApi } from '../api/client'
import Logo from '../components/Logo'
import LanguageToggle from '../components/LanguageToggle'
import AuroraBackground from '../components/AuroraBackground'
import { useUrlToken } from '../utils/urlToken'

type Phase = 'verifying' | 'done' | 'failed'

export default function VerifyEmailPage() {
  const { t } = useTranslation()
  const { isAuthed, refreshUser } = useAuth()
  // 令牌读一次就从地址栏抹掉，刷新靠本标签页的 sessionStorage 副本，验证成功后清掉
  // （见 utils/urlToken.ts）。/ Read once, removed from the URL; reload uses this tab's
  // sessionStorage copy, cleared on success.
  const [token, clearToken] = useUrlToken('prismx.verifyEmailToken')
  const [phase, setPhase] = useState<Phase>(token ? 'verifying' : 'failed')
  // 每个令牌只提交一次（StrictMode 下 effect 会跑两遍；后端虽幂等，也没必要多打）。
  // One submit per token (StrictMode runs effects twice; harmless, but pointless).
  const submitted = useRef('')

  useEffect(() => {
    if (!token || submitted.current === token) return
    submitted.current = token
    authApi
      .verifyEmail(token)
      .then(() => {
        clearToken()
        setPhase('done')
        // 已登录：刷新登录态，提示条与各处的「先验证」引导随之撤掉。
        if (isAuthed) refreshUser()
      })
      .catch(() => setPhase('failed'))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只按令牌提交 / keyed on the token only
  }, [token])

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

          <div className="glass animate-fade-in-up p-6" aria-live="polite">
            {phase === 'verifying' ? (
              <div className="flex items-center gap-3 text-sm text-neutral-300">
                <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-white/20 border-t-white" />
                {t('emailVerify.pageVerifying')}
              </div>
            ) : phase === 'done' ? (
              <>
                <h2 className="font-display text-lg font-semibold text-neutral-100">{t('emailVerify.pageDoneTitle')}</h2>
                <p className="mt-2 text-sm leading-relaxed text-neutral-400">{t('emailVerify.pageDoneBody')}</p>
                {isAuthed ? (
                  <Link to="/bind" className="btn btn-primary mt-5 w-full">{t('emailVerify.goBind')}</Link>
                ) : (
                  <Link to="/login" className="btn btn-primary mt-5 w-full">{t('auth.login')}</Link>
                )}
              </>
            ) : (
              <>
                <h2 className="font-display text-lg font-semibold text-neutral-100">{t('emailVerify.pageFailTitle')}</h2>
                <p className="mt-2 text-sm leading-relaxed text-neutral-400">{t('emailVerify.pageFailBody')}</p>
                <Link to={isAuthed ? '/dashboard' : '/login'} className="btn btn-ghost mt-5 w-full">
                  {isAuthed ? t('emailVerify.backToApp') : t('auth.login')}
                </Link>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
