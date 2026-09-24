// 节日动效编排 / festival motion choreography
//
// 分工：入场与互动用 GSAP 时间线（需要缓动曲线、先后次序、弹性回落），
// 入场结束后的「待机」循环交给 CSS（festival.css 里 .fa-live 下的那组），
// 这样常驻的动画不占 JS 帧。
// Split of duties: entrances and interactions use GSAP timelines (they need
// real easing, sequencing and elastic settle); the idle loops that follow are
// plain CSS under .fa-live in festival.css, so nothing resident costs JS frames.
//
// GSAP 走动态 import，与落地页叙事区同一个 chunk：非节日期间一个字节都不下载。
// GSAP is dynamically imported (the same chunk the landing story uses), so
// nothing is downloaded outside festival windows.
//
// 每个动作都能用一句话说清它在表达什么：帽子「落」在瓶口上、灯笼被「挂」上去后
// 来回荡、雪「堆」在瓶口、烟花「炸开」。没有为了动而动的东西。
// Every move states something physical: the hat lands on the rim, the lantern
// is hung and swings, snow settles on the rim, a sparkle pops. Nothing moves
// just to move.

import type { ArtKey } from './art'

type Gsap = typeof import('gsap')['gsap']
type Timeline = ReturnType<Gsap['timeline']>

let loader: Promise<Gsap> | null = null

export function loadGsap(): Promise<Gsap> {
  if (!loader) {
    loader = Promise.all([import('gsap'), import('gsap/MotionPathPlugin')]).then(([g, m]) => {
      g.gsap.registerPlugin(m.MotionPathPlugin)
      return g.gsap
    })
  }
  return loader
}

export type Surface = 'ornament' | 'icon' | 'empty'

// 入场结束后加 .fa-live，CSS 待机循环才开始。入场前的待机动画会和 GSAP 抢同一个
// transform，所以两者在时间上严格错开。
// .fa-live is added once the entrance ends, which is when CSS idle loops start.
// Idle loops and GSAP would fight over the same transform, so they never overlap.
function goLive(el: Element) {
  el.classList.add('fa-live')
}

function q(el: Element, sel: string): Element[] {
  return Array.prototype.slice.call(el.querySelectorAll(sel))
}

// 返回一个清理函数；组件卸载或重放时调用。
// Returns a cleanup function, called on unmount or replay.
export function playEntrance(el: Element, surface: Surface, key: ArtKey, reduced: boolean): () => void {
  el.classList.remove('fa-live')
  if (reduced || key === 'none') {
    // 减少动效：直接给最终画面，不放入场，也不开待机循环。
    // Reduced motion: final frame only, no entrance and no idle loops.
    return () => {}
  }
  let tl: Timeline | null = null
  let alive = true
  // 首帧先藏起来，避免 GSAP 加载前「先出现、再从头播一遍」的闪烁。
  // Hide until GSAP arrives so the art does not flash in, then replay from scratch.
  ;(el as HTMLElement).style.visibility = 'hidden'
  loadGsap()
    .then((gsap) => {
      if (!alive) return
      ;(el as HTMLElement).style.visibility = ''
      tl = gsap.timeline({ onComplete: () => goLive(el) })
      build(gsap, tl, el, surface, key)
    })
    .catch(() => {
      ;(el as HTMLElement).style.visibility = ''
      goLive(el)
    })
  return () => {
    alive = false
    if (tl) {
      tl.kill()
      tl = null
    }
    ;(el as HTMLElement).style.visibility = ''
  }
}

function build(gsap: Gsap, tl: Timeline, el: Element, surface: Surface, key: ArtKey) {
  if (surface === 'ornament') return buildOrnament(gsap, tl, el, key)
  if (surface === 'icon') return buildIcon(tl, el, key)
  return buildEmpty(tl, el, key)
}

