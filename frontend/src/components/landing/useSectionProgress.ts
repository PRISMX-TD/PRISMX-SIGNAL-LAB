// 叙事区滚动进度 → CSS 变量（仅移动端 steps 模式使用）
//
// steps 模式的体感问题：幕与幕之间是「死区」——IO 哨兵只在边界处切一次幕，
// 边界之间滚多少屏幕都纹丝不动，用户的反馈是「推了很久没反应」。桌面 scrub
// 模式没有这个问题，因为 GSAP 把每一帧都绑在滚动上。
// 这个 hook 给 steps 模式补上同样的「每帧有回应」：把区块的滚动进度（0–1）
// 写进区块根元素的 --sec-p，CSS 用它驱动右缘刻度的连续填充。改的是感知，
// 不是结构——幕的切换仍然由原来的 IO 哨兵负责。
//
// 实现遵守全站约定「绝不挂 window scroll 监听」（见 LandingSpace 的同款做法）：
// rAF 循环每帧从 getBoundingClientRect 读位置，且只在区块可见时运行——由一个
// IntersectionObserver 启停，滚出视口后循环彻底停表，不空转。
// 写入按 0.2% 步进量化：3px 宽的刻度上小于这个步进的变化不可见，跳过写入
// 可以避免每帧触发样式重算。
//
// Steps mode switches scenes only at sentinel boundaries, so everything between
// boundaries is dead air — scroll and nothing responds. This hook writes the
// section's scroll progress (0–1) into --sec-p on its root element every frame,
// and CSS turns the edge ticks into a continuously filling gauge. Perception
// only; scene switching still belongs to the existing IO sentinels.
// It honours the repo-wide "never attach a window scroll listener" rule: an
// rAF loop reads getBoundingClientRect per frame, gated by an
// IntersectionObserver so it fully stops while the section is off screen.
// Writes are quantised to 0.2% — invisible on a 3px tick, and skipping them
// avoids a style recalc on frames where nothing changed.
import { useEffect, type RefObject } from 'react'

export function useSectionProgress(ref: RefObject<HTMLElement | null>, enabled: boolean) {
  useEffect(() => {
    if (!enabled || !ref.current) return
    const el = ref.current
    let raf = 0
    let running = false
    let last = -1

    const frame = () => {
      if (!running) return
      const r = el.getBoundingClientRect()
      // 可滚动行程 = 区块高 − 一屏（sticky 舞台占掉的那一屏不产生进度）
      // Scrollable travel = section height minus the one screen the sticky
      // stage occupies.
      const total = r.height - window.innerHeight
      const p = total > 0 ? Math.min(1, Math.max(0, -r.top / total)) : 0
      const q = Math.round(p * 500) / 500
      if (q !== last) {
        last = q
        el.style.setProperty('--sec-p', String(q))
      }
      raf = requestAnimationFrame(frame)
    }

    const io = new IntersectionObserver((entries) => {
      const vis = entries[entries.length - 1].isIntersecting
      if (vis && !running) {
        running = true
        raf = requestAnimationFrame(frame)
      } else if (!vis && running) {
        running = false
        cancelAnimationFrame(raf)
      }
    })
    io.observe(el)

    return () => {
      io.disconnect()
      running = false
      cancelAnimationFrame(raf)
    }
  }, [ref, enabled])
}
