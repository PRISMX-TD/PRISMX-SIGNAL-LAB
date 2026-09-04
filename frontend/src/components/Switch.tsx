// 全站唯一的开关控件 / the one toggle switch used site-wide.
//
// 之前五处开关各自手写同一段 Tailwind（peer 复选框 + 轨道 + 滑块），滑块用
// top-0.5 / left-0.5 当 2px 用——而 tailwind.config 为了 4px 网格把 0.5 档
// 重定义成了 4px，于是 20px 的滑块在 24px 的轨道里被推到贴底贴右（上 4 下 0、
// 左 4 右 0），开态右缘和闭态下缘都"溢"出去。五处一起中招，改一处漏四处，
// 所以收成一个组件，几何全部用 px 写死在 .switch 里，不再依赖间距档。
//
// The five hand-rolled toggles shared one Tailwind snippet whose knob used
// top-0.5 / left-0.5 as "2px" — but tailwind.config snaps the 0.5 step to 4px
// for the 4px grid, so the 20px knob sat flush against the bottom/right of the
// 24px track (4/0 vertically, 4/0 horizontally when on). One component, all
// geometry in px inside .switch, independent of the spacing scale.
//
// 点击目标是铺满轨道的透明 <input> 本身，不靠外层 <label>，所以既能单独用，
// 也能放在别的 <label> 里（管理页的开关就是这样）。
// The hit target is the transparent <input> stretched over the track, not a
// wrapping <label>, so it works standalone and nested inside another <label>
// (the admin panel does that).
import type { InputHTMLAttributes } from 'react'

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange' | 'className' | 'checked'> & {
  checked: boolean
  onChange: (checked: boolean) => void
  /** 请求进行中：滑块里转圈并暂时禁用 / in flight: spinner in the knob, temporarily disabled */
  busy?: boolean
  className?: string
}

export default function Switch({ checked, onChange, busy = false, disabled, className = '', ...rest }: Props) {
  return (
    <span className={`switch ${className}`.trim()} data-busy={busy || undefined}>
      <input
        type="checkbox"
        role="switch"
        aria-checked={checked}
        checked={checked}
        disabled={disabled || busy}
        onChange={(e) => onChange(e.target.checked)}
        {...rest}
      />
      <span className="switch-track" aria-hidden />
      <span className="switch-knob" aria-hidden>
        {busy && <span className="h-3 w-3 animate-spin rounded-full border-2 border-prism-500/40 border-t-prism-600" />}
      </span>
    </span>
  )
}
