// MT5 连接状态徽标（桥接上报）/ MT5 connection status badge (reported by bridge)
import { useTranslation } from 'react-i18next'
import { useLive } from '../store/live'

export default function EAStatusBadge() {
  const { t } = useTranslation()
  const { anyOnline, onlineAccounts } = useLive()
  const online = anyOnline

  // 这个徽标是**静态**元素，坐在一个本身已经带背景模糊的 header 里面。给它再叠一层
  // backdrop-blur 不产生任何视觉差异——它下面唯一的东西就是那个已经被模糊过的 header
  // 背景——但每次滚动都要多合成一层。属于玻璃拟态时期「凡是卡片都加模糊」的遗留。
  // This badge is a *static* element sitting inside a header that already has its own
  // backdrop blur. Stacking another backdrop-blur on it produces no visual difference —
  // the only thing beneath it is the already-blurred header background — while adding a
  // compositing layer on every scroll. A leftover of the glassmorphism era's "every card
  // gets a blur" habit; removed.
  return (
    <div
      className={`flex items-center gap-1.5 whitespace-nowrap rounded-inner border px-2 py-1.5 text-sm sm:px-3 ${
        online ? 'border-up/40 bg-up/10 text-up' : 'border-white/10 text-neutral-400'
      }`}
    >
      <span className={`h-2 w-2 shrink-0 rounded-full ${online ? 'bg-up animate-breathe' : 'bg-neutral-500'}`} />
      {/* 窄桌面（sm~lg 之间）英文下 "Connected"/"Disconnected" 加上 5 项导航
          很容易把头部挤出屏幕，这个区间只留状态点；宽屏（lg+）才展示文字。
          On narrower desktop widths (sm–lg), "Connected"/"Disconnected" in
          English plus the 5 nav items is enough to overflow the header — only
          the dot shows there; full text only appears from lg up. */}
      <span className="hidden lg:inline">{online ? t('connStatus.online') : t('connStatus.offline')}</span>
      {online && onlineAccounts.length === 1 && (
        <span className="hidden font-mono text-xs text-neutral-400 lg:inline">
          {onlineAccounts[0].login}
        </span>
      )}
      {online && onlineAccounts.length > 1 && (
        <span className="font-mono text-xs text-neutral-400">×{onlineAccounts.length}</span>
      )}
    </div>
  )
}
