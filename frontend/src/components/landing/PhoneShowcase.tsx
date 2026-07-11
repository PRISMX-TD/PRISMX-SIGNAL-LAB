// 3D 手机滚动叙事：一台手机展示登录后的界面，随滚动摆正并按步骤切换屏幕。
// 3D phone scrollytelling: a phone mockup straightens on scroll and swaps
// screens as each narrative step activates.
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

/* ── 屏幕 1：实时信号 / live signal ── */
function ScreenSignals({ t }: { t: (k: string) => string }) {
  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-center justify-between px-1">
        <span className="text-[11px] font-bold text-slate-100">{t('landing.scrSignals')}</span>
        <span className="rounded px-1.5 py-0.5 text-[8px] font-bold" style={{ background: 'rgba(139,92,246,0.25)', color: 'var(--purple-hi)' }}>
          {t('landing.scrNew')}
        </span>
      </div>
      <div className="ph-card">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[12px] font-bold text-white">XAUUSD</div>
            <div className="text-[8.5px] text-slate-500">{t('landing.scrGold')}</div>
          </div>
          <span className="rounded px-1.5 py-0.5 text-[9px] font-bold" style={{ background: 'var(--up-bg)', color: 'var(--up)' }}>
            {t('landing.scrBuy')}
          </span>
        </div>
        <div className="mt-2 grid grid-cols-3 gap-1.5">
          <div className="ph-tile">
            <div className="cap">{t('landing.scrEntry')}</div>
            <div className="val num">2350.00</div>
          </div>
          <div className="ph-tile sl">
            <div className="cap">{t('landing.scrSl')}</div>
            <div className="val num">2340.60</div>
          </div>
          <div className="ph-tile tp">
            <div className="cap">{t('landing.scrTp')}</div>
            <div className="val num">2368.80</div>
          </div>
        </div>
        <div className="mt-2 flex items-center justify-between text-[9px]">
          <span className="text-slate-500">{t('landing.scrRr')}</span>
          <span className="num font-bold text-white">1 : 2.0</span>
        </div>
        <div className="mt-1.5 h-[4px] overflow-hidden rounded-full bg-white/10">
          <div className="h-full w-[68%] rounded-full" style={{ background: 'linear-gradient(90deg,#7c3aed,#a855f7)' }} />
        </div>
        <div className="mt-1 text-right text-[8px] text-slate-500">{t('landing.scrTtl')}</div>
      </div>
      <div className="ph-card opacity-45">
        <div className="flex items-center justify-between">
          <div className="text-[11px] font-bold text-white">EURUSD</div>
          <span className="rounded px-1.5 py-0.5 text-[9px] font-bold" style={{ background: 'var(--down-bg)', color: 'var(--down)' }}>
            {t('landing.scrSell')}
          </span>
        </div>
      </div>
    </div>
  )
}

/* ── 屏幕 2：滑动确认下单 / slide-to-confirm order ── */
function ScreenOrder({ t }: { t: (k: string) => string }) {
  return (
    <div className="flex h-full flex-col gap-2">
      <div className="px-1 text-[11px] font-bold text-slate-100">{t('landing.scrOrderTitle')}</div>
      <div className="ph-card">
        <div className="flex items-center justify-between text-[9.5px]">
          <span className="text-slate-500">{t('landing.scrDir')}</span>
          <span className="font-bold" style={{ color: 'var(--up)' }}>XAUUSD · {t('landing.scrBuy')}</span>
        </div>
        <div className="mt-1.5 flex items-center justify-between text-[9.5px]">
          <span className="text-slate-500">{t('landing.scrLots')}</span>
          <span className="num font-bold text-white">0.10</span>
        </div>
        <div className="mt-1.5 flex items-center justify-between text-[9.5px]">
          <span className="text-slate-500">{t('landing.scrMaxLoss')}</span>
          <span className="font-bold text-white">1%</span>
        </div>
      </div>
      {/* 已完成的滑动确认条 / completed slide-to-confirm track */}
      <div
        className="relative flex h-[38px] items-center overflow-hidden rounded-[12px] border"
        style={{ borderColor: 'rgba(46,224,126,0.5)', background: 'rgba(46,224,126,0.12)' }}
      >
        <div
          className="absolute left-1 top-1/2 grid h-[30px] w-[30px] -translate-y-1/2 place-items-center rounded-[9px] text-[13px] font-bold text-white"
          style={{ background: 'linear-gradient(130deg,#16a866,#2ee07e)' }}
        >
          ✓
        </div>
        <span className="mx-auto text-[9.5px] font-semibold" style={{ color: 'var(--up)' }}>
          {t('landing.scrConfirmed')}
        </span>
      </div>
      <div
        className="flex items-center gap-1.5 rounded-[10px] px-2.5 py-2 text-[9.5px] font-bold"
        style={{ background: 'var(--up-bg)', color: 'var(--up)', border: '1px solid rgba(46,224,126,0.3)' }}
      >
        ✓ {t('landing.scrFilled')} <span className="num">@ 2350.12</span>
      </div>
    </div>
  )
}

