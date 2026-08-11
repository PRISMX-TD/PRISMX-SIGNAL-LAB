// 手机屏幕内容（五幕）/ the five phone screens for the scrolltelling landing
//
// 这些不是 div 画的假截图：它们用产品自己的组件语汇（.chip / .num / 语义涨跌色 /
// 发丝线）搭出真实比例的迷你界面，文案全部来自既有 i18n 的 landing.scr* 示例键，
// 手机下方固定标注「示例界面 · 非实时数据」（landing.shCaption，见 PhoneStory）。
// 改 design token 时这些屏幕跟着变；切英文时它们跟着切——这正是 CSS 3D 方案里
// 「屏幕是真实 DOM」的全部意义。
//
// 尺寸单位是 cqw（.dev-screen 开了 container-type: inline-size）：同一份组件在
// 桌面 330px 宽的手机和移动端 180px 宽的手机里按比例缩放，不需要两套断点。
//
// These are not div-drawn fake screenshots: they are miniature interfaces built
// from the product's own vocabulary (.chip / .num / semantic up-down colours /
// hairlines), with every string coming from the existing landing.scr* sample
// keys in i18n, and a fixed "sample interface, not live data" caption under the
// phone (landing.shCaption, rendered in PhoneStory). Change a design token and
// these screens follow; switch to English and they switch. That is the entire
// point of the CSS-3D route where the screen is real DOM.
//
// Sizing is in cqw (.dev-screen sets container-type: inline-size): one set of
// components scales proportionally between the 330px desktop phone and the
// 180px mobile phone with no second breakpoint system.
import { useEffect, useState } from 'react'

type T = (k: string) => string

/* 屏幕顶部状态行：时间 + 信号计数。刻意不做电池/信号格图标——那是「假手机
   截图」的装饰细节，这里只保留与产品有关的信息。
   Screen status row: time + signal count. Deliberately no battery/signal-bar
   icons: those are fake-screenshot decoration; only product-relevant info stays. */
function ScreenHead({ title, aux }: { title: string; aux?: string }) {
  return (
    <div className="mb-[5cqw] flex items-baseline justify-between border-b border-white/[0.08] pb-[3.5cqw]">
      <span className="text-[4.8cqw] font-bold text-white">{title}</span>
      {aux && <span className="num text-[3.4cqw] text-neutral-500">{aux}</span>}
    </div>
  )
}

