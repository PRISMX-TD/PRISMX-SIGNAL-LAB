// 桥接连接子页：需要本地 PRISMX Bridge 的部分（API Token、已连接账户、品种后缀、接入步骤）。
// Bridge sub-page: everything that requires the local PRISMX Bridge (API token,
// connected accounts, symbol suffix, setup steps).
import { useEffect, useState } from 'react'
import PageHead from '../components/PageHead'

import { useTranslation } from 'react-i18next'
import { accountApi, eaApi } from '../api/client'
import { useLive } from '../store/live'
import { localizeApiError } from '../api/utils'
import ConfirmModal from '../components/ConfirmModal'
import TokenRevealModal from '../components/TokenRevealModal'
import { useBackToClose } from '../utils/useBackToClose'
import type { MT5Account } from '../api/types'
import Toast from '../components/Toast'
import { EmailVerifyInline } from '../components/EmailVerifyNotice'
import { useAuth } from '../store/auth'
import { copyToClipboard } from '../components/Copyable'

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
  // 生成 Token 要求邮箱已验证（后端 /ea/token/reset 会 403）/ token needs a verified email
  const { user } = useAuth()
  const emailUnverified = user?.emailVerified === false

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
    if (!(await copyToClipboard(apiToken))) return
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

  // 手机卡片与桌面表格共用的三块 / pieces shared by the phone cards and the desktop table
  const statusTag = (a: MT5Account) => (
    <span className={`tag ${a.online ? 'bg-up/15 text-up' : 'bg-white/5 text-neutral-500'}`}>
      {a.online ? t('common.online') : t('common.offline')}
    </span>
  )
  const suffixEditor = (a: MT5Account) => (
    <div className="flex items-center gap-1.5">
      <input
        className="input h-7 w-20 font-mono text-xs"
        placeholder={t('bind.suffixPlaceholder')}
        value={suffixDrafts[a.login] ?? ''}
        onChange={(e) => setSuffixDrafts((prev) => ({ ...prev, [a.login]: e.target.value }))}
      />
      <button
        onClick={() => saveSuffix(a.login)}
        disabled={savingLogin === a.login}
        className="btn-ghost px-2 py-1 text-xs disabled:opacity-50"
      >
        {savedLogin === a.login ? t('bind.saved') : t('common.save')}
      </button>
    </div>
  )
  // 删除：灰色文字按钮，悬停才变红；以前是每行一个红色实心块。点了走确认框。
  // Delete: a grey text button that turns red on hover (it was a red block on every row); confirms first.
  const deleteButton = (a: MT5Account) => (
    <button
      onClick={() => setDeleteTarget(a)}
      disabled={a.online}
      title={a.online ? t('bind.deleteNeedOffline') : t('bind.deleteAccount')}
      className="px-1 py-1 text-xs text-neutral-500 transition hover:text-down disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-neutral-500"
    >
      {t('common.delete')}
    </button>
  )

  return (
    <div>
      <PageHead
        as="h1"
        back={{ to: '/bind', label: t('bind.backToBind') }}
        title={t('bind.bridgeTitle')}
        subtitle={t('bind.subtitle')}
      />

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
            {/* 2026-11-15 起手机上每个账户一张卡：以前 7 列表格在手机上只露出前 3 列，余额、
                状态、删除要横滑才看得到，也没有任何提示。删除是灰色文字按钮，点了仍走下面的
                确认框。桌面保留表格。
                Since 2026-11-15 each account is a card on phones: the 7-column table showed
                only its first 3 columns there, with balance, status and delete behind an
                unhinted sideways scroll. Delete is a grey text button that still goes through
                the confirm dialog below. Desktop keeps the table. */}
            <ul className="flex flex-col gap-2 sm:hidden">
              {bridgeAccounts.map((a) => (
                <li key={a.login} className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-3.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-mono text-sm text-neutral-100">{a.login}</div>
                      <div className="mt-0.5 truncate text-xs text-neutral-500">
                        {[a.accountName, a.company].filter(Boolean).join(' · ') || '—'}
                      </div>
                    </div>
                    {statusTag(a)}
                  </div>
                  <dl className="mt-3 grid grid-cols-2 gap-3 text-xs">
                    <div>
                      <dt className="text-neutral-500">{t('bind.balance')}</dt>
                      <dd className="mt-0.5 font-mono text-sm text-neutral-200">{a.balance != null ? a.balance.toFixed(2) : '—'}</dd>
                    </div>
                    <div>
                      <dt className="text-neutral-500">{t('bind.equity')}</dt>
                      <dd className="mt-0.5 font-mono text-sm text-neutral-200">{a.equity != null ? a.equity.toFixed(2) : '—'}</dd>
                    </div>
                  </dl>
                  <div className="mt-3 flex items-center gap-2 border-t border-white/[0.06] pt-3">
                    <span className="text-xs text-neutral-500">{t('bind.suffixLabel')}</span>
                    {suffixEditor(a)}
                    <span className="ml-auto">{deleteButton(a)}</span>
                  </div>
                </li>
              ))}
            </ul>
            <div className="hidden overflow-x-auto sm:block">
              <table className="w-full whitespace-nowrap text-sm">
                <thead>
                  <tr className="text-left text-xs text-neutral-500">
                    <th className="px-3 py-2">{t('orders.acct.login')}</th>
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
                      <td className="px-3 py-2 text-center">{statusTag(a)}</td>
                      <td className="px-3 py-2">{suffixEditor(a)}</td>
                      <td className="px-3 py-2 text-center">{deleteButton(a)}</td>
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
          {emailUnverified ? (
            <EmailVerifyInline reason="bind" />
          ) : !apiToken && neverConnected ? (
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
        <Toast kind="error" message={deleteError} />
      )}
    </div>
  )
}
