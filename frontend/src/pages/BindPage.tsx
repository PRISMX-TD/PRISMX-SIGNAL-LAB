// EA 绑定页 / EA binding page
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { eaApi } from '../api/client'
import { useLive } from '../store/live'
import { fmtTime } from '../api/utils'

export default function BindPage() {
  const { t } = useTranslation()
  const { accounts, anyOnline, onlineAccounts, refreshAll } = useLive()
  // 状态卡片展示的主账号：优先在线账号，否则第一个已知账号。
  // Primary account for the status card: prefer an online one, else the first known.
  const primary = onlineAccounts[0] || accounts[0] || null

  const [apiToken, setApiToken] = useState('')
  const [boundAccount, setBoundAccount] = useState<string | null>(null)
  const [mt5Login, setMt5Login] = useState('')
  const [mt5Server, setMt5Server] = useState('')
  const [copied, setCopied] = useState(false)
  const [saved, setSaved] = useState(false)
  const [suffix, setSuffix] = useState('')
  const [suffixSaved, setSuffixSaved] = useState(false)

  const loadToken = async () => {
    const res = await eaApi.getToken()
    setApiToken(res.apiToken)
    setBoundAccount(res.boundAccount)
    if (res.boundAccount) setMt5Login(res.boundAccount)
  }

  useEffect(() => {
    loadToken()
  }, [])

  // 把后端已保存的后缀同步到输入框 / sync saved suffix into the input
  useEffect(() => {
    if (primary?.symbolSuffix != null) setSuffix(primary.symbolSuffix)
  }, [primary?.symbolSuffix])

  const copyToken = async () => {
    await navigator.clipboard.writeText(apiToken)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const resetToken = async () => {
    if (!confirm(t('bind.resetConfirm'))) return
    const res = await eaApi.resetToken()
    setApiToken(res.apiToken)
  }

  const saveAccount = async () => {
    await eaApi.registerAccount(mt5Login, mt5Server)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
    refreshAll()
  }

  const saveSuffix = async () => {
    await eaApi.setSuffix(suffix.trim())
    setSuffixSaved(true)
    setTimeout(() => setSuffixSaved(false), 2000)
    refreshAll()
  }

  return (
    <div>
      <div className="mb-6">
        <h2 className="font-display text-2xl font-bold text-slate-100">{t('bind.title')}</h2>
        <p className="mt-1 text-sm text-slate-400">{t('bind.subtitle')}</p>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        {/* 多账号列表（桥接程序上报）/ multi-account list reported by the bridge */}
        {accounts.length > 0 && (
          <div className="card p-5 lg:col-span-2">
            <h3 className="mb-1 font-display text-lg font-semibold text-slate-100">
              {t('bind.accountsTitle')}
            </h3>
            <p className="mb-4 text-xs text-slate-500">{t('bind.accountsHint')}</p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wider text-slate-500">
                    <th className="px-3 py-2">Login</th>
                    <th className="px-3 py-2">{t('bind.accountName')}</th>
                    <th className="px-3 py-2">{t('bind.company')}</th>
                    <th className="px-3 py-2 text-right">{t('bind.balance')}</th>
                    <th className="px-3 py-2 text-right">{t('bind.equity')}</th>
                    <th className="px-3 py-2 text-center">{t('bind.status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.map((a) => (
                    <tr key={a.login} className="border-t border-ink-700/60">
                      <td className="px-3 py-2 font-mono text-slate-100">{a.login}</td>
                      <td className="px-3 py-2 text-slate-300">{a.accountName || '—'}</td>
                      <td className="px-3 py-2 text-slate-400">{a.company || '—'}</td>
                      <td className="px-3 py-2 text-right font-mono text-slate-200">
                        {a.balance != null ? a.balance.toFixed(2) : '—'}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-slate-200">
                        {a.equity != null ? a.equity.toFixed(2) : '—'}
                      </td>
                      <td className="px-3 py-2 text-center">
                        <span className={`tag ${a.online ? 'bg-up/15 text-up' : 'bg-ink-700 text-slate-500'}`}>
                          {a.online ? t('common.online') : t('common.offline')}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Token 管理 / Token management */}
        <div className="card p-5">
          <h3 className="mb-1 font-display text-lg font-semibold text-slate-100">
            {t('bind.tokenTitle')}
          </h3>
          <p className="mb-4 text-xs text-slate-500">{t('bind.tokenHint')}</p>
          <div className="mb-3 flex items-center gap-2 rounded-xl border border-prism-600/30 bg-ink-900/60 p-3">
            <code className="flex-1 break-all font-mono text-sm text-prism-300">{apiToken}</code>
          </div>
          <div className="flex gap-3">
            <button onClick={copyToken} className="btn-primary flex-1 py-2 text-sm">
              {copied ? t('common.copied') : t('common.copy')}
            </button>
            <button onClick={resetToken} className="btn-ghost flex-1 py-2 text-sm">
              {t('bind.resetToken')}
            </button>
          </div>
        </div>

        {/* EA 状态 / EA status */}
        <div className="card p-5">
          <h3 className="mb-4 font-display text-lg font-semibold text-slate-100">
            {t('bind.statusTitle')}
          </h3>
          <div className="space-y-3">
            <div className="flex items-center justify-between rounded-lg bg-ink-900/50 px-4 py-3">
              <span className="text-sm text-slate-400">EA</span>
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
                {primary?.login || boundAccount || t('bind.none')}
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

        {/* MT5 账号登记 / MT5 account registration */}
        <div className="card p-5">
          <h3 className="mb-1 font-display text-lg font-semibold text-slate-100">
            {t('bind.accountTitle')}
          </h3>
          <p className="mb-4 text-xs text-slate-500">{t('bind.accountHint')}</p>
          <div className="space-y-3">
            <div>
              <label className="label">{t('bind.mt5Login')}</label>
              <input
                className="input font-mono"
                placeholder={t('bind.mt5LoginPlaceholder')}
                value={mt5Login}
                onChange={(e) => setMt5Login(e.target.value)}
              />
            </div>
            <div>
              <label className="label">{t('bind.mt5Server')}</label>
              <input
                className="input font-mono"
                placeholder={t('bind.mt5ServerPlaceholder')}
                value={mt5Server}
                onChange={(e) => setMt5Server(e.target.value)}
              />
            </div>
            <button onClick={saveAccount} className="btn-primary w-full py-2 text-sm">
              {saved ? t('bind.saved') : t('bind.saveAccount')}
            </button>
          </div>
        </div>

        {/* 品种后缀设置 / symbol suffix setting */}
        <div className="card p-5">
          <h3 className="mb-1 font-display text-lg font-semibold text-slate-100">
            {t('bind.suffixTitle')}
          </h3>
          <p className="mb-4 text-xs text-slate-500">{t('bind.suffixHint')}</p>
          <div className="space-y-3">
            <div>
              <label className="label">{t('bind.suffixLabel')}</label>
              <input
                className="input font-mono"
                placeholder={t('bind.suffixPlaceholder')}
                value={suffix}
                onChange={(e) => setSuffix(e.target.value)}
              />
            </div>
            <button onClick={saveSuffix} className="btn-primary w-full py-2 text-sm">
              {suffixSaved ? t('bind.saved') : t('bind.saveSuffix')}
            </button>
          </div>
        </div>

        {/* 接入步骤 / setup steps */}
        <div className="card p-5">
          <h3 className="mb-4 font-display text-lg font-semibold text-slate-100">
            {t('bind.steps.title')}
          </h3>
          <ol className="space-y-3">
            {['s1', 's2', 's3', 's4'].map((s, i) => (
              <li key={s} className="flex gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-prism-600/20 font-mono text-xs text-prism-300">
                  {i + 1}
                </span>
                <span className="text-sm text-slate-300">{t(`bind.steps.${s}`)}</span>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </div>
  )
}
