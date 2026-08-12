// 全页 3D 空间的挂载层 / mount layer for the page-wide 3D space
//
// 静态网格（原来那层 bg-prism-grid）保留为**基线**而不是被替换掉：它是 SSR 输出
// 里就有的东西，也是 WebGL 起不来、开了减少动态、或用户开着流量节省时看到的
// 版面。3D 世界起来之后给 <html> 加 .space-on，静态网格自行淡出——顺序是「先有
// 可用的，再有更好的」，任何一步失败都停在上一步，不会留下空白。
//
// The static grid (the old bg-prism-grid layer) is kept as the baseline rather
// than replaced: it is what SSR emits, and what anyone sees when WebGL fails, when
// reduced-motion is set, or when Save-Data is on. Once the world is up it adds
// .space-on to <html> and the static grid fades itself out. Working first, better
// second; a failure at any step simply stops at the previous one.
//
// 真机也加载这一层，这是一个明确的取舍。上一轮我们特意让移动端完全不加载 three
// （实测 0KB），而这一层会把 three 请回来（约 178KB gzip）。之所以判定值得：判定
// 走廊是整页的记忆点，把它做成桌面独占等于让一半以上的访客拿到一个平淡版本；
// 而这一层本身极便宜——没有 CSS3D、没有光照、合并后不到 10 个 draw call、像素比
// 压到 1.5、滚动停止即停表。真正贵的手机机身（PhoneGL）仍然只在桌面加载。
//
// This layer loads on real devices too, which is a deliberate trade. The previous
// pass kept three entirely off mobile (measured at 0KB) and this brings it back at
// roughly 178KB gzipped. Judged worth it: the corridor is the page's one memorable
// moment, and making it desktop-only hands more than half the audience the flat
// version. The layer itself is cheap - no CSS3D, no lighting, under ten draw calls
// after merging, pixel ratio capped at 1.5, and the clock stops when scrolling
// does. The expensive phone body still loads on desktop only.
import { useEffect, useRef, useState } from 'react'
import { createLandingSpace, type Backdrop, type SpaceHandle } from './LandingSpace'

/* 背景变体切换器（临时评审工具）。
   hero 下方那块区域连续被否了两版，根因是我看不见页面：探针能量到「有没有、
   多亮、在哪」，量不到「好不好看」，只能一轮猜一个。四种处理同时建出来、
   在页面上实时翻看，把串行盲猜换成并行比较。
   只在 URL 带 ?bg 时出现，选择存在 localStorage，定稿后整块删除。
   A temporary review tool. The region under the hero was rejected twice because
   probes can verify presence, brightness and position but never whether
   something looks good, forcing one guess per round. Building all four and
   flipping between them live makes it a parallel choice. It only appears with
   ?bg in the URL, remembers the choice in localStorage, and gets deleted once a
   direction is picked. */
const OPTIONS: { id: Backdrop; label: string; hint: string }[] = [
  { id: 'none', label: '无', hint: '纯底色，只剩手机自己的接触阴影' },
  { id: 'sweep', label: '地面扫光', hint: '一团柔光落在地上，随距离衰减' },
  { id: 'horizon', label: '远方地平线', hint: '没有地面，一条横贯画面的大气光带' },
  { id: 'veil', label: '舞台光幕', hint: '光从上方洒下，越往下越暗' },
]

export default function LandingSpaceLayer() {
  const host = useRef<HTMLDivElement>(null)
  const handleRef = useRef<SpaceHandle | null>(null)
  const variantRef = useRef<Backdrop>('sweep')
  const [variant, setVariant] = useState<Backdrop>('sweep')
  const [picker, setPicker] = useState(false)

  /* 初值在 effect 里读而不是在 useState 初始化器里读：初始化器在客户端首次
     渲染时就会执行，SSR 输出与之不一致会触发 hydration 警告。
     Read the stored value in an effect rather than a useState initialiser: the
     initialiser runs during the first client render and would not match the SSR
     output, which trips a hydration warning. */
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has('bg')) setPicker(true)
    const saved = localStorage.getItem('slBg') as Backdrop | null
    if (saved && OPTIONS.some((o) => o.id === saved)) {
      variantRef.current = saved
      setVariant(saved)
    }
  }, [])

  useEffect(() => {
    variantRef.current = variant
    handleRef.current?.setBackdrop(variant)
    try {
      localStorage.setItem('slBg', variant)
    } catch {
      /* 隐私模式下 localStorage 会抛异常，选择不保存但切换照常工作。
         localStorage throws in private mode; the choice is simply not persisted. */
    }
  }, [variant])

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const conn = (navigator as unknown as { connection?: { saveData?: boolean } }).connection
    if (conn?.saveData) return

    let disposed = false
    let handle: SpaceHandle | null = null

    ;(async () => {
      // 兄弟分区在本 effect 运行前必然已经提交进 DOM（React 先完成整棵树的
      // commit 再跑任何 effect），所以按 id 取到它们是安全的——比把 ref 从
      // 页面组件层层传下来干净得多。
      // Sibling sections are guaranteed to be in the DOM by the time this effect
      // runs (React commits the whole tree before running any effect), so looking
      // them up by id is safe and far cleaner than threading refs down from the
      // page component.
      const story = document.getElementById('showcase')
      const market = document.getElementById('verdict')
      if (!host.current || !story || !market) return
      try {
        handle = await createLandingSpace({ container: host.current, storyEl: story, marketEl: market })
      } catch {
        handle = null
      }
      if (disposed) {
        handle?.dispose()
        handle = null
        return
      }
      if (handle) {
        handleRef.current = handle
        /* 探针只在这里装：这一刻才确定「这个实例是被采纳的那个」。
           The probe is installed only here, the moment this instance is known to
           be the adopted one. */
        if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__space = handle.debug
        handle.setBackdrop(variantRef.current)
        document.documentElement.classList.add('space-on')
      }
    })()

    return () => {
      disposed = true
      handleRef.current = null
      if (import.meta.env.DEV) {
        const w = window as unknown as Record<string, unknown>
        if (handle && w.__space === handle.debug) delete w.__space
      }
      handle?.dispose()
      document.documentElement.classList.remove('space-on')
    }
  }, [])

  const layer = (
    <div className="landing-space" aria-hidden>
      {/* 基线层：无 JS / 无 WebGL / 减少动态时的版面。与 3D 版同样不用格子，
          只留一道柔光地平——降级不该换一种视觉语言。
          The baseline layout for no JS, no WebGL or reduced motion. Like the 3D
          version it carries no grid, just a soft horizon wash: degrading should
          not switch visual languages. */}
      <div className="landing-space-grid" />
      <div ref={host} className="landing-space-gl" />
      {/* 上下渐隐：导航与页脚下方的线条必须让位，否则文字压在网格上。
          Top and bottom fades so lines yield under the nav and the footer rather
          than sitting behind type. */}
      <div className="landing-space-fade t" />
      <div className="landing-space-fade b" />
    </div>
  )

  return (
    <>
      {layer}
      {picker && (
        <div className="bg-picker">
          <p className="bg-picker-h">背景变体 · 临时评审工具</p>
          {OPTIONS.map((o) => (
            <button
              key={o.id}
              type="button"
              onClick={() => setVariant(o.id)}
              className={variant === o.id ? 'on' : ''}
            >
              <b>{o.label}</b>
              <span>{o.hint}</span>
            </button>
          ))}
        </div>
      )}
    </>
  )
}