function buildOrnament(gsap: Gsap, tl: Timeline, el: Element, key: ArtKey) {
  switch (key) {
    case 'halloween': {
      // 帽子从上方落到瓶口：落地弹两下，再往一侧歪一下回正。
      // The hat drops onto the rim, bounces twice, tips to one side and settles.
      const hat = q(el, '.fa-o-hat')
      tl.from(hat, { y: -46, rotation: -16, transformOrigin: '50% 100%', duration: 0.95, ease: 'bounce.out' })
        .to(hat, { rotation: 7, duration: 0.14, ease: 'power2.out' })
        .to(hat, { rotation: 0, duration: 0.9, ease: 'elastic.out(1, 0.35)' })
        .from(q(el, '.fa-o-bat-in'), { x: 36, y: -24, scale: 0.2, opacity: 0, duration: 0.9, ease: 'back.out(1.7)' }, 0.55)
      break
    }
    case 'midautumn':
      tl.from(q(el, '.fa-o-moon'), { y: 16, opacity: 0, duration: 1.5, ease: 'power3.out' }).from(
        q(el, '.fa-o-cloud'),
        { x: 18, opacity: 0, duration: 1.3, ease: 'power2.out' },
        0.35
      )
      break
    case 'spring': {
      // 先系上红绳，结子再从 26° 松开、绕着绳头的小环摆动衰减——elastic 就是阻尼振荡。
      // The cord is tied first, then the knot is released at 26° and swings about
      // the little ring at the cord's end; an elastic ease is exactly a damped oscillation.
      const lan = q(el, '.fa-o-lantern')
      const cord = q(el, '.fa-o-cord') as SVGGeometryElement[]
      cord.forEach((c) => {
        const len = c.getTotalLength()
        gsap.set(c, { strokeDasharray: len, strokeDashoffset: len })
      })
      tl.to(cord, { strokeDashoffset: 0, duration: 0.45, ease: 'power2.inOut' })
        .from(lan, { opacity: 0, duration: 0.25, ease: 'power2.out' }, 0.3)
        .fromTo(lan, { rotation: 26 }, { rotation: 0, transformOrigin: '50% 0%', duration: 3.2, ease: 'elastic.out(1, 0.16)' }, 0.3)
        .fromTo(q(el, '.fa-o-tassel'), { rotation: -30 }, { rotation: 0, transformOrigin: '50% 0%', duration: 3.4, ease: 'elastic.out(1, 0.14)' }, 0.33)
      break
    }
    case 'christmas':
      tl.from(q(el, '.fa-o-snow'), { scaleY: 0, scaleX: 0.6, transformOrigin: '50% 100%', duration: 0.7, ease: 'back.out(2.4)' }).from(
        q(el, '.fa-o-holly'),
        { scale: 0, rotation: -50, transformOrigin: '0% 60%', duration: 0.7, ease: 'back.out(2.2)' },
        0.35
      )
      break
    case 'newyear':
      tl.from(q(el, '.fa-o-spark'), {
        scale: 0,
        rotation: -120,
        transformOrigin: '50% 50%',
        duration: 0.7,
        ease: 'back.out(3)',
        stagger: 0.14,
      })
      break
  }
  void gsap
}

function buildIcon(tl: Timeline, el: Element, key: ArtKey) {
  switch (key) {
    case 'halloween':
      tl.from(q(el, '.fa-pumpkin'), { y: 18, scaleY: 0.7, scaleX: 1.15, transformOrigin: '50% 100%', duration: 0.8, ease: 'elastic.out(1, 0.45)' })
        .from(q(el, '.fa-i-bat'), { x: 30, y: -12, opacity: 0, duration: 0.8, ease: 'power3.out' }, 0.2)
      break
    case 'midautumn':
      tl.from(q(el, '.fa-i-moon'), { y: 14, opacity: 0, duration: 1.3, ease: 'power3.out' }).from(
        q(el, '.fa-i-cloud'),
        { x: -26, opacity: 0, duration: 1.2, ease: 'power2.out' },
        0.3
      )
      break
    case 'spring':
      tl.fromTo(q(el, '.fa-i-lantern'), { y: -40, rotation: 22 }, { y: 0, duration: 0.5, ease: 'power2.out' }).to(
        q(el, '.fa-i-lantern'),
        { rotation: 0, transformOrigin: '50% 0%', duration: 2.6, ease: 'elastic.out(1, 0.18)' },
        0.2
      )
      break
    case 'christmas':
      tl.from(q(el, '.fa-i-star'), { scale: 0, rotation: -216, transformOrigin: '50% 50%', duration: 1, ease: 'back.out(2)' })
      break
    case 'newyear':
      tl.from(q(el, '.fa-i-burst'), { scale: 0.1, opacity: 0, transformOrigin: '50% 50%', duration: 0.8, ease: 'expo.out', stagger: 0.18 })
      break
  }
}

