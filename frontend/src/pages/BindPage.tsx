// 连接 MT5 页：通过 PRISMX 桥接程序连接 MT5 账户。
// Connect MT5 page: connect MT5 accounts via the PRISMX Bridge app.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { accountApi, eaApi } from '../api/client'
import { useLive } from '../store/live'
import { fmtTime } from '../api/utils'

export default function BindPage() {
  const { t } = useTranslation()
  const { accounts, anyOnline, onlineAccounts, refreshAll } = useLive()
  // 状态卡片展示的主账号：优先在线账号，否则第一个已知账号。
  // Primary account for the status card: prefer an online one, else the first known.
  const primary = onlineAccounts[0] || accounts[0] || null

  // Token 明文仅在生成（重置）时返回一次；查询时为 null，界面显示"已隐藏"。
  // The plaintext token is returned once at generation; reads yield null and
  // the UI shows a "hidden" hint.
  const [apiToken, setApiToken] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [suffix, setSuffix] = useState('')
  const [suffixSaved, setSuffixSaved] = useState(false)

  useEffect(() => {
    eaApi.getToken().then((res) => setApiToken(res.apiToken)).catch(() => {})
  }, [])

  // 把后端已保存的后缀同步到输入框 / sync saved suffix into the input
  useEffect(() => {
    if (primary?.symbolSuffix != null) setSuffix(primary.symbolSuffix)
  }, [primary?.symbolSuffix])

  const copyToken = async () => {
    if (!apiToken) return
    await navigator.clipboard.writeText(apiToken)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const resetToken = async () => {
    if (!confirm(t('bind.resetConfirm'))) return
    const res = await eaApi.resetToken()
    setApiToken(res.apiToken)
  }

  // 后缀按账号保存（Bridge 上报的账号）；无账号时按钮置灰。
  // Suffix is saved per account (as reported by the bridge); disabled with no account.
  const saveSuffix = async () => {
    if (!primary) return
    await accountApi.setSuffix(primary.login, suffix.trim())
    setSuffixSaved(true)
    setTimeout(() => setSuffixSaved(false), 2000)
    refreshAll()
  }

  return (
    <div>
      <div className="mb-6">
        <h2 className="font-display text-2xl font-bold text-slate-100">
          <span className="neon-text">{t('bind.title')}</span>
        </h2>
        <p className="mt-1 text-sm text-slate-400">{t('bind.subtitle')}</p>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        {/* PLACEHOLDER_ACCOUNTS */}
        {accounts.length > 0 && (
          <div className="glass p-5 lg:col-span-2">
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
                    <tr key={a.login} className="border-t border-white/5">
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
                        <span className={`tag ${a.online ? 'bg-up/15 text-up' : 'bg-white/5 text-slate-500'}`}>
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

        {/* PLACEHOLDER_TOKEN */}
        <div className="glass p-5">
          <h3 className="mb-1 font-display text-lg font-semibold text-slate-100">
            {t('bind.tokenTitle')}
          </h3>
          <p className="mb-4 text-xs text-slate-500">{t('bind.tokenHint')}</p>
          <div className="mb-3 flex items-center gap-2 rounded-xl border border-prism-600/30 bg-prism-600/5 p-3">
            {apiToken ? (
              <code className="flex-1 break-all font-mono text-sm text-prism-300">{apiToken}</code>
            ) : (
              <span className="flex-1 text-xs leading-relaxed text-slate-400">{t('bind.tokenHidden')}</span>
            )}
          </div>
          {apiToken && (
            <p className="mb-3 text-xs leading-relaxed text-amber-400/90">{t('bind.tokenJustOnce')}</p>
          )}
          <div className="flex gap-3">
            <button
              onClick={copyToken}
              disabled={!apiToken}
              className="btn-primary flex-1 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
            >
              {copied ? t('common.copied') : t('common.copy')}
            </button>
            <button onClick={resetToken} className="btn-ghost flex-1 py-2 text-sm">
              {t('bind.resetToken')}
            </button>
          </div>
        </div>

        {/* PLACEHOLDER_STATUS */}
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

        {/* PLACEHOLDER_SUFFIX */}
        <div className="glass p-5">
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
            <button
              onClick={saveSuffix}
              disabled={!primary}
              className="btn-primary w-full py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
            >
              {suffixSaved ? t('bind.saved') : t('bind.saveSuffix')}
            </button>
            {!primary && (
              <p className="text-xs text-slate-500">{t('bind.suffixNeedAccount')}</p>
            )}
          </div>
        </div>

        {/* PLACEHOLDER_STEPS */}
        <div className="glass p-5">
          <h3 className="mb-4 font-display text-lg font-semibold text-slate-100">
            {t('bind.steps.title')}
          </h3>
          <ol className="space-y-3">
            {['s1', 's2', 's3', 's4'].map((s, i) => (
              <li key={s} className="flex gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-neon-gradient font-mono text-xs font-bold text-white shadow-prism">
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
