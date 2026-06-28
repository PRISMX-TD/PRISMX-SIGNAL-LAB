// EA 在线状态徽标 / EA online status badge
import { useTranslation } from 'react-i18next'
import { useLive } from '../store/live'

export default function EAStatusBadge() {
  const { t } = useTranslation()
  const { anyOnline, onlineAccounts } = useLive()
  const online = anyOnline

  return (
    <div
      className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm ${
        online ? 'border-up/40 bg-up/10 text-up' : 'border-ink-700 bg-ink-900/60 text-slate-400'
      }`}
    >
      <span className={`h-2 w-2 rounded-full ${online ? 'bg-up animate-breathe' : 'bg-slate-500'}`} />
      <span>{online ? t('eaStatus.online') : t('eaStatus.offline')}</span>
      {online && onlineAccounts.length === 1 && (
        <span className="font-mono text-xs text-slate-400">
          {t('eaStatus.account')} {onlineAccounts[0].login}
        </span>
      )}
      {online && onlineAccounts.length > 1 && (
        <span className="font-mono text-xs text-slate-400">×{onlineAccounts.length}</span>
      )}
    </div>
  )
}