/* ═════ 幕 0（Hero）：今日信号列表 / scene 0: today's signal list ═════ */
export function ScreenSignals({ t, on }: { t: T; on: boolean }) {
  const rows = [
    { sym: 'XAUUSD', name: t('landing.scrGold'), side: 'buy' as const, px: '3 412.80', fresh: true },
    { sym: 'EURUSD', name: 'EUR', side: 'sell' as const, px: '1.084 20', fresh: false },
    { sym: 'GBPJPY', name: 'GBP', side: 'buy' as const, px: '196.420', fresh: false },
  ]
  return (
    <div className={`scr ${on ? "on" : ""}`} data-scr="0">
      <ScreenHead title={t('landing.scrSignals')} aux="3" />
      <div className="flex flex-col gap-[3cqw]">
        {rows.map((r) => (
          <div key={r.sym} className="rounded-[3cqw] border border-white/[0.08] bg-white/[0.03] p-[4cqw]">
            <div className="flex items-center justify-between">
              <div className="flex items-baseline gap-[2cqw]">
                <span className="text-[4.4cqw] font-bold text-white">{r.sym}</span>
                {r.fresh && (
                  <span className="rounded-[1.5cqw] bg-prism-600 px-[2cqw] py-[0.6cqw] text-[2.8cqw] font-bold text-white">
                    {t('landing.scrNew')}
                  </span>
                )}
              </div>
              <span className={`text-[3.2cqw] font-bold ${r.side === 'buy' ? 'text-up' : 'text-down'}`}>
                {t(r.side === 'buy' ? 'landing.scrBuy' : 'landing.scrSell')}
              </span>
            </div>
            <div className="num mt-[2cqw] text-[4.6cqw] font-semibold text-neutral-200">{r.px}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

/* ═════ 幕 1：完整交易计划（倒计时是活的）/ scene 1: the full plan, live countdown ═════ */
export function ScreenPlan({ t, on }: { t: T; on: boolean }) {
  // 倒计时从 i18n 字符串里解析初始值（scrTtl 形如「有效期 08:45」），每秒递减。
  // 这是「屏幕是真实 DOM」的展示位：烤成 WebGL 纹理的截图永远不会走字。
  // reduced-motion 下不启动定时器，保持静态。
  // The countdown parses its start from the i18n string (scrTtl reads like
  // "Valid 08:45") and ticks down every second. This is the showcase for
  // real-DOM screens: a texture-baked screenshot never ticks. Under
  // reduced-motion the timer never starts.
  const raw = t('landing.scrTtl')
  const m = raw.match(/(\d{1,2}):(\d{2})/)
  const init = m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : 8 * 60 + 45
  const [left, setLeft] = useState(init)
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const id = setInterval(() => setLeft((s) => (s > 0 ? s - 1 : init)), 1000)
    return () => clearInterval(id)
  }, [init])
  const mmss = `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`
  const ttl = m ? raw.replace(/(\d{1,2}):(\d{2})/, mmss) : `${raw} ${mmss}`

  const tiles = [
    { k: 'scrEntry', v: '3 412.80', tone: 'text-white' },
    { k: 'scrSl', v: '3 398.20', tone: 'text-down' },
    { k: 'scrTp', v: '3 445.60', tone: 'text-up' },
  ]
  return (
    <div className={`scr ${on ? "on" : ""}`} data-scr="1">
      <div className="flex items-center justify-between">
        <div className="flex items-baseline gap-[2.4cqw]">
          <span className="text-[6cqw] font-bold text-white">XAUUSD</span>
          <span className="text-[3.4cqw] text-neutral-500">{t('landing.scrGold')}</span>
        </div>
        <span className="rounded-[1.8cqw] border border-up/40 bg-up/10 px-[2.6cqw] py-[1cqw] text-[3.4cqw] font-bold text-up">
          {t('landing.scrBuy')}
        </span>
      </div>

      <div className="mt-[5cqw] grid grid-cols-3 gap-px overflow-hidden rounded-[3cqw] border border-white/[0.08] bg-white/[0.08]">
        {tiles.map((x) => (
          <div key={x.k} className="bg-ink-850 p-[3.4cqw]">
            <div className="text-[2.9cqw] uppercase tracking-[0.08em] text-neutral-500">{t(`landing.${x.k}`)}</div>
            <div className={`num mt-[1.6cqw] text-[4.4cqw] font-semibold ${x.tone}`}>{x.v}</div>
          </div>
        ))}
      </div>

      <div className="mt-[4.5cqw] flex items-baseline justify-between border-t border-white/[0.08] pt-[4cqw]">
        <span className="text-[3.4cqw] text-neutral-500">{t('landing.scrRr')}</span>
        <span className="num text-[4.6cqw] font-semibold text-white">1 : 2.26</span>
      </div>
      {/* 倒计时条：剩余时间同时用数字和长度表达 / countdown as number + bar */}
      <div className="mt-auto">
        <div className="num text-[3.6cqw] text-neutral-400">{ttl}</div>
        <div className="mt-[2cqw] h-[1.2cqw] overflow-hidden rounded-full bg-white/[0.08]">
          <div
            className="h-full bg-prism-500"
            style={{ width: `${Math.round((left / init) * 100)}%`, transition: 'width 1s linear' }}
          />
        </div>
      </div>
    </div>
  )
}

/* ═════ 幕 2：滑动下单 / scene 2: slide-to-confirm ═════
   滑块（.js-knob）由外部驱动：scrub 模式里 GSAP 把它和滚动进度绑在一起——
   用户往下滚，滑块往右走，滚到位的瞬间「已成交」亮起。滚动行为与产品行为
   在这一刻同构，这是全页最重要的一个动效。steps 模式里由 CSS 过渡代驾。
   The knob (.js-knob) is driven externally: in scrub mode GSAP ties it to
   scroll progress, so scrolling down pushes the knob right and "filled" lights
   up exactly when it lands. The scroll gesture and the product gesture become
   the same motion, which makes this the page's single most important effect.
   In steps mode the CSS transition takes over. */
export function ScreenOrder({ t, on }: { t: T; on: boolean }) {
  const rows = [
    { k: 'scrDir', v: t('landing.scrBuy'), tone: 'text-up' },
    { k: 'scrLots', v: '0.24', tone: 'text-white num' },
    { k: 'scrMaxLoss', v: '-$118.40', tone: 'text-down num' },
  ]
  return (
    <div className={`scr ${on ? "on" : ""}`} data-scr="2">
      <ScreenHead title={t('landing.scrOrderTitle')} />
      <div className="flex flex-col">
        {rows.map((r) => (
          <div key={r.k} className="flex items-baseline justify-between border-b border-white/[0.06] py-[3.6cqw] last:border-0">
            <span className="text-[3.6cqw] text-neutral-400">{t(`landing.${r.k}`)}</span>
            <span className={`text-[4.2cqw] font-semibold ${r.tone}`}>{r.v}</span>
          </div>
        ))}
      </div>

      {/* 滑动确认条 / the slide track */}
      <div className="mt-auto">
        <div className="js-track relative h-[13cqw] overflow-hidden rounded-full border border-white/[0.1] bg-white/[0.04]">
          <div className="js-knob absolute left-[1.2cqw] top-1/2 grid h-[10.5cqw] w-[10.5cqw] -translate-y-1/2 place-items-center rounded-full bg-prism-600 text-[4.5cqw] font-bold text-white">
            <span aria-hidden>›</span>
          </div>
        </div>
        {/* 成交回执：透明度由动画层（GSAP 或 steps 模式的 CSS 过渡）驱动。
            Fill receipt; opacity driven by the animation layer (GSAP, or the
            steps-mode CSS transition). */}
        <div className="js-filled mt-[3.5cqw] flex items-center justify-between rounded-[3cqw] border border-up/35 bg-up/10 px-[4cqw] py-[3cqw]">
          <span className="text-[3.6cqw] font-semibold text-up">{t('landing.scrFilled')}</span>
          <span className="num text-[3.6cqw] text-neutral-300">3 412.86</span>
        </div>
      </div>
    </div>
  )
}

/* ═════ 幕 3：自动守夜 / scene 3: automatic position management ═════
   迷你价格路径 + 一条向上爬的止损线（.js-sl）。价格路径是产品语汇里的
   sparkline（产品内本来就有真实图表），不是装饰性插画；线的爬升由外部驱动：
   先跳到保本位（.js-be 亮起），再随行情推进。
   A mini price path plus a stop-loss line (.js-sl) that climbs. The path is a
   sparkline from the product's own vocabulary (the product ships real charts),
   not decorative illustration; the climb is externally driven — first to
   breakeven (.js-be lights up), then trailing the move. */
export function ScreenGuard({ t, on }: { t: T; on: boolean }) {
  return (
    <div className={`scr ${on ? "on" : ""}`} data-scr="3">
      <ScreenHead title={t('landing.scrAutoTitle')} />
      <div className="relative overflow-hidden rounded-[3cqw] border border-white/[0.08] bg-white/[0.02]">
        <svg viewBox="0 0 100 62" className="block w-full" aria-hidden>
          {/* 价格路径：整体向上、带回撤的示例行情 / sample path: up with pullbacks */}
          <polyline
            points="2,52 12,48 18,50 26,42 33,44 42,34 49,37 58,27 64,30 73,20 81,23 90,13 98,15"
            fill="none"
            stroke="#35C97A"
            strokeWidth="1.6"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          {/* 入场价：中性虚线 / entry: neutral dashed */}
          <line x1="0" y1="46" x2="100" y2="46" stroke="#71717A" strokeWidth="0.7" strokeDasharray="2.4 2.4" />
          {/* 止损线组：从入场下方起步，由外部动画向上平移。
              The SL group starts below entry and is translated upward externally. */}
          <g className="js-sl">
            <line x1="0" y1="56" x2="100" y2="56" stroke="#8B6CFF" strokeWidth="1.1" />
            <rect x="2" y="50.6" width="14" height="8" rx="1.6" fill="#5A22EE" />
            <text x="9" y="56.4" textAnchor="middle" fontSize="4.6" fontWeight="700" fill="#FFFFFF" fontFamily="inherit">
              SL
            </text>
          </g>
        </svg>
        {/* 保本徽章：止损爬过入场价的那一刻亮起 / lights up as SL crosses entry */}
        <div className="js-be absolute left-[4cqw] top-[4cqw] rounded-[2cqw] border border-prism-400/40 bg-prism-600/20 px-[2.8cqw] py-[1.4cqw] text-[3cqw] font-semibold text-prism-200">
          {t('landing.scrBeMoved')}
        </div>
      </div>
      <p className="mt-[4cqw] text-[3.4cqw] leading-relaxed text-neutral-400">{t('landing.scrTrailOn')}</p>
    </div>
  )
}

/* ═════ 幕 4：全量留痕 / scene 4: the full record ═════
   赢单和亏单同字号、同排版——亏损不缩小、不变灰。这一行视觉决定就是产品
   的核心主张（「记录里连删除按钮都没做」），字面上兑现它。
   Wins and losses at identical size and identical layout. That single visual
   decision IS the product's core claim (the record has no delete button), so
   the screen honours it literally. */
export function ScreenRecord({ t, on }: { t: T; on: boolean }) {
  const rows = [
    { sym: 'XAUUSD', win: true, pnl: '+186.40' },
    { sym: 'EURUSD', win: false, pnl: '-92.15' },
    { sym: 'GBPUSD', win: true, pnl: '+214.77' },
    { sym: 'AUDUSD', win: true, pnl: '+158.03' },
  ]
  return (
    <div className={`scr ${on ? "on" : ""}`} data-scr="4">
      <ScreenHead title={t('landing.scrRecordTitle')} />
      <div className="flex flex-col">
        {rows.map((r) => (
          <div key={r.sym} className="js-rec flex items-center justify-between border-b border-white/[0.06] py-[3.4cqw] last:border-0">
            <div className="flex flex-col gap-[1cqw]">
              <span className="text-[3.9cqw] font-bold text-white">{r.sym}</span>
              <span className={`text-[2.9cqw] ${r.win ? 'text-up' : 'text-down'}`}>
                {t(r.win ? 'landing.scrWin' : 'landing.scrLoss')}
              </span>
            </div>
            <span className={`num text-[4.4cqw] font-semibold ${r.win ? 'text-up' : 'text-down'}`}>{r.pnl}</span>
          </div>
        ))}
      </div>
      <p className="mt-auto border-t border-white/[0.08] pt-[3.5cqw] text-[3cqw] text-neutral-500">
        {t('landing.scrRecordFoot')}
      </p>
    </div>
  )
}
