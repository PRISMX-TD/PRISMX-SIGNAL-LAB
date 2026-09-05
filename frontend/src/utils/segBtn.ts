// 分段按钮的类名（周期 / 模式 / 时段这类互斥选项）。此前四个文件各写一份，
// 其中一份多了 disabled 态；统一成这一份，disabled 优先于 active。
// Class string for segmented option buttons. Four files each had their own
// copy, one with a disabled state; this is the union. Disabled wins over active.
export const segBtn = (active: boolean, disabled = false): string =>
  `rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
    disabled
      ? 'cursor-not-allowed border-white/5 bg-white/[0.02] text-neutral-500'
      : active
        ? 'border-prism-500/50 bg-prism-600/20 text-prism-200'
        : 'border-white/10 bg-white/5 text-neutral-400 hover:text-neutral-100'
  }`
