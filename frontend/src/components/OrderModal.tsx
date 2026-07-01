// 下单确认弹窗 / Order confirmation modal
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MT5Account, Quote, Signal } from '../api/types'

interface Props {
  signal: Signal
  eaOnline: boolean
  accounts: MT5Account[]
  quote?: Quote
  onCancel: () => void
  onConfirm: (
    volume: number,
    mt5Login: string | null,
    stopLoss: number | null,
    takeProfit: number | null,
  ) => Promise<void>
}

// 快捷手数预设 / quick-lot presets
const QUICK_LOTS = [0.01, 0.1, 0.5, 1.0]

export default function OrderModal({ signal, eaOnline, accounts, quote, onCancel, onConfirm }: Props) {
  const { t } = useTranslation()
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  // 在线账号优先 / online accounts first
  const onlineAccounts = accounts.filter((a) => a.online)
  const [login, setLogin] = useState<string>(() => onlineAccounts[0]?.login ?? '')

  // 当前选中账号 / currently selected account
  const selected = onlineAccounts.find((a) => a.login === login) || null

  // 按净值粗估的默认手数：净值/EQUITY_PER_LOT(后端默认 200)，限制在 0.01~账户上限之间。
  // Smart default volume from equity (equity / ~200 per lot), clamped to a sane range.
  const suggestVolume = (eq?: number | null): string => {
    if (!eq || eq <= 0) return '0.10'
    const byEquity = eq / 200
    const v = Math.max(0.01, Math.min(byEquity, 1))
    return (Math.floor(v * 100) / 100).toFixed(2)
  }
  const [volume, setVolume] = useState(() => suggestVolume(onlineAccounts[0]?.equity))

  // 自定义止损止盈，默认取信号值（可编辑）/ custom SL·TP, default to signal values (editable)
  const [sl, setSl] = useState(signal.stopLoss != null ? String(signal.stopLoss) : '')
  const [tp, setTp] = useState(signal.takeProfit != null ? String(signal.takeProfit) : '')

  useEffect(() => {
    if (!login && onlineAccounts[0]) setLogin(onlineAccounts[0].login)
  }, [onlineAccounts, login])

  // 切换账号时按其净值刷新建议手数 / refresh suggested volume when account changes
  useEffect(() => {
    setVolume(suggestVolume(selected?.equity))
  }, [selected?.login])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  // PWA / 手机回退手势：关闭弹窗而非操作背景页面
  // PWA / mobile back gesture: close modal instead of navigating background
  useEffect(() => {
    window.history.pushState({ __modal: true }, '', window.location.href)

    const onPop = () => {
      window.history.pushState({ __modal: true }, '', window.location.href)
      onCancel()
    }
    window.addEventListener('popstate', onPop)
    return () => {
      window.removeEventListener('popstate', onPop)
      // 清理：回退掉这条历史，避免残留
      window.history.back()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 是否可下单：有在线 EA，或选中了一个在线账号 / can place: EA online or an account selected
  const hasAccounts = onlineAccounts.length > 0
  const canSubmit = hasAccounts ? !!login : eaOnline

  // 离线提示分情况：从未连接 / 连过但都掉线 / no-connection messaging by case
  const offlineMsg = accounts.length === 0 ? t('order.noBridge') : t('order.allOffline')

  const fmtMoney = (n?: number | null) =>
    n == null ? '-' : n.toLocaleString(undefined, { maximumFractionDigits: 2 })

  const submit = async () => {
    setError('')
    const vol = parseFloat(volume)
    if (!vol || vol <= 0) {
      setError(t('order.volume'))
      return
    }
    const slNum = sl.trim() === '' ? null : parseFloat(sl)
    const tpNum = tp.trim() === '' ? null : parseFloat(tp)
    setSubmitting(true)
    try {
      await onConfirm(vol, hasAccounts ? login : null, slNum, tpNum)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'error')
    } finally {
      setSubmitting(false)
    }
  }

  // 粗估保证金占用：手数 × 合约规模(假定 100k) / 杠杆。仅作量级提示，非精确值。
  // Rough margin estimate: lots × contract size (assume 100k) / leverage.
  // Indicative magnitude only, not an exact figure.
  const estMargin = (() => {
    const vol = parseFloat(volume)
    const lev = selected?.leverage
    if (!vol || vol <= 0 || !lev || lev <= 0) return null
    return (vol * 100000) / lev
  })()

  const isBuy = signal.side === 'BUY'

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4">
      <div className="absolute inset-0 bg-ink-950/70 backdrop-blur-md" onClick={onCancel} />
      <div className="glass relative z-10 flex max-h-[92vh] w-full max-w-md animate-fade-in-up flex-col overflow-hidden rounded-b-none rounded-t-2xl shadow-glass-lg sm:max-h-[90vh] sm:rounded-2xl">
        {/* 移动端抽屉把手 / mobile drag handle */}
        <div className="flex justify-center pt-3 sm:hidden">
          <span className="h-1 w-10 rounded-full bg-white/20" />
        </div>
        <h3 className="px-5 pb-3 pt-3 font-display text-xl font-bold text-slate-100 sm:px-6 sm:pt-6">
          <span className="neon-text">{t('order.confirmTitle')}</span>
        </h3>

        {/* 可滚动内容区 / scrollable body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 sm:px-6">
        <div className="mb-4 space-y-2.5 rounded-xl border border-white/10 bg-white/[0.03] p-4 text-sm">
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
            <div className="text-right">
              <div className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-prism-400 animate-breathe" />
                <span className="font-mono tabular-nums text-slate-200">
                  {quote
                    ? (isBuy ? (quote.ask?.toFixed(quote.digits ?? undefined) ?? signal.entry) : (quote.bid?.toFixed(quote.digits ?? undefined) ?? signal.entry))
                    : signal.entry}
                </span>
              </div>
            </div>
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
          {/* 快捷手数 / quick lots */}
          <div className="mt-2 flex gap-2">
            {QUICK_LOTS.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => setVolume(q.toFixed(2))}
                className="flex-1 rounded-lg border border-white/10 bg-white/[0.04] py-1 font-mono text-xs text-slate-300 transition hover:border-prism-600/50 hover:text-prism-300"
              >
                {q.toFixed(2)}
              </button>
            ))}
          </div>
        </div>

        {/* 自定义止损止盈 / custom SL·TP */}
        <div className="mb-4 grid grid-cols-2 gap-3">
          <div>
            <label className="label text-down">{t('signals.stopLoss')}</label>
            <input
              type="number"
              step="0.00001"
              className="input font-mono"
              placeholder={t('order.slPlaceholder')}
              value={sl}
              onChange={(e) => setSl(e.target.value)}
            />
          </div>
          <div>
            <label className="label text-up">{t('signals.takeProfit')}</label>
            <input
              type="number"
              step="0.00001"
              className="input font-mono"
              placeholder={t('order.tpPlaceholder')}
              value={tp}
              onChange={(e) => setTp(e.target.value)}
            />
          </div>
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
            {selected && (
              <div className="mt-2 flex justify-between rounded-lg border border-white/5 bg-white/[0.03] px-3 py-2 text-xs">
                <span className="text-slate-400">
                  {t('bind.equity')}
                  <span className="ml-1 font-mono text-slate-200">
                    {fmtMoney(selected.equity)} {selected.accountCurrency ?? ''}
                  </span>
                </span>
                <span className="text-slate-400">
                  {t('bind.balance')}
                  <span className="ml-1 font-mono text-slate-200">
                    {fmtMoney(selected.balance)}
                  </span>
                </span>
              </div>
            )}
          </div>
        )}

        {estMargin != null && (
          <div className="mb-4 flex items-center justify-between rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-xs">
            <span className="text-slate-400">{t('order.estMargin')}</span>
            <span className="font-mono text-slate-200">
              ≈ {estMargin.toLocaleString(undefined, { maximumFractionDigits: 0 })}{' '}
              {selected?.accountCurrency ?? ''}
            </span>
          </div>
        )}

        <p className="mb-4 rounded-lg border border-prism-600/30 bg-prism-600/10 px-3 py-2 text-xs leading-relaxed text-prism-300">
          {t('order.riskNote')}
        </p>

        {!canSubmit && (
          <div className="mb-4 rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-sm text-down">
            {offlineMsg}
          </div>
        )}

        {error && (
          <div className="mb-4 rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-sm text-down">
            {error}
          </div>
        )}
        </div>
        {/* 固定底部操作区 / sticky footer actions */}
        <div className="flex gap-3 border-t border-white/10 px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-6">
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
