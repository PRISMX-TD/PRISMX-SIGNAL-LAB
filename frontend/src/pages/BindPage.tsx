// 连接 MT5 页：Make Capital MT5 直连（无需本地 Bridge）。需要桥接程序的部分见 /bind/bridge。
// Connect MT5 page: Make Capital MT5 direct connect (no local Bridge needed).
// Everything requiring the Bridge app lives on /bind/bridge.
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { gatewayApi } from '../api/client'
import { useLive } from '../store/live'
import { fmtTime, localizeApiError } from '../api/utils'

export default function BindPage() {
  const { t } = useTranslation()
  const { accounts, brokerLock, anyOnline, onlineAccounts, refreshAll } = useLive()
  // 状态卡片展示的主账号：优先在线账号，否则第一个已知账号。
  // Primary account for the status card: prefer an online one, else the first known.
  const primary = onlineAccounts[0] || accounts[0] || null

  // ---------- Gateway 绑定状态（Make Capital 用户无需本地 Bridge）----------
  const [gwLogin, setGwLogin] = useState('')
  const [gwPassword, setGwPassword] = useState('')
  const [gwVerifying, setGwVerifying] = useState(false)
  const [gwResult, setGwResult] = useState<{ valid: boolean; name: string; balance: number; retcode: string } | null>(null)
  const [gwError, setGwError] = useState('')

  const handleGatewayVerify = async () => {
    const loginNum = parseInt(gwLogin, 10)
    if (!loginNum || loginNum <= 0) {
      setGwError('请输入有效的 MT5 账号')
      return
    }
    if (!gwPassword) {
      setGwError('请输入密码')
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
      setGwError(e instanceof Error ? localizeApiError(e.message) : '验证失败')
    } finally {
      setGwVerifying(false)
    }
  }

  // Gateway 绑定的账号（过滤 source === "gateway"）
  const gatewayAccounts = accounts.filter((a) => a.source === 'gateway')

  return (
    <div>
      <div className="mb-6">
        <h2 className="font-display text-2xl font-bold text-slate-100">
          <span className="neon-text">{t('bind.title')}</span>
        </h2>
        <p className="mt-1 text-sm text-slate-400">
          填入你的 Make Capital MT5 账号与密码，即可直接连接，无需安装任何程序
        </p>
      </div>

      {/* 合作券商限制提示 / partner-broker lock notice */}
      {brokerLock?.enabled && (
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-prism-600/30 bg-prism-600/10 px-4 py-3">
          <p className="text-sm text-prism-200">
            {t('bind.brokerOnly', { name: brokerLock.displayName })}
          </p>
          {brokerLock.referralUrl && (
            <a
              href={brokerLock.referralUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-primary px-4 py-1.5 text-xs"
            >
              {t('bind.brokerOpenAccount')}
            </a>
          )}
        </div>
      )}

      {/* Make Capital MT5 直连（常驻展开，不再折叠） */}
      <div className="mb-5 glass p-5">
        <div className="mb-4">
          <h3 className="font-display text-lg font-semibold text-slate-100">Make Capital MT5 直连</h3>
          <p className="mt-0.5 text-xs text-slate-400">无需本地 Bridge / VPS，直接通过网关连接 MT5</p>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <input
            className="input h-10 font-mono text-sm"
            type="text"
            inputMode="numeric"
            placeholder="MT5 账号 (Login)"
            value={gwLogin}
            onChange={(e) => { setGwLogin(e.target.value); setGwError(''); setGwResult(null) }}
          />
          <input
            className="input h-10 font-mono text-sm"
            type="password"
            placeholder="MT5 密码"
            value={gwPassword}
            onChange={(e) => { setGwPassword(e.target.value); setGwError(''); setGwResult(null) }}
            onKeyDown={(e) => e.key === 'Enter' && handleGatewayVerify()}
          />
          <button
            onClick={handleGatewayVerify}
            disabled={gwVerifying || !gwLogin || !gwPassword}
            className="btn-primary h-10 text-sm font-semibold disabled:opacity-50"
          >
            {gwVerifying ? '验证中...' : '验证并绑定'}
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
              ? `验证通过: ${gwResult.name}, 余额 $${gwResult.balance.toFixed(2)}`
              : `验证失败: ${gwResult.retcode}`}
          </div>
        )}

        {/* 已绑定的直连账号 */}
        {gatewayAccounts.length > 0 && (
          <div className="mt-4">
            <p className="mb-2 text-xs font-medium text-slate-400">已绑定的直连账号:</p>
            {gatewayAccounts.map((a) => (
              <div key={a.login} className="mb-2 flex items-center justify-between rounded-lg bg-white/5 px-3 py-2">
                <div>
                  <span className="font-mono text-sm text-slate-200">{a.login}</span>
                  <span className="ml-2 text-xs text-slate-500">{a.accountName || '—'}</span>
                  <span className="ml-2 tag bg-prism-600/20 text-prism-300 text-[10px]">直连</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-400">
                    余额 ${(a.balance ?? 0).toFixed(2)}
                  </span>
                  <button
                    onClick={async () => {
                      try { await gatewayApi.remove(a.login); refreshAll() } catch {}
                    }}
                    className="rounded border border-down/30 bg-down/5 px-2 py-0.5 text-[11px] text-down hover:bg-down/15"
                  >
                    解绑
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 桥接程序入口：非 Make Capital 账户 / 需要本地 Bridge 的用户走这里 */}
      <Link
        to="/bind/bridge"
        className="mb-5 flex items-center justify-between rounded-xl border border-white/10 bg-white/5 px-4 py-3 transition hover:border-white/20"
      >
        <div>
          <h3 className="font-semibold text-slate-100">使用 PRISMX 桥接程序连接</h3>
          <p className="mt-0.5 text-xs text-slate-400">
            API Token、桥接账户管理、品种后缀与接入步骤
          </p>
        </div>
        <span className="text-sm text-slate-500">前往 →</span>
      </Link>

      {/* MT5 连接状态 */}
      <div className="glass p-5">
        <h3 className="mb-4 font-display text-lg font-semibold text-slate-100">
          {t('bind.statusTitle')}
        </h3>
        <div className="space-y-3">
          <div className="flex items-center justify-between rounded-lg bg-ink-900/50 px-4 py-3">
            <span className="text-sm text-slate-400">{t('bind.connection')}</span>
            <span className="flex items-center gap-2">
              <span
                className={`h-2 w-2 rounded-full ${
                  anyOnline ? 'bg-up animate-breathe' : 'bg-slate-500'
                }`}
              />
              <span className={`text-sm ${anyOnline ? 'text-up' : 'text-slate-400'}`}>
                {anyOnline ? t('common.online') : t('common.offline')}
              </span>
            </span>
          </div>
          <div className="flex items-center justify-between rounded-lg bg-ink-900/50 px-4 py-3">
            <span className="text-sm text-slate-400">{t('bind.boundAccount')}</span>
            <span className="font-mono text-sm text-slate-200">
              {primary?.login || t('bind.none')}
            </span>
          </div>
          <div className="flex items-center justify-between rounded-lg bg-ink-900/50 px-4 py-3">
            <span className="text-sm text-slate-400">{t('bind.lastHeartbeat')}</span>
            <span className="font-mono text-sm text-slate-200">
              {fmtTime(primary?.lastHeartbeat)}
            </span>
          </div>
          {primary?.accountName && (
            <div className="flex items-center justify-between rounded-lg bg-ink-900/50 px-4 py-3">
              <span className="text-sm text-slate-400">{t('bind.accountName')}</span>
              <span className="font-mono text-sm text-slate-200">{primary.accountName}</span>
            </div>
          )}
          {primary?.company && (
            <div className="flex items-center justify-between rounded-lg bg-ink-900/50 px-4 py-3">
              <span className="text-sm text-slate-400">{t('bind.company')}</span>
              <span className="font-mono text-sm text-slate-200">{primary.company}</span>
            </div>
          )}
          {(primary?.balance != null || primary?.equity != null) && (
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg bg-ink-900/50 px-4 py-3">
                <div className="text-xs text-slate-400">
                  {t('bind.balance')}
                  {primary?.accountCurrency ? ` (${primary.accountCurrency})` : ''}
                </div>
                <div className="mt-1 font-mono text-sm text-slate-100">
                  {primary?.balance != null ? primary.balance.toFixed(2) : '—'}
                </div>
              </div>
              <div className="rounded-lg bg-ink-900/50 px-4 py-3">
                <div className="text-xs text-slate-400">
                  {t('bind.equity')}
                  {primary?.accountCurrency ? ` (${primary.accountCurrency})` : ''}
                </div>
                <div className="mt-1 font-mono text-sm text-slate-100">
                  {primary?.equity != null ? primary.equity.toFixed(2) : '—'}
                </div>
              </div>
            </div>
          )}
          {primary?.leverage != null && primary.leverage > 0 && (
            <div className="flex items-center justify-between rounded-lg bg-ink-900/50 px-4 py-3">
              <span className="text-sm text-slate-400">{t('bind.leverage')}</span>
              <span className="font-mono text-sm text-slate-200">1:{primary.leverage}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
