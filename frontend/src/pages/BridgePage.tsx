// 桥接连接子页：需要本地 PRISMX Bridge 的部分（API Token、已连接账户、品种后缀、接入步骤）。
// Bridge sub-page: everything that requires the local PRISMX Bridge (API token,
// connected accounts, symbol suffix, setup steps).
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { accountApi, eaApi } from '../api/client'
import { useLive } from '../store/live'
import { localizeApiError } from '../api/utils'
import ConfirmModal from '../components/ConfirmModal'
import TokenRevealModal from '../components/TokenRevealModal'
import { useBackToClose } from '../utils/useBackToClose'
import type { MT5Account } from '../api/types'

export default function BridgePage() {
  const { t } = useTranslation()
  const { accounts, accountLimit, refreshAll } = useLive()
  const atAccountLimit = accountLimit != null && accounts.length >= accountLimit
  // 从未连接过任何账号：还没有 Bridge 在用这个 token，"重置"框架的危险确认
  // 没有意义——对这种用户，第一次拿 token 应该叫"生成"。
  // Never connected any account: no Bridge is using this token yet, so the
  // "reset" framing's danger confirmation doesn't apply — for this user,
  // getting their first token should read as "generate".
  const neverConnected = accounts.length === 0

  const [apiToken, setApiToken] = useState<string | null>(null)
  const [revealToken, setRevealToken] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false)
  const [resetting, setResetting] = useState(false)

  // 每个账号的品种后缀草稿 + 保存状态 / per-account suffix draft + save state
  const [suffixDrafts, setSuffixDrafts] = useState<Record<string, string>>({})
  const [savingLogin, setSavingLogin] = useState<string | null>(null)
  const [savedLogin, setSavedLogin] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<MT5Account | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState('')

  // Bridge 上报的账号（Gateway 直连的账号在 /bind 主页管理）
  // Bridge-reported accounts (gateway-direct ones are managed on /bind).
  const bridgeAccounts = accounts.filter((a) => a.source !== 'gateway')

  useBackToClose(resetConfirmOpen, () => setResetConfirmOpen(false))
  useBackToClose(revealToken != null, () => setRevealToken(null))
  useBackToClose(deleteTarget != null, () => {
    setDeleteTarget(null)
    setDeleteError('')
  })

  useEffect(() => {
    eaApi.getToken().then((res) => setApiToken(res.apiToken)).catch(() => {})
  }, [])

  // 把后端已保存的后缀同步到各账号的草稿输入框（不覆盖用户正在编辑的值）
  // Sync saved suffixes into per-account drafts (without clobbering an in-progress edit)
  useEffect(() => {
    setSuffixDrafts((prev) => {
      const next = { ...prev }
      for (const a of accounts) {
        if (!(a.login in next)) next[a.login] = a.symbolSuffix ?? ''
      }
      return next
    })
  }, [accounts])

  const copyToken = async () => {
    if (!apiToken) return
    await navigator.clipboard.writeText(apiToken)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const resetToken = async () => {
    setResetting(true)
    try {
      const res = await eaApi.resetToken()
      setApiToken(res.apiToken)
      setRevealToken(res.apiToken)
      setResetConfirmOpen(false)
    } finally {
      setResetting(false)
    }
  }

  const saveSuffix = async (login: string) => {
    setSavingLogin(login)
    try {
      await accountApi.setSuffix(login, (suffixDrafts[login] ?? '').trim())
      setSavedLogin(login)
      setTimeout(() => setSavedLogin(null), 2000)
      refreshAll()
    } finally {
      setSavingLogin(null)
    }
  }

  const confirmDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    setDeleteError('')
    try {
      await accountApi.remove(deleteTarget.login, deleteTarget.server)
      setDeleteTarget(null)
      refreshAll()
    } catch (e) {
      setDeleteError(e instanceof Error ? localizeApiError(e.message) : 'error')
      setTimeout(() => setDeleteError(''), 4000)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div>
      <div className="mb-6">
        <Link to="/bind" className="text-xs text-neutral-400 transition hover:text-prism-300">
          ← 返回 MT5 连接
        </Link>
        <h2 className="mt-2 font-display text-2xl font-bold text-neutral-100">
          <span className="neon-text">桥接程序连接</span>
        </h2>
        <p className="mt-1 text-sm text-neutral-400">{t('bind.subtitle')}</p>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        {bridgeAccounts.length > 0 && (
          <div className="glass p-5 lg:col-span-2">
            <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-display text-lg font-semibold text-neutral-100">
                {t('bind.accountsTitle')}
              </h3>
              <span className={`tag text-xs ${atAccountLimit ? 'bg-amber-500/15 text-amber-400' : 'bg-white/5 text-neutral-400'}`}>
                {accountLimit == null
                  ? t('bind.accountQuotaUnlimited', { n: accounts.length })
                  : t('bind.accountQuota', { n: accounts.length, max: accountLimit })}
              </span>
            </div>
            <p className="mb-4 text-xs text-neutral-500">{t('bind.accountsHint')}</p>
            {atAccountLimit && (
              <p className="mb-4 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-300">
                {t('bind.accountQuotaReached')}
              </p>
            )}
            {/* whitespace-nowrap：窄屏下保持列宽由内容决定、外层横向滚动，
                表头不被挤成竖排（与 /bind 的直连账号表同一处理）。
                whitespace-nowrap: on narrow screens columns keep their content
                width and the wrapper scrolls, headers never squeeze into
                vertical stacks (same treatment as the /bind table). */}
            <div className="overflow-x-auto">
              <table className="w-full whitespace-nowrap text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wider text-neutral-500">
                    <th className="px-3 py-2">Login</th>
                    <th className="px-3 py-2">{t('bind.accountName')}</th>
                    <th className="px-3 py-2">{t('bind.company')}</th>
                    <th className="px-3 py-2 text-right">{t('bind.balance')}</th>
                    <th className="px-3 py-2 text-right">{t('bind.equity')}</th>
                    <th className="px-3 py-2 text-center">{t('bind.status')}</th>
                    <th className="px-3 py-2">{t('bind.suffixLabel')}</th>
                    <th className="px-3 py-2 text-center">{t('bind.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {bridgeAccounts.map((a) => (
                    <tr key={a.login} className="border-t border-white/5">
                      <td className="px-3 py-2 font-mono text-neutral-100">{a.login}</td>
                      <td className="px-3 py-2 text-neutral-300">{a.accountName || '—'}</td>
                      <td className="px-3 py-2 text-neutral-400">{a.company || '—'}</td>
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
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-1.5">
                          <input
                            className="input h-7 w-20 font-mono text-xs"
                            placeholder={t('bind.suffixPlaceholder')}
                            value={suffixDrafts[a.login] ?? ''}
                            onChange={(e) =>
                              setSuffixDrafts((prev) => ({ ...prev, [a.login]: e.target.value }))
                            }
                          />
                          <button
                            onClick={() => saveSuffix(a.login)}
                            disabled={savingLogin === a.login}
                            className="btn-ghost px-2 py-1 text-[11px] disabled:opacity-50"
                          >
                            {savedLogin === a.login ? t('bind.saved') : t('common.save')}
                          </button>
                        </div>
                      </td>
                      <td className="px-3 py-2 text-center">
                        <button
                          onClick={() => setDeleteTarget(a)}
                          disabled={a.online}
                          title={a.online ? t('bind.deleteNeedOffline') : t('bind.deleteAccount')}
                          className="rounded-lg border border-down/30 bg-down/5 px-2 py-1 text-[11px] font-medium text-down transition hover:bg-down/15 disabled:cursor-not-allowed disabled:opacity-30"
                        >
                          {t('common.delete')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div className="glass p-5">
          <h3 className="mb-1 font-display text-lg font-semibold text-neutral-100">
            {t('bind.tokenTitle')}
          </h3>
          <p className="mb-4 text-xs text-neutral-500">{t('bind.tokenHint')}</p>
          <div className="mb-3 flex items-center gap-2 rounded-xl border border-prism-600/30 bg-prism-600/5 p-3">
            {apiToken ? (
              <code className="flex-1 break-all font-mono text-sm text-prism-300">{apiToken}</code>
            ) : (
              <span className="flex-1 text-xs leading-relaxed text-neutral-400">
                {neverConnected ? t('bind.tokenNeverGenerated') : t('bind.tokenHidden')}
              </span>
            )}
          </div>
          {apiToken && (
            <p className="mb-3 text-xs leading-relaxed text-amber-400/90">{t('bind.tokenJustOnce')}</p>
          )}
          {!apiToken && neverConnected ? (
            <button
              onClick={resetToken}
              disabled={resetting}
              className="btn-primary w-full py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
            >
              {resetting ? t('common.loading') : t('bind.generateToken')}
            </button>
          ) : (
            <div className="flex gap-3">
              <button
                onClick={copyToken}
                disabled={!apiToken}
                className="btn-primary flex-1 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
              >
                {copied ? t('common.copied') : t('common.copy')}
              </button>
              <button onClick={() => setResetConfirmOpen(true)} className="btn-ghost flex-1 py-2 text-sm">
                {t('bind.resetToken')}
              </button>
            </div>
          )}
        </div>

        <div className="glass p-5">
          <h3 className="mb-4 font-display text-lg font-semibold text-neutral-100">
            {t('bind.steps.title')}
          </h3>
          <ol className="space-y-3">
            {['s1', 's2', 's3', 's4'].map((s, i) => (
              <li key={s} className="flex gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-neon-gradient font-mono text-xs font-bold text-white shadow-prism">
                  {i + 1}
                </span>
                <span className="text-sm text-neutral-300">{t(`bind.steps.${s}`)}</span>
              </li>
            ))}
          </ol>
        </div>

        <div className="glass p-5 lg:col-span-2">
          <h3 className="mb-1 font-display text-lg font-semibold text-neutral-100">
            {t('bind.suffixTitle')}
          </h3>
          <p className="text-xs leading-relaxed text-neutral-500">{t('bind.suffixHint')}</p>
          {bridgeAccounts.length === 0 ? (
            <p className="mt-3 text-xs text-neutral-500">{t('bind.suffixNeedAccount')}</p>
          ) : (
            <p className="mt-3 text-xs text-neutral-500">{t('bind.suffixPerAccountHint')}</p>
          )}
        </div>
      </div>

      {resetConfirmOpen && (
        <ConfirmModal
          title={t('bind.resetToken')}
          message={t('bind.resetConfirm')}
          confirmLabel={t('bind.resetToken')}
          danger
          busy={resetting}
          onConfirm={resetToken}
          onCancel={() => setResetConfirmOpen(false)}
        />
      )}

      {revealToken && (
        <TokenRevealModal token={revealToken} onClose={() => setRevealToken(null)} />
      )}

      {deleteTarget && (
        <ConfirmModal
          title={t('bind.deleteAccount')}
          message={t('bind.deleteConfirm', { login: deleteTarget.login })}
          confirmLabel={t('common.delete')}
          danger
          busy={deleting}
          onConfirm={confirmDelete}
          onCancel={() => { setDeleteTarget(null); setDeleteError('') }}
        />
      )}
      {deleteError && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-xl border border-down/40 bg-down/15 px-5 py-3 text-sm text-down">
          {deleteError}
        </div>
      )}
    </div>
  )
}
