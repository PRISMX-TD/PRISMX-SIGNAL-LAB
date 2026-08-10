// 下单弹窗里的「没连上 MT5」提示，两个下单弹窗（SlideOrderModal /
// ChartOrderModal）共用。
//
// 原来这里只有一行纯文字：「尚未连接 MT5。请打开 PRISMX 桥接程序，填入 Token
// 并启动后再下单。」——文案本身写得清楚，问题是它不可点。一个还没装桥接的新
// 用户读完这句，仍然得自己去猜「桥接程序」在哪下、「Token」在哪拿。
//
// ── 为什么用普通 <a>（整页跳转）而不是 <Link> / navigate() ──
//
// 这两个弹窗打开时会往 history 里压**两条**记录，不是一条：
//   ① 页面级的 useBackToClose 压一条 { __modalBack, __modalId }
//   ② 弹窗组件自己的 effect 再压一条 { __orderModal } / { __chartOrderModal }
// 卸载时两者的 cleanup 各自 history.back() 一次。这套设计是为了让手机的返回
// 手势「划一次退一层」，本身没问题，但它意味着：从弹窗内部发起一次路由 push，
// 会被随后的两次 back() 直接弹回。
//
// 实测过三种写法，前两种都失败：
//   · 先调 onClose() 再 setTimeout(navigate) —— 弹窗关了，页面没动
//   · 直接 navigate() —— 同样没动，trace 里能看到 push 之后紧跟一次 popstate
// 与其在弹窗的历史簿记里凿一个特例（那会让「划一次退一层」变得难以推理，而那
// 套逻辑本身就是踩坑记录 #23 里花了很大力气才理顺的），不如整页跳转：它完全
// 绕开 history 簿记，行为确定。
//
// 代价是一次整页加载。可以接受——这条路径只有「从没连过桥接的新用户」会走，
// 一个账号一辈子点一次。用 <a> 而不是 location.assign()，顺带拿到中键新标签页
// 打开、右键复制链接、键盘可聚焦这些原生行为。
//
// The "MT5 not connected" notice inside the order modals, shared by
// SlideOrderModal and ChartOrderModal.
//
// This used to be a single line of plain text. The wording was clear; the problem
// was that it wasn't clickable, so a new user without the bridge still had to
// guess where "the bridge app" is downloaded and where the token lives.
//
// Why a plain <a> (full page load) rather than <Link> / navigate():
//
// Opening either modal pushes TWO history entries, not one: the page-level
// useBackToClose pushes { __modalBack, __modalId }, and the modal's own effect
// pushes { __orderModal } / { __chartOrderModal }. Both cleanups call
// history.back() on unmount. That design gives mobile "one swipe, one layer" and
// is fine in itself — but it means a router push issued from inside the modal is
// immediately popped by the two back() calls that follow.
//
// Three approaches were tried; the first two failed: calling onClose() then
// setTimeout(navigate) closed the modal without moving the page, and a direct
// navigate() did the same, with a popstate visible right after the push in a
// trace. Rather than carve a special case into the modals' history bookkeeping —
// which would make "one swipe, one layer" hard to reason about, and that logic
// took real effort to get right (deployment-log pitfall #23) — this does a full
// navigation, which sidesteps the bookkeeping entirely and behaves predictably.
//
// The cost is one page load. Acceptable: only a user who has never connected the
// bridge takes this path, once per account, ever. An <a> rather than
// location.assign() also gets middle-click-to-new-tab, copy-link and keyboard
// focus for free.
import { useTranslation } from 'react-i18next'

export default function OrderConnectNotice({
  // 一个账号都没绑（从没连过桥接） vs 绑了但全都离线——两种情况该做的事不同，
  // 引导去的页面也不同。
  // Never bound an account (never ran the bridge) vs bound but all offline —
  // different problems, different destinations.
  neverConnected,
}: {
  neverConnected: boolean
}) {
  const { t } = useTranslation()

  // 两种情况都指向 /bind。以前「从没连过」会被送去 /download（下载桥接），
  // 但直连才是默认路径：连接页上就能填账号密码，还带着开户入口；真需要桥接
  // 的人在那页的折叠区里能找到。
  // Both cases point at /bind. "Never connected" used to go to /download (get
  // the bridge app), but direct connect is the default path now: the connect
  // page takes a login and password inline and carries the signup entry, while
  // anyone who genuinely needs the bridge finds it in that page's collapsed
  // section.
  const to = '/bind'
  const cta = t('nav.bind')

  return (
    <div className="mb-3 rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-sm text-down">
      <p className="leading-relaxed">{neverConnected ? t('order.noBridge') : t('order.allOffline')}</p>
      <a
        href={to}
        className="mt-1.5 inline-block rounded-md bg-down/20 px-2.5 py-1 text-xs font-semibold transition hover:bg-down/30"
      >
        {cta} →
      </a>
    </div>
  )
}