/* ── 屏幕 3：自动仓位管理 / auto position management ── */
function ScreenAuto({ t }: { t: (k: string) => string }) {
  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-center justify-between px-1">
        <span className="text-[11px] font-bold text-slate-100">{t('landing.scrAutoTitle')}</span>
        <span className="rounded px-1.5 py-0.5 text-[8px] font-bold" style={{ background: 'rgba(139,92,246,0.25)', color: 'var(--purple-hi)' }}>
          PRO
        </span>
      </div>
      <div className="ph-card">
        <div className="flex items-center justify-between">
          <div className="text-[11px] font-bold text-white">XAUUSD · {t('landing.scrBuy')} 0.20</div>
          <span className="num text-[11px] font-bold" style={{ color: 'var(--up)' }}>+$86.40</span>
        </div>
        <div
          className="mt-2 flex items-center gap-1.5 rounded-[9px] px-2 py-1.5 text-[9px] font-bold"
          style={{ background: 'var(--up-bg)', color: 'var(--up)' }}
        >
          🛡 {t('landing.scrBeMoved')}
        </div>
        <div className="mt-2 h-[4px] overflow-hidden rounded-full bg-white/10">
          <div className="h-full w-[55%] rounded-full" style={{ background: 'linear-gradient(90deg,#16a866,#2ee07e)' }} />
        </div>
        <div className="mt-1 flex justify-between text-[8px] text-slate-500">
          <span>0R</span>
          <span className="font-bold" style={{ color: 'var(--up)' }}>+1.0R ✓</span>
          <span>+2.0R</span>
        </div>
      </div>
      <div className="ph-card">
        <div className="text-[9px] leading-relaxed text-slate-400">{t('landing.scrTrailOn')}</div>
      </div>
    </div>
  )
}

/* ── 屏幕 4：透明记录（含判输的单）/ transparent record incl. a loss ── */
function ScreenRecord({ t }: { t: (k: string) => string }) {
  const rows = [
    { sym: 'XAUUSD', win: true },
    { sym: 'EURUSD', win: false },
    { sym: 'GBPUSD', win: true },
  ]
  return (
    <div className="flex h-full flex-col gap-2">
      <div className="px-1 text-[11px] font-bold text-slate-100">{t('landing.scrRecordTitle')}</div>
      {rows.map((r) => (
        <div key={r.sym} className="ph-card flex items-center justify-between">
          <div>
            <div className="text-[10.5px] font-bold text-white">{r.sym}</div>
            <div className="text-[8px] text-slate-500">{r.win ? t('landing.scrWin') : t('landing.scrLoss')}</div>
          </div>
          <span
            className="rounded px-1.5 py-0.5 text-[8.5px] font-bold"
            style={
              r.win
                ? { background: 'var(--up-bg)', color: 'var(--up)' }
                : { background: 'var(--down-bg)', color: 'var(--down)' }
            }
          >
            {r.win ? 'WIN' : 'LOSS'}
          </span>
        </div>
      ))}
      <div className="mt-auto text-center text-[8.5px] text-slate-500">{t('landing.scrRecordFoot')}</div>
    </div>
  )
}

