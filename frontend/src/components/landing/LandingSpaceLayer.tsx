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
import { createLandingSpace, type SpaceHandle } from './LandingSpace'
import type { SolidVariant } from './BackdropSolids'

/* 背景变体切换器（临时评审工具）。
   前一版这里放的四个选项全是**光的分布**（网格/扫光/地平线/光幕），换的只是
   亮度落在哪里——四个一起被否，因为要的从来不是「空得好看一点」，是那里应该
   有**东西**。现在换成四个真正的元素（见 BackdropArt.tsx），WebGL 照明一律
   关掉：既然不要光，就别在元素底下再垫一层光。
   只在 URL 带 ?bg 时出现，选择存 localStorage，定稿后整块删除。
   A temporary review tool. Its previous four options were all distributions of
   light (grid, sweep, horizon, wash) differing only in where the brightness fell,
   and all four were rejected together - what was wanted was never a prettier
   emptiness but something actually being there. They are replaced by four real
   motifs (see BackdropArt.tsx) with the WebGL lighting switched off throughout:
   if light is not wanted, do not bed the motifs on a layer of it. Appears only
   with ?bg in the URL, remembers the choice, and is deleted once a direction is
   picked. */
const OPTIONS: { id: SolidVariant; label: string; hint: string }[] = [
  { id: 'none', label: '无', hint: '纯底色，什么都不放' },
  { id: 'bars', label: '掠过的立柱', hint: '细长立柱从深处涌来掠过两侧，速度感最强' },
  { id: 'panels', label: '掠过的板片', hint: '宽而薄的板迎面而来，像穿过幕墙，比立柱安静' },
  { id: 'frames', label: '掠过的方框', hint: '一个个方框从旁边推过，最有「一段一段前进」的节奏' },
]

export default function LandingSpaceLayer() {
  const host = useRef<HTMLDivElement>(null)
  const handleRef = useRef<SpaceHandle | null>(null)
  const [variant, setVariant] = useState<SolidVariant>('bars')
  /* 挂载 effect 的依赖是空数组，它闭包里的 variant 永远是初值。异步创建完成
     得比「从 localStorage 恢复选择」晚，直接用闭包值会把恢复的选择覆盖回初值。
     所以当前值另存一份 ref。
     The mount effect has an empty dependency array, so the variant in its closure
     is forever the initial one. Creation finishes after the stored choice is
     restored, and using the closure value would overwrite that choice with the
     initial one - hence a ref holding the current value. */
  const variantRef = useRef<SolidVariant>('bars')
  const [picker, setPicker] = useState(false)

  /* 初值在 effect 里读而不是在 useState 初始化器里读：初始化器在客户端首次
     渲染时就会执行，SSR 输出与之不一致会触发 hydration 警告。
     Read the stored value in an effect rather than a useState initialiser: the
     initialiser runs during the first client render and would not match the SSR
     output, which trips a hydration warning. */
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has('bg')) setPicker(true)
    const saved = localStorage.getItem('slBg') as SolidVariant | null
    if (saved && OPTIONS.some((o) => o.id === saved)) setVariant(saved)
  }, [])

  useEffect(() => {
    variantRef.current = variant
    handleRef.current?.setSolid(variant)
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
        /* 照明一律关：元素底下不再垫光。
           Lighting stays off: the motifs are not bedded on a wash. */
        handle.setBackdrop('none')
        handle.setSolid(variantRef.current)
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
