// MT5 连接状态徽标（桥接上报）/ MT5 connection status badge (reported by bridge)
import { useTranslation } from 'react-i18next'
import { useLive } from '../store/live'

export default function EAStatusBadge() {
  const { t } = useTranslation()
  const { anyOnline, onlineAccounts } = useLive()
  const online = anyOnline

  return (
    <div
      className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm backdrop-blur-md ${
        online ? 'border-up/40 bg-up/10 text-up shadow-[0_0_18px_rgba(47,230,160,0.25)]' : 'border-white/10 bg-white/[0.04] text-slate-400'
      }`}
    >
      <span className={`h-2 w-2 rounded-full ${online ? 'bg-up animate-breathe shadow-[0_0_8px_rgba(47,230,160,0.8)]' : 'bg-slate-500'}`} />
      <span>{online ? t('connStatus.online') : t('connStatus.offline')}</span>
      {online && onlineAccounts.length === 1 && (
        <span className="font-mono text-xs text-slate-400">
          {t('connStatus.account')} {onlineAccounts[0].login}
        </span>
      )}
      {online && onlineAccounts.length > 1 && (
        <span className="font-mono text-xs text-slate-400">×{onlineAccounts.length}</span>
      )}
    </div>
  )
}