function buildEmpty(tl: Timeline, el: Element, key: ArtKey) {
  switch (key) {
    case 'halloween':
      tl.from(q(el, '.fa-pumpkin'), { y: 30, scaleY: 0.72, scaleX: 1.12, transformOrigin: '50% 100%', duration: 1, ease: 'elastic.out(1, 0.45)' })
        .from(q(el, '.fa-e-bat'), { x: 60, y: -30, opacity: 0, duration: 1.1, ease: 'power3.out', stagger: 0.2 }, 0.2)
      break
    case 'midautumn':
      tl.from(q(el, '.fa-e-moon'), { y: 26, opacity: 0, duration: 1.8, ease: 'power3.out' }).from(
        q(el, '.fa-rabbit'),
        { x: 40, duration: 0.9, ease: 'power2.out' },
        0.5
      )
        .from(q(el, '.fa-rabbit-body'), { y: -14, duration: 0.3, ease: 'power1.out', yoyo: true, repeat: 3 }, 0.5)
      break
    case 'spring':
      tl.fromTo(q(el, '.fa-e-lantern'), { y: -80, rotation: 20 }, { y: 0, duration: 0.6, ease: 'power2.out' })
        .to(q(el, '.fa-e-lantern'), { rotation: 0, transformOrigin: '50% 0%', duration: 3, ease: 'elastic.out(1, 0.16)' }, 0.3)
        .from(q(el, '.fa-bloom'), { scale: 0, transformOrigin: '50% 50%', duration: 0.5, ease: 'back.out(2.4)', stagger: 0.08 }, 0.2)
      break
    case 'christmas':
      tl.from(q(el, '.fa-e-star'), { scale: 0, rotation: -216, transformOrigin: '50% 50%', duration: 1.1, ease: 'back.out(2)' })
      break
    case 'newyear':
      tl.from(q(el, '.fa-e-burst'), { scale: 0.1, opacity: 0, transformOrigin: '50% 50%', duration: 0.9, ease: 'expo.out', stagger: 0.2 })
      break
  }
}

// Logo 上的轻触反馈：鼠标移上去时彩蛋「回应」一下。只在待机状态下触发，
// 不打断入场。
// A small reaction when the pointer lands on the logo. Only fires once the
// entrance is done, never interrupting it.
export function poke(el: Element, key: ArtKey, reduced: boolean) {
  if (reduced || !el.classList.contains('fa-live')) return
  loadGsap().then((gsap) => {
    switch (key) {
      case 'halloween': {
        const hat = q(el, '.fa-o-hat')
        gsap.timeline()
          .to(hat, { y: -9, rotation: -10, transformOrigin: '50% 100%', duration: 0.18, ease: 'power2.out' })
          .to(hat, { y: 0, rotation: 0, duration: 0.7, ease: 'bounce.out' })
        break
      }
      case 'spring':
        gsap.fromTo(q(el, '.fa-o-lantern'), { rotation: 18 }, { rotation: 0, transformOrigin: '50% 0%', duration: 2.2, ease: 'elastic.out(1, 0.18)', overwrite: true })
        break
      case 'midautumn':
        gsap.fromTo(q(el, '.fa-o-cloud'), { x: 0 }, { x: -6, duration: 0.5, yoyo: true, repeat: 1, ease: 'sine.inOut', overwrite: true })
        break
      case 'christmas':
        gsap.fromTo(q(el, '.fa-o-holly'), { rotation: 0 }, { rotation: 14, transformOrigin: '0% 60%', duration: 0.12, yoyo: true, repeat: 3, ease: 'sine.inOut', overwrite: true })
        break
      case 'newyear':
        gsap.fromTo(q(el, '.fa-o-spark'), { scale: 1 }, { scale: 1.45, transformOrigin: '50% 50%', duration: 0.16, yoyo: true, repeat: 1, stagger: 0.06, ease: 'power2.out', overwrite: true })
        break
    }
  })
}
