// 连接 MT5 页：Make Capital MT5 直连（无需本地 Bridge）。需要桥接程序的部分见 /bind/bridge。
// Connect MT5 page: Make Capital MT5 direct connect (no local Bridge needed).
// Everything requiring the Bridge app lives on /bind/bridge.
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { gatewayApi } from '../api/client'
import { useLive } from '../store/live'
import { localizeApiError } from '../api/utils'

export default function BindPage() {
  const { t } = useTranslation()
  const { accounts, refreshAll } = useLive()

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

      <div className="grid gap-5 lg:grid-cols-2">
        {/* Make Capital MT5 直连 */}
        <div className="glass p-6 lg:col-span-2">
          <div className="mb-5">
            <h3 className="font-display text-xl font-semibold text-slate-100">Make Capital MT5 直连</h3>
            <p className="mt-1 text-xs text-slate-400">无需本地 Bridge / VPS，直接通过网关连接 MT5</p>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <input
              className="input h-11 font-mono text-sm"
              type="text"
              inputMode="numeric"
              placeholder="MT5 账号 (Login)"
              value={gwLogin}
              onChange={(e) => { setGwLogin(e.target.value); setGwError(''); setGwResult(null) }}
            />
            <input
              className="input h-11 font-mono text-sm"
              type="password"
              placeholder="MT5 密码"
              value={gwPassword}
              onChange={(e) => { setGwPassword(e.target.value); setGwError(''); setGwResult(null) }}
              onKeyDown={(e) => e.key === 'Enter' && handleGatewayVerify()}
            />
            <button
              onClick={handleGatewayVerify}
              disabled={gwVerifying || !gwLogin || !gwPassword}
              className="btn-primary h-11 text-sm font-semibold disabled:opacity-50"
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
            <div className="mt-5 pt-5 border-t border-white/10">
              <p className="mb-3 text-sm font-medium text-slate-300">已绑定账号</p>
              <div className="space-y-2">
                {gatewayAccounts.map((a) => (
                  <div key={a.login} className="flex items-center justify-between rounded-lg bg-white/5 px-4 py-3 transition hover:bg-white/[0.07]">
                    <div className="flex items-center gap-3">
                      <div className={`h-2 w-2 rounded-full ${a.online ? 'bg-up animate-breathe' : 'bg-slate-500'}`} />
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-sm font-medium text-slate-100">{a.login}</span>
                          <span className="tag bg-prism-600/20 text-prism-300 text-[10px]">直连</span>
                        </div>
                        <div className="mt-0.5 flex items-center gap-3 text-xs text-slate-400">
                          <span>{a.accountName || '—'}</span>
                          {a.balance != null && <span>余额 ${a.balance.toFixed(2)}</span>}
                        </div>
                      </div>
                    </div>
                    <button
                      onClick={async () => {
                        try { await gatewayApi.remove(a.login); refreshAll() } catch {}
                      }}
                      className="rounded-lg border border-down/30 bg-down/5 px-3 py-1.5 text-xs font-medium text-down transition hover:bg-down/15"
                    >
                      解绑
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* 桥接程序入口 */}
        <Link
          to="/bind/bridge"
          className="glass group p-6 transition hover:border-prism-500/30 lg:col-span-2"
        >
          <div className="flex items-start justify-between">
            <div>
              <h3 className="font-display text-lg font-semibold text-slate-100 transition group-hover:text-prism-300">
                使用 PRISMX 桥接程序连接
              </h3>
              <p className="mt-1 text-sm text-slate-400">
                适用于非 Make Capital 账户，需要下载并运行本地桥接程序
              </p>
              <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-500">
                <span className="rounded bg-white/5 px-2 py-1">API Token 管理</span>
                <span className="rounded bg-white/5 px-2 py-1">桥接账户管理</span>
                <span className="rounded bg-white/5 px-2 py-1">品种后缀配置</span>
                <span className="rounded bg-white/5 px-2 py-1">接入步骤</span>
              </div>
            </div>
            <span className="text-2xl text-slate-600 transition group-hover:translate-x-1 group-hover:text-prism-400">→</span>
          </div>
        </Link>
      </div>
    </div>
  )
}
