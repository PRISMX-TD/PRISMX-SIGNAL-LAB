// 下单确认弹窗 / Order confirmation modal
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MT5Account, Signal } from '../api/types'

interface Props {
  signal: Signal
  eaOnline: boolean
  accounts: MT5Account[]
  onCancel: () => void
  onConfirm: (volume: number, mt5Login: string | null) => Promise<void>
}

export default function OrderModal({ signal, eaOnline, accounts, onCancel, onConfirm }: Props) {
  const { t } = useTranslation()
  const [volume, setVolume] = useState('0.10')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  // 在线账号优先 / online accounts first
  const onlineAccounts = accounts.filter((a) => a.online)
  const [login, setLogin] = useState<string>(() => onlineAccounts[0]?.login ?? '')

  useEffect(() => {
    if (!login && onlineAccounts[0]) setLogin(onlineAccounts[0].login)
  }, [onlineAccounts, login])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  // 是否可下单：有在线 EA，或选中了一个在线账号 / can place: EA online or an account selected
  const hasAccounts = onlineAccounts.length > 0
  const canSubmit = hasAccounts ? !!login : eaOnline

  const submit = async () => {
    setError('')
    const vol = parseFloat(volume)
    if (!vol || vol <= 0) {
      setError(t('order.volume'))
      return
    }
    setSubmitting(true)
    try {
      await onConfirm(vol, hasAccounts ? login : null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'error')
    } finally {
      setSubmitting(false)
    }
  }

  const isBuy = signal.side === 'BUY'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-ink-950/80 backdrop-blur-sm" onClick={onCancel} />
      <div className="card relative z-10 w-full max-w-md animate-fade-in-up p-6 shadow-prism-lg">
        <h3 className="mb-4 font-display text-xl font-bold text-slate-100">
          {t('order.confirmTitle')}
        </h3>

        <div className="mb-4 space-y-2.5 rounded-xl border border-ink-700 bg-ink-900/50 p-4 text-sm">
          <div className="flex justify-between">
            <span className="text-slate-400">{t('order.symbol')}</span>
            <span className="font-mono font-semibold text-slate-100">{signal.symbol}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-400">{t('order.side')}</span>
            <span className={`tag ${isBuy ? 'bg-up/15 text-up' : 'bg-down/15 text-down'}`}>
              {isBuy ? t('common.buy') : t('common.sell')}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-400">{t('signals.entry')}</span>
            <span className="font-mono text-slate-200">{signal.entry}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-400">{t('signals.stopLoss')}</span>
            <span className="font-mono text-down">{signal.stopLoss}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-400">{t('signals.takeProfit')}</span>
            <span className="font-mono text-up">{signal.takeProfit}</span>
          </div>
        </div>

        <div className="mb-4">
          <label className="label">{t('order.volume')}</label>
          <input
            type="number"
            step="0.01"
            min="0.01"
            className="input font-mono"
            value={volume}
            onChange={(e) => setVolume(e.target.value)}
          />
        </div>

        {hasAccounts && (
          <div className="mb-4">
            <label className="label">{t('order.account')}</label>
            <select
              className="input font-mono"
              value={login}
              onChange={(e) => setLogin(e.target.value)}
            >
              {onlineAccounts.map((a) => (
                <option key={a.login} value={a.login}>
                  {a.login}
                  {a.accountName ? ` · ${a.accountName}` : ''}
                  {a.company ? ` · ${a.company}` : ''}
                </option>
              ))}
            </select>
          </div>
        )}

        <p className="mb-4 rounded-lg border border-prism-600/30 bg-prism-600/10 px-3 py-2 text-xs leading-relaxed text-prism-300">
          {t('order.riskNote')}
        </p>

        {!canSubmit && (
          <div className="mb-4 rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-sm text-down">
            {t('order.eaOffline')}
          </div>
        )}

        {error && (
          <div className="mb-4 rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-sm text-down">
            {error}
          </div>
        )}

        <div className="flex gap-3">
          <button onClick={onCancel} className="btn-ghost flex-1 py-2.5">
            {t('common.cancel')}
          </button>
          <button
            onClick={submit}
            disabled={submitting || !canSubmit}
            className="btn-primary flex-1 py-2.5"
          >
            {submitting ? t('order.submitting') : t('order.submit')}
          </button>
        </div>
      </div>
    </div>
  )
}