export default function PhoneShowcase() {
  const { t } = useTranslation()
  const sectionRef = useRef<HTMLElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const stepRefs = useRef<Array<HTMLDivElement | null>>([])
  const [active, setActive] = useState(0)

  // 步骤激活：视口中带（上下各让开 ~42%）命中即激活对应屏幕
  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            const idx = Number((e.target as HTMLElement).dataset.step)
            if (!Number.isNaN(idx)) setActive(idx)
          }
        })
      },
      { rootMargin: '-42% 0px -42% 0px', threshold: 0 },
    )
    stepRefs.current.forEach((el) => el && io.observe(el))
    return () => io.disconnect()
  }, [])

  // 3D 倾斜：随区块滚入而摆正（rAF 节流；reduced-motion 直接跳过）
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    let raf = 0
    const onScroll = () => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        const sec = sectionRef.current
        const frame = frameRef.current
        if (!sec || !frame) return
        const r = sec.getBoundingClientRect()
        const vh = window.innerHeight
        const p = Math.min(1, Math.max(0, (vh - r.top) / (vh * 1.2)))
        const ease = 1 - Math.pow(1 - p, 3)
        const ry = -18 + 14 * ease
        const rx = 8 - 6 * ease
        const ty = 34 - 34 * ease
        frame.style.transform = `translateY(${ty}px) rotateY(${ry}deg) rotateX(${rx}deg)`
      })
    }
    onScroll()
    // 捕获阶段监听：即使滚动发生在某个内层滚动容器（而非视口），事件也能收到
    // capture-phase listener: fires even if scrolling happens in an inner
    // scroll container rather than the viewport
    document.addEventListener('scroll', onScroll, { capture: true, passive: true })
    window.addEventListener('resize', onScroll)
    return () => {
      document.removeEventListener('scroll', onScroll, { capture: true })
      window.removeEventListener('resize', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [])

  const steps = [0, 1, 2, 3].map((i) => ({
    pain: t(`landing.sh${i + 1}Pain`),
    title: t(`landing.sh${i + 1}Title`),
    desc: t(`landing.sh${i + 1}Desc`),
  }))

  return (
    <section id="showcase" ref={sectionRef} className="mx-auto max-w-7xl scroll-mt-20 px-4 py-20 sm:px-6">
      <div className="reveal mb-4 text-center lg:mb-10">
        <span className="eyebrow">{t('landing.shEyebrow')}</span>
        <h2 className="mt-3 font-display text-3xl font-bold text-slate-50 sm:text-4xl">{t('landing.shTitle')}</h2>
        <p className="mx-auto mt-3 max-w-xl text-slate-400">{t('landing.shSubtitle')}</p>
      </div>

      <div className="lg:grid lg:grid-cols-[1fr_1fr] lg:gap-12">
        {/* 手机样机：移动端吸顶缩小，桌面端右列 sticky / phone: mobile sticky-top, desktop sticky right column */}
        <div className="contents lg:block lg:order-2">
          <div className="ph-sticky-mask">
            <div className="ph-stage">
              <div className="ph-scale">
                <div ref={frameRef} className="ph-frame">
                  <div className="ph-screen">
                    <div className="ph-island" />
                    <div className="ph-status">
                      <span>09:41</span>
                      <span>●●●</span>
                    </div>
                    <div className={`ph-view ${active === 0 ? 'on' : ''}`}><ScreenSignals t={t} /></div>
                    <div className={`ph-view ${active === 1 ? 'on' : ''}`}><ScreenOrder t={t} /></div>
                    <div className={`ph-view ${active === 2 ? 'on' : ''}`}><ScreenAuto t={t} /></div>
                    <div className={`ph-view ${active === 3 ? 'on' : ''}`}><ScreenRecord t={t} /></div>
                    <div className="ph-tabbar">
                      {[0, 1, 2, 3].map((i) => (
                        <span key={i} className={`ph-tab-dot ${active === i ? 'on' : ''}`} />
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <p className="mt-3 text-center text-[10px] uppercase tracking-[0.2em] text-slate-600">
              {t('landing.shCaption')}
            </p>
          </div>
        </div>

        {/* 步骤文案 / narrative steps */}
        <div className="lg:order-1">
          {steps.map((s, i) => (
            <div
              key={i}
              data-step={i}
              ref={(el) => { stepRefs.current[i] = el }}
              className={`sh-step ${active === i ? 'on' : ''}`}
            >
              <span className="sh-step-num">0{i + 1} / 04</span>
              <p className="mt-3 text-sm font-semibold text-prism-300">{s.pain}</p>
              <h3 className="mt-2 font-display text-2xl font-bold leading-snug text-slate-50 sm:text-3xl">
                {s.title}
              </h3>
              <p className="mt-3 max-w-md text-sm leading-relaxed text-slate-400 sm:text-base">{s.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
