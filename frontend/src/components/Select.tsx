// 通用自定义下拉：替代原生 <select>，深色主题下拉菜单可控样式。
// 原生 select 弹出的选项列表由浏览器/系统渲染，深色主题下几乎无法覆盖样式
// （已在下单弹窗的账户切换器踩过这个坑，见 SlideOrderModal 的 slide-acct-* 类）。
// Generic custom dropdown replacing native <select> — a native select's popup
// list is rendered by the browser/OS and its styling can't be controlled in a
// dark theme (already hit this in the order modal's account switcher; see
// SlideOrderModal's slide-acct-* classes).
//
// 菜单通过 portal 渲染到 <body> 并用 position: fixed 按触发器的屏幕坐标定位，
// 这样即使触发器身处 overflow: hidden/auto 的祖先容器里（如下单面板 .term-ticket
// 内、无缝网格 .term-panel 里），弹出的选项列表也不会被裁掉。
// The menu is portaled to <body> and positioned with fixed coordinates from the
// trigger's bounding rect, so it isn't clipped by any overflow:hidden/auto
// ancestor (e.g. inside the order ticket / seamless grid panel).
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export interface SelectOption {
  value: string
  label: string
  // 触发器上的简短写法，省略时用 label。
  // 用在「菜单里要说清楚、收起来只需认得出」的场景：手机号区号选择器的菜单是
  // "🇲🇾 马来西亚 +60"，触发器只要 "🇲🇾 +60" —— 全名塞进那个窄框只会变成省略号，
  // 而省略号既占地方又没信息。
  // Short form for the trigger; falls back to label. For cases where the menu
  // should spell things out but the collapsed trigger only needs to be
  // recognisable — a full country name in a narrow trigger just becomes an
  // ellipsis, which costs space and carries no information.
  short?: string
}

export default function Select({
  value,
  options,
  onChange,
  className = '',
  openUpward = false,
}: {
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  className?: string
  // 菜单是否向上弹出（用于紧贴在其他内容上方的触发器，避免向下弹出时盖住下方内容）
  // Open the menu upward (for triggers sitting right above other content, so
  // it doesn't cover what's below when it opens downward instead)
  openUpward?: boolean
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null)
  const current = options.find((o) => o.value === value)

  // 依据触发器的屏幕坐标计算菜单位置（fixed 定位，跟随视口）。
  // Compute the menu position from the trigger's screen rect (fixed to viewport).
  const place = () => {
    const el = triggerRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({
      left: r.left,
      top: openUpward ? r.top : r.bottom,
      width: r.width,
    })
  }

  useLayoutEffect(() => {
    if (open) {
      place()
      return
    }
    // 关闭时清掉坐标，别把上一次的留着。
    //
    // 留着的话，下次打开会先用旧坐标渲染出一帧（`open && pos` 立刻成立），
    // 而下面那个「越界就左移」的修正正好在这一帧里跑，拿着**旧的** left 去算，
    // 把菜单推到一个跟触发器毫无关系的位置。视口尺寸或页面滚动位置在两次打开
    // 之间变过时必然复现——实测在手机宽度下，触发器在 left 41，菜单跑到了 226。
    //
    // 置 null 之后，菜单在 place() 算出新坐标之前根本不渲染，修正也就只可能
    // 看到新值。顺带消掉了「先闪一下旧位置再跳到正确位置」的抖动。
    //
    // Clear the coordinates on close. Keeping them makes the next open render a
    // frame at the stale position, and the right-edge correction below runs in
    // that frame against the *old* left, shoving the menu somewhere unrelated to
    // its trigger. Reproduced by hand: trigger at left 41 on a 375px viewport,
    // menu placed at 226. Nulling it means nothing renders until place() has
    // fresh coordinates — which also removes a flash at the old position.
    setPos(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // 菜单是按触发器左边缘对齐的，撑开之后可能超出视口右侧（触发器越靠右越容易）。
  // 必须等菜单真的渲染出来才知道它多宽，所以放在这里量一次再回推位置。
  // 用 left !== pos.left 收敛：修正一次之后条件不再成立，不会来回抖。
  // The menu is left-aligned to the trigger, so growing it can overflow the right
  // edge. Its width is only knowable after render, hence measuring here. The
  // left !== pos.left guard makes this converge after a single correction.
  useLayoutEffect(() => {
    if (!open || !pos) return
    const el = menuRef.current
    if (!el) return
    const maxRight = window.innerWidth - 8
    if (pos.left + el.offsetWidth > maxRight) {
      const left = Math.max(8, maxRight - el.offsetWidth)
      if (left !== pos.left) setPos((p) => (p ? { ...p, left } : p))
    }
  }, [open, pos])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    // 视口滚动/尺寸变化时重新定位（capture 捕获所有祖先滚动容器的滚动）。
    // Reposition on scroll/resize (capture catches scrolling in any ancestor).
    const onReflow = () => place()
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', onReflow)
    window.addEventListener('scroll', onReflow, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onReflow)
      window.removeEventListener('scroll', onReflow, true)
    }
  }, [open])

  return (
    <div ref={rootRef} className={`select-picker ${className}`}>
      <button ref={triggerRef} type="button" className="select-trigger" onClick={() => setOpen((v) => !v)} title={current?.label ?? value}>
        <span>{current?.short ?? current?.label ?? value}</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ transform: open ? 'rotate(180deg)' : undefined }}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && pos && createPortal(
        <>
          <div className="select-backdrop" onClick={() => setOpen(false)} />
          <div
            className={`select-menu ${openUpward ? 'up' : ''}`}
            ref={menuRef}
            style={{
              left: pos.left,
              // 至少与触发器同宽，内容更宽时自己撑开。原本写死 width: pos.width，
              // 于是选项被触发器的宽度裁掉——手机号区号选择器把触发器收窄到只放
              // 「国旗 + 区号」之后，菜单里的国名整片被截成「马来西亚 +6…」。
              // 对现有调用方无影响：选项本来就放得下的菜单，宽度不变。
              // At least as wide as the trigger, growing to fit content. This used
              // to be a hard `width`, so options were clipped to the trigger's
              // width. Existing callers whose options already fit are unaffected.
              minWidth: pos.width,
              width: 'max-content',
              // 上限留 16px 余量，避免超长选项把菜单撑到贴死视口边缘
              // Cap with a 16px gutter so a long option can't reach the edge
              maxWidth: Math.max(pos.width, window.innerWidth - 16),
              ...(openUpward
                ? { bottom: window.innerHeight - pos.top + 4 }
                : { top: pos.top + 4 }),
            }}
          >
            {options.map((o) => (
              <button
                type="button"
                key={o.value}
                className={`select-opt ${o.value === value ? 'active' : ''}`}
                onClick={() => { onChange(o.value); setOpen(false) }}
              >
                {o.label}
              </button>
            ))}
          </div>
        </>,
        document.body,
      )}
    </div>
  )
}
