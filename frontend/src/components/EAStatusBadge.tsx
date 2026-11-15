// MT5 连接状态徽标（桥接上报）/ MT5 connection status badge (reported by bridge)
import { useTranslation } from 'react-i18next'
import { useLive } from '../store/live'

export default function EAStatusBadge() {
  const { t } = useTranslation()
  const { anyOnline, onlineAccounts } = useLive()
  const online = anyOnline

  // 这个徽标是**静态**元素，坐在顶栏里（顶栏是不透明实色，见 Layout.tsx 的 header 注释）。
  // 给它叠 backdrop-blur 不产生任何视觉差异，却每次滚动都要多合成一层。属于玻璃拟态时期
  // 「凡是卡片都加模糊」的遗留。
  // This badge is a *static* element sitting in the header (an opaque solid fill, see the
  // comment on Layout.tsx's header). A backdrop-blur on it produces no visual difference
  // while adding a compositing layer on every scroll. A leftover of the glassmorphism
  // era's "every card gets a blur" habit; removed.
  return (
    <div
      className={`flex items-center gap-1.5 whitespace-nowrap rounded-lg border px-2 py-1.5 text-sm sm:px-3 ${
        online ? 'border-up/40 bg-up/10 text-up' : 'border-white/10 text-neutral-400'
      }`}
      title={online ? t('connStatus.online') : t('connStatus.offline')}
    >
      {/* 在线实心绿点、离线空心圈：窄屏上只剩这个点，形状不同才不靠红绿区分。
          Solid green when online, hollow ring when offline: on narrow widths the dot is
          all that shows, so the states must differ in shape as well as colour. */}
      <span
        className={`box-border h-2 w-2 shrink-0 rounded-full ${online ? 'bg-up animate-breathe' : 'border-[1.5px] border-neutral-400 bg-transparent'}`}
        aria-hidden="true"
      />
      {/* 窄桌面（sm~lg 之间）英文下 "Connected"/"Disconnected" 加上 5 项导航
          很容易把头部挤出屏幕，这个区间只留状态点；宽屏（lg+）才展示文字。
          lg 以下改成 sr-only 而不是 display:none：读屏照样念得到连接状态。
          On narrower desktop widths (sm–lg), "Connected"/"Disconnected" in
          English plus the 5 nav items is enough to overflow the header — only
          the dot shows there; full text only appears from lg up. Below lg the text
          is sr-only rather than display:none, so screen readers still get it. */}
      <span className="sr-only lg:not-sr-only">{online ? t('connStatus.online') : t('connStatus.offline')}</span>
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
