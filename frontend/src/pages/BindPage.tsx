// 连接 MT5 页：合作券商 MT5 直连（无需本地 Bridge）。需要桥接程序的部分见 /bind/bridge。
//
// 页面顺序刻意是「开户福利 → 直连表单 → （折叠）桥接程序」：直连是绝大多数
// 用户唯一需要走的路，桥接是给非合作券商准备的兜底，从并列的入口卡降级成
// 默认收起的 <details>，免得新用户以为自己非装个程序不可。
//
// Connect MT5 page: partner-broker MT5 direct connect (no local Bridge needed).
// Everything requiring the Bridge app lives on /bind/bridge.
//
// The order — bonus offer, then the direct-connect form, then a collapsed bridge
// section — is deliberate: direct connect is the only path most users need, and
// the bridge is the fallback for non-partner brokers. It drops from a co-equal
// entry card to a closed-by-default <details> so new users don't conclude they
// must install something.
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { gatewayApi } from '../api/client'
import { useLive } from '../store/live'
import { localizeApiError } from '../api/utils'
import PartnerBrokerCard, { usePartnerBroker } from '../components/PartnerBrokerCard'

export default function BindPage() {
  const { t } = useTranslation()
  const { accounts, refreshAll } = useLive()
  const { name: brokerName } = usePartnerBroker()

  // ---------- Gateway 绑定状态（Make Capital 用户无需本地 Bridge）----------
  const [gwLogin, setGwLogin] = useState('')
  const [gwPassword, setGwPassword] = useState('')
  const [gwVerifying, setGwVerifying] = useState(false)
  const [gwResult, setGwResult] = useState<{ valid: boolean; name: string; balance: number; retcode: string } | null>(null)
  const [gwError, setGwError] = useState('')

  const handleGatewayVerify = async () => {
    const loginNum = parseInt(gwLogin, 10)
    if (!loginNum || loginNum <= 0) {
      setGwError(t('bind.gw.errLogin'))
      return
    }
    if (!gwPassword) {
      setGwError(t('bind.gw.errPassword'))
      return
    }
    setGwVerifying(true)
    setGwError('')
    setGwResult(null)
    try {
      const res = await gatewayApi.verify(loginNum, gwPassword)
      setGwResult({ valid: res.valid, name: res.name, balance: res.balance, retcode: res.retcode })
      if (res.valid) {
        setGwPassword('') // 验证通过后清空密码
        refreshAll()
      }
    } catch (e) {
      setGwError(e instanceof Error ? localizeApiError(e.message) : t('bind.gw.errFailed'))
    } finally {
      setGwVerifying(false)
    }
  }

  // 解绑失败必须说话。此前这里是 `catch {}`：后端拒绝或网络断了，按钮点下去
  // 界面纹丝不动，用户只能反复点，以为是自己没点到。复用上面那条错误横幅，
  // 不额外造一套提示。
  // A failed disconnect has to say so. This used to be `catch {}`: if the
  // backend refused or the network dropped, the button did visibly nothing and
  // the user just kept clicking, assuming they'd missed it. Reuses the error
  // banner above rather than introducing a second notification mechanism.
  const handleGatewayRemove = async (login: string) => {
    setGwError('')
    try {
      await gatewayApi.remove(login)
      refreshAll()
    } catch (e) {
      setGwError(e instanceof Error ? localizeApiError(e.message) : t('bind.gw.unbindFailed'))
    }
  }

  // Gateway 绑定的账号（过滤 source === "gateway"）
  const gatewayAccounts = accounts.filter((a) => a.source === 'gateway')

  return (
    <div>
      <div className="mb-6">
        <h2 className="font-display text-2xl font-bold text-neutral-100">
          <span className="neon-text">{t('bind.title')}</span>
        </h2>
        <p className="mt-1 text-sm text-neutral-400">{t('bind.gw.pageSubtitle', { name: brokerName })}</p>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* 开户福利：只在还没有直连账号时出现。已经连上的人不需要再被劝一次开户，
            那时这张卡只是占地方。
            Bonus offer, shown only while no direct-connect account exists. Someone
            already connected doesn't need to be pitched an account again — the
            card would just take up space. */}
        {gatewayAccounts.length === 0 && (
          <PartnerBrokerCard variant="compact" className="lg:col-span-2" />
        )}

        {/* 合作券商 MT5 直连 */}
        <div className="glass p-6 lg:col-span-2">
          <div className="mb-5">
            <h3 className="font-display text-xl font-semibold text-neutral-100">{t('bind.gw.title', { name: brokerName })}</h3>
            <p className="mt-1 text-xs text-neutral-400">{t('bind.gw.hint')}</p>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <input
              className="input h-11 font-mono text-sm"
              type="text"
              inputMode="numeric"
              placeholder={t('bind.gw.loginPlaceholder')}
              value={gwLogin}
              onChange={(e) => { setGwLogin(e.target.value); setGwError(''); setGwResult(null) }}
            />
            <input
              className="input h-11 font-mono text-sm"
              type="password"
              placeholder={t('bind.gw.passwordPlaceholder')}
              value={gwPassword}
              onChange={(e) => { setGwPassword(e.target.value); setGwError(''); setGwResult(null) }}
              onKeyDown={(e) => e.key === 'Enter' && handleGatewayVerify()}
            />
            <button
              onClick={handleGatewayVerify}
              disabled={gwVerifying || !gwLogin || !gwPassword}
              className="btn-primary h-11 text-sm font-semibold disabled:opacity-50"
            >
              {gwVerifying ? t('bind.gw.verifying') : t('bind.gw.verify')}
            </button>
          </div>

          {gwError && (
            <p className="mt-3 rounded-lg border border-down/30 bg-down/10 px-3 py-2 text-sm text-down">{gwError}</p>
          )}

          {gwResult && (
            <div className={`mt-3 rounded-lg border px-3 py-2 text-sm ${
              gwResult.valid ? 'border-up/30 bg-up/10 text-up' : 'border-amber-400/30 bg-amber-400/10 text-amber-300'
            }`}>
              {gwResult.valid
                ? t('bind.gw.verified', { name: gwResult.name, balance: gwResult.balance.toFixed(2) })
                : t('bind.gw.verifyFailed', { code: gwResult.retcode })}
            </div>
          )}

          {/* 已绑定的直连账号：与桥接页的账户表展示同一组信息（账户名/券商/余额/
              净值/状态）。gateway 不落库 company，券商列回落到合作券商名。
              Bound direct-connect accounts: same info set as the bridge page's
              account table (name / company / balance / equity / status). Gateway
              rows don't store company, so that column falls back to the partner
              broker name. */}
          {gatewayAccounts.length > 0 && (
            <div className="mt-5 pt-5 border-t border-white/10">
              <p className="mb-3 text-sm font-medium text-neutral-300">{t('bind.gw.boundTitle')}</p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wider text-neutral-500">
                      <th className="px-3 py-2">Login</th>
                      <th className="px-3 py-2">{t('bind.accountName')}</th>
                      <th className="px-3 py-2">{t('bind.company')}</th>
                      <th className="px-3 py-2 text-right">{t('bind.balance')}</th>
                      <th className="px-3 py-2 text-right">{t('bind.equity')}</th>
                      <th className="px-3 py-2 text-center">{t('bind.status')}</th>
                      <th className="px-3 py-2 text-center">{t('bind.actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {gatewayAccounts.map((a) => (
                      <tr key={a.login} className="border-t border-white/5">
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-neutral-100">{a.login}</span>
                            <span className="tag bg-prism-600/20 text-prism-300 text-[10px]">{t('bind.gw.tag')}</span>
                          </div>
                        </td>
                        <td className="px-3 py-2 text-neutral-300">{a.accountName || '—'}</td>
                        <td className="px-3 py-2 text-neutral-400">{a.company || brokerName}</td>
                        <td className="px-3 py-2 text-right font-mono text-neutral-200">
                          {a.balance != null ? a.balance.toFixed(2) : '—'}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-neutral-200">
                          {a.equity != null ? a.equity.toFixed(2) : '—'}
                        </td>
                        <td className="px-3 py-2 text-center">
                          <span className={`tag ${a.online ? 'bg-up/15 text-up' : 'bg-white/5 text-neutral-500'}`}>
                            {a.online ? t('common.online') : t('common.offline')}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-center">
                          <button
                            onClick={() => handleGatewayRemove(a.login)}
                            className="rounded-lg border border-down/30 bg-down/5 px-3 py-1.5 text-xs font-medium text-down transition hover:bg-down/15"
                          >
                            {t('bind.gw.unbind')}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        {/* 桥接程序入口（默认折叠）。用原生 <details> 而不是 useState：不需要
            额外状态，键盘可达性和「点标题展开」的语义浏览器已经给全了。
            Bridge entry, collapsed by default. Native <details> rather than
            useState: no extra state needed, and the browser already provides the
            keyboard affordance and click-the-heading-to-expand semantics. */}
        <details className="glass group overflow-hidden lg:col-span-2">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-6 py-4 transition hover:bg-white/[0.03] [&::-webkit-details-marker]:hidden">
            <div className="min-w-0">
              <span className="block text-sm font-medium text-neutral-300 transition group-open:text-neutral-100">
                {t('bind.bridgeEntry.collapsedTitle')}
              </span>
              <span className="mt-0.5 block text-xs leading-relaxed text-neutral-500">
                {t('bind.bridgeEntry.collapsedHint')}
              </span>
            </div>
            <span className="shrink-0 text-neutral-500 transition group-open:rotate-180 group-open:text-prism-400">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                <path d="m6 9 6 6 6-6" />
              </svg>
            </span>
          </summary>

          <div className="border-t border-white/10 px-6 pb-6 pt-5">
            <h3 className="font-display text-base font-semibold text-neutral-100">{t('bind.bridgeEntry.title')}</h3>
            <p className="mt-1 text-sm leading-relaxed text-neutral-400">{t('bind.bridgeEntry.desc', { name: brokerName })}</p>
            <div className="mt-3 flex flex-wrap gap-2 text-xs text-neutral-500">
              <span className="rounded bg-white/5 px-2 py-1">{t('bind.bridgeEntry.f1')}</span>
              <span className="rounded bg-white/5 px-2 py-1">{t('bind.bridgeEntry.f2')}</span>
              <span className="rounded bg-white/5 px-2 py-1">{t('bind.bridgeEntry.f3')}</span>
              <span className="rounded bg-white/5 px-2 py-1">{t('bind.bridgeEntry.f4')}</span>
            </div>
            <Link
              to="/bind/bridge"
              className="btn btn-ghost mt-4 h-10 px-5 text-sm"
            >
              {t('bind.bridgeEntry.openCta')} →
            </Link>
          </div>
        </details>
      </div>
    </div>
  )
}
