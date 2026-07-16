// MT5 连接状态徽标（桥接上报）/ MT5 connection status badge (reported by bridge)
import { useTranslation } from 'react-i18next'
import { useLive } from '../store/live'

export default function EAStatusBadge() {
  const { t } = useTranslation()
  const { anyOnline, onlineAccounts } = useLive()
  const online = anyOnline

  return (
    <div
      className={`flex items-center gap-1.5 whitespace-nowrap rounded-lg border px-2 py-1.5 text-sm backdrop-blur-md sm:px-3 ${
        online ? 'border-up/40 bg-up/10 text-up shadow-[0_0_18px_rgba(47,230,160,0.25)]' : 'border-white/10 bg-white/[0.04] text-slate-400'
      }`}
    >
      <span className={`h-2 w-2 shrink-0 rounded-full ${online ? 'bg-up animate-breathe shadow-[0_0_8px_rgba(47,230,160,0.8)]' : 'bg-slate-500'}`} />
      {/* 窄桌面（sm~lg 之间）英文下 "Connected"/"Disconnected" 加上 5 项导航
          很容易把头部挤出屏幕，这个区间只留状态点；宽屏（lg+）才展示文字。
          On narrower desktop widths (sm–lg), "Connected"/"Disconnected" in
          English plus the 5 nav items is enough to overflow the header — only
          the dot shows there; full text only appears from lg up. */}
      <span className="hidden lg:inline">{online ? t('connStatus.online') : t('connStatus.offline')}</span>
      {online && onlineAccounts.length === 1 && (
        <span className="hidden font-mono text-xs text-slate-400 lg:inline">
          {onlineAccounts[0].login}
        </span>
      )}
      {online && onlineAccounts.length > 1 && (
        <span className="font-mono text-xs text-slate-400">×{onlineAccounts.length}</span>
      )}
    </div>
  )
}
