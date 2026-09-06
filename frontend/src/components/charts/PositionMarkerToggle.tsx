// 2026-09-06 从 pages/ChartsPage.tsx 搬出，内容逐行原样 / moved out of ChartsPage verbatim.

// 持仓标记显隐开关：桌面/手机/全屏三处工具栏共用一个按钮，图标用"标了价位的
// 水平线"，比眼睛图标更能说明它管的是哪一类东西（眼睛已被画线显隐占用）。
// Position-marker visibility toggle, shared by the desktop / mobile /
// fullscreen toolbars. The icon is a price-tagged horizontal line rather than
// an eye — the eye already means "show/hide drawings" here.
export default function PositionMarkerToggle({
  on,
  onToggle,
  t,
  compact = false,
}: {
  on: boolean
  onToggle: () => void
  t: (key: string) => unknown
  compact?: boolean
}) {
  const label = String(t(on ? 'charts.posmark.hide' : 'charts.posmark.show'))
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={on}
      onClick={onToggle}
      className={compact
        ? `flex h-6 w-6 items-center justify-center rounded-md border transition ${on ? 'border-prism-500/60 bg-prism-600/25 text-prism-200' : 'border-white/10 bg-ink-800/60 text-neutral-400 hover:text-neutral-100'}`
        : `term-tool-btn ${on ? 'on' : ''}`}
    >
      <svg width={compact ? 11 : 13} height={compact ? 11 : 13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="2" y1="7" x2="22" y2="7" strokeDasharray="4 3" />
        <line x1="2" y1="17" x2="22" y2="17" strokeDasharray="4 3" />
        <rect x="8" y="10.5" width="8" height="3" />
      </svg>
    </button>
  )
}
