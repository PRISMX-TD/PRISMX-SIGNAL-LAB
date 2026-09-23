// 全站唯一的浮层提示 / the one toast used site-wide.
//
// 六个页面（图表、信号、仪表盘、订单、策略、桥接）各自抄了同一串 Tailwind：
// `fixed above-tabbar left-1/2 -translate-x-1/2 … bg-down/15 text-down`。那串东西有
// 两个毛病，六处一起中招：
//
//   ① **半透明**。底色是色相的 15%，文字又是同一色相——盖在深色卡片上勉强能读，盖在
//      行情图上就是紫字压着蜡烛，一个字都认不出来。提示是说给人看的，不该跟背景抢。
//   ② **贴在底部**。手机上它落在底栏上方，而底部抽屉（持仓 / 下单票）一开就把它压住；
//      用户下完单最想看的那句回执，恰好在他最看不见的地方。
//
// 现在：屏幕正中、实色面、白字、图标带色。位置选正中而不是顶部或底部，是因为这条
// 提示的内容（"已提交 1 笔平仓指令""挂单已挂出"）是用户刚按下那个动作的唯一回音，
// 错过它就得自己去订单页翻。
//
// **`pointer-events: none`**——这是正中方案成立的前提：它只挡视线不挡手，盖住的那几秒
// 里图表照样能拖能点。没有这一条，把一块 3 秒的板子放在屏幕正中就是在打断人。
//
// One toast for six pages that each copied the same Tailwind string. That string was
// translucent (a 15% tint of the tone with same-hue text — illegible over a chart) and
// pinned to the bottom, where the mobile sheets cover it: the receipt a user most wants
// after placing an order sat exactly where they could not see it.
//
// Now: dead centre, opaque, white text, coloured icon. Centre rather than an edge
// because this line is the only echo of the action just taken. `pointer-events: none`
// is what makes centre acceptable — it blocks the view, never the hands, so the chart
// stays draggable underneath for the few seconds it shows.
import { createPortal } from 'react-dom'

export type ToastKind = 'success' | 'error' | 'info'

const ICONS: Record<ToastKind, JSX.Element> = {
  // 对勾 / 感叹 / 信息。图标承担"这是好消息还是坏消息"，文字因此可以保持白色高对比，
  // 不必为了表达语义去染色——染色正是旧版读不清的原因。
  // The icon carries the tone so the text can stay high-contrast white instead of being
  // tinted for meaning, which is exactly what made the old one unreadable.
  success: <path d="M20 6L9 17l-5-5" />,
  error: <><path d="M12 8v5" /><path d="M12 17h.01" /><circle cx="12" cy="12" r="9" /></>,
  info: <><path d="M12 11v6" /><path d="M12 7h.01" /><circle cx="12" cy="12" r="9" /></>,
}

export default function Toast({ kind, message }: { kind: ToastKind; message: string }) {
  // portal 到 body：六个调用点里有一半渲染在自己页面的某个 relative/overflow 容器中，
  // 留在原地的话 fixed 会被祖先的 transform / filter 挟持成相对定位（图表页的抽屉就
  // 带 transform），提示会跑到容器里而不是屏幕正中。
  // Portalled to body: half the call sites render inside a positioned or transformed
  // ancestor, which would re-root `fixed` to that ancestor and land the toast inside a
  // panel instead of the screen's centre.
  return createPortal(
    <div className={`toast ${kind}`} role="status" aria-live="polite">
      <svg className="toast-ic" width="18" height="18" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
           aria-hidden="true">
        {ICONS[kind]}
      </svg>
      <span>{message}</span>
    </div>,
    document.body,
  )
}
