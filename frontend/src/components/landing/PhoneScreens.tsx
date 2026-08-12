// 手机屏幕内容（五幕）/ the five phone screens for the scrolltelling landing
//
// 仿真度原则：屏幕里的每一幕都**镜像登录后产品的真实排版**，不是「像一个交易
// App」而是「就是这个 App」——
//   · 信号卡 = SignalGrid 的真实结构：品种 + 方向 chip，右上角大号盈亏比，
//     三格 tile（入场中性 / 止损红染 / 止盈绿染，同 .tile-sl/.tile-tp 的染色
//     规则），底部紫色 TTL 进度条（同 .sig-ttl-bar）。
//   · 下单幕 = SlideOrderModal 的真实结构：滑轨 + 紫色填充层 + 方圆角滑块 +
//     轨道中央「滑动确认下单」（order.slideToConfirm，产品同一个 i18n 键），
//     完成态转绿（同 .slide-track.done）。
//   · 屏幕骨架 = Layout 的真实骨架：顶部品牌条（真 logo.png）+ 底部五格
//     Tab 栏（图标路径逐条取自 Layout.tsx 的 TabIcon），激活 Tab 随幕切换。
// 文案全部来自既有 i18n 键；手机下方固定「示例界面 · 非实时数据」声明。
//
// Fidelity principle: every scene mirrors the real logged-in product's layout.
// Signal cards use SignalGrid's actual structure (symbol + side chip, large RR
// top-right, three tiles with the .tile-sl/.tile-tp tint rules, violet TTL bar
// as in .sig-ttl-bar); the order scene reproduces SlideOrderModal (track +
// violet fill + squared knob + the same order.slideToConfirm label, turning
// green on completion like .slide-track.done); and the screen skeleton is
// Layout's skeleton (brand strip with the real logo.png, five-tab bottom bar
// whose icon paths are lifted from Layout.tsx's TabIcon, active tab following
// the scene). All strings come from existing i18n keys, with the sample-data
// disclaimer fixed under the phone.
//
// 尺寸单位是 cqw（.dev-screen 开了 container-type: inline-size）：桌面 330px
// 与移动端 150px 的手机共用同一份组件。/ Sizing is cqw so the desktop and
// mobile phones share one component set.
import { useEffect, useState } from 'react'

type T = (k: string) => string

// 按剩余百分比推一个 mm:ss 展示值（信号满时长 8:45，同 scrTtl 示例）。
// Derive a display mm:ss from the remaining percentage (full lifespan 8:45,
// matching the scrTtl sample).
function ttlText(pct: number) {
  const total = 8 * 60 + 45
  const left = Math.round((total * pct) / 100)
  return `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`
}

/* ═════ App 骨架 / app chrome ═════ */

// Tab 图标：路径逐条取自 Layout.tsx 的 TabIcon（产品自己的图标，不是新画的）。
// Tab icons: paths copied from Layout.tsx's TabIcon — the product's own
// glyphs, not newly drawn ones.
function TabGlyph({ name }: { name: string }) {
  const p = {
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  }
  switch (name) {
    case 'signals':
      return (
        <svg viewBox="0 0 24 24" {...p}>
          <path d="M3 17l5-6 4 4 5-7 4 5" />
        </svg>
      )
    case 'charts':
      return (
        <svg viewBox="0 0 24 24" {...p}>
          <path d="M3 3v18h18" />
          <rect x="7" y="10" width="3" height="7" rx="0.5" />
          <rect x="13" y="6" width="3" height="11" rx="0.5" />
          <path d="M8.5 10V7.5M8.5 17v2M14.5 6V4M14.5 17v2" />
        </svg>
      )
    case 'dashboard':
      return (
        <svg viewBox="0 0 24 24" {...p}>
          <rect x="3" y="3" width="7" height="7" rx="1" />
          <rect x="14" y="3" width="7" height="7" rx="1" />
          <rect x="3" y="14" width="7" height="7" rx="1" />
          <rect x="14" y="14" width="7" height="7" rx="1" />
        </svg>
      )
    case 'orders':
      return (
        <svg viewBox="0 0 24 24" {...p}>
          <path d="M5 3v18l2-1 2 1 2-1 2 1 2-1 2 1V3l-2 1-2-1-2 1-2-1-2 1-2-1z" />
          <path d="M9 8h6M9 12h6" />
        </svg>
      )
    default:
      return (
        <svg viewBox="0 0 24 24" fill="currentColor" stroke="none">
          <circle cx="5" cy="12" r="1.7" />
          <circle cx="12" cy="12" r="1.7" />
          <circle cx="19" cy="12" r="1.7" />
        </svg>
      )
  }
}

/* 顶部品牌条 + 底部 Tab 栏。activeTab 随幕切换：信号两幕亮「信号面板」，
   守夜幕亮「仪表盘」，留痕幕亮「订单回执」——Tab 的移动本身就是「App 在被
   使用」的叙事。/ Brand strip + bottom tabs. The active tab follows the story:
   the moving highlight itself narrates an app in use. */
export function PhoneChrome({ t, activeTab }: { t: T; activeTab: string }) {
  const tabs = [
    { id: 'signals', k: 'nav.signals' },
    { id: 'charts', k: 'nav.charts' },
    { id: 'dashboard', k: 'nav.dashboard' },
    { id: 'orders', k: 'nav.orders' },
    { id: 'more', k: 'nav.more' },
  ]
  return (
    <>
      <div className="pc-head">
        <img src="/logo.png" alt="" draggable={false} />
        <b>Signal Lab</b>
        {/* 在线点：EAStatusBadge 的语义（已连接），不是装饰。
            The dot carries EAStatusBadge's semantics (connected), not decoration. */}
        <span className="dot" />
      </div>
      <div className="pc-tabs">
        {tabs.map((x) => (
          <span key={x.id} className={`pc-tab ${activeTab === x.id ? 'on' : ''}`}>
            <TabGlyph name={x.id} />
            <span>{t(x.k)}</span>
          </span>
        ))}
      </div>
    </>
  )
}

/* ═════ 复用的真实信号卡 / the real signal card, reused ═════
   结构与 SignalGrid 的卡片逐项对应：头行（品种 + chip｜RR 大数字），三格
   tile，TTL 行 + 紫条。/ Mirrors SignalGrid's card item by item: header row
   (symbol + chip | large RR), three tiles, TTL row + violet bar. */
function MiniSignalCard({
  t,
  sym,
  side,
  entry,
  sl,
  tp,
  rr,
  ttlPct,
  fresh,
  compact,
}: {
  t: T
  sym: string
  side: 'buy' | 'sell'
  entry: string
  sl: string
  tp: string
  rr: string
  ttlPct: number
  fresh?: boolean
  compact?: boolean
}) {
  return (
    <div className="rounded-[3.4cqw] border border-white/[0.09] bg-white/[0.035] p-[3.8cqw]">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-[2cqw]">
          <b className="text-[4.6cqw] font-bold text-white">{sym}</b>
          <span
            className={`rounded-[1.6cqw] border px-[2cqw] py-[0.7cqw] text-[2.8cqw] font-bold ${
              side === 'buy' ? 'border-up/35 bg-up/10 text-up' : 'border-down/35 bg-down/10 text-down'
            }`}
          >
            {t(side === 'buy' ? 'landing.scrBuy' : 'landing.scrSell')}
          </span>
          {fresh && (
            <span className="rounded-[1.6cqw] bg-prism-600 px-[1.8cqw] py-[0.7cqw] text-[2.6cqw] font-bold text-white">
              {t('landing.scrNew')}
            </span>
          )}
        </div>
        <div className="text-right">
          <div className="num text-[4.4cqw] font-bold leading-none text-up">{rr}</div>
          <div className="mt-[0.8cqw] text-[2.9cqw] uppercase text-neutral-500">{t('landing.scrRr')}</div>
        </div>
      </div>

      {/* 三格 tile：中性入场 / 红染止损 / 绿染止盈（同 .tile-sl/.tile-tp）
          Three tiles: neutral entry, red-tinted SL, green-tinted TP. */}
      <div className="mt-[3cqw] grid grid-cols-3 gap-[1.8cqw]">
        <div className="rounded-[2.6cqw] border border-white/[0.09] bg-white/[0.03] px-[1cqw] py-[2cqw] text-center">
          <div className="text-[3.1cqw] text-neutral-500">{t('landing.scrEntry')}</div>
          <div className="num mt-[0.8cqw] text-[3.4cqw] font-bold text-white">{entry}</div>
        </div>
        <div className="rounded-[2.6cqw] border border-down/40 bg-down/[0.07] px-[1cqw] py-[2cqw] text-center">
          <div className="text-[3.1cqw] text-neutral-500">{t('landing.scrSl')}</div>
          <div className="num mt-[0.8cqw] text-[3.4cqw] font-bold text-down">{sl}</div>
        </div>
        <div className="rounded-[2.6cqw] border border-up/40 bg-up/[0.07] px-[1cqw] py-[2cqw] text-center">
          <div className="text-[3.1cqw] text-neutral-500">{t('landing.scrTp')}</div>
          <div className="num mt-[0.8cqw] text-[3.4cqw] font-bold text-up">{tp}</div>
        </div>
      </div>

      {!compact && (
        <div className="mt-[2.6cqw]">
          <div className="flex items-baseline justify-between text-[2.7cqw]">
            <span className="text-neutral-500">{t('landing.scrTtl').replace(/\s*\d{1,2}:\d{2}\s*/, '')}</span>
            <span className="num text-prism-300">{ttlText(ttlPct)}</span>
          </div>
          {/* TTL 紫条：同 .sig-ttl-bar / the violet TTL bar, as .sig-ttl-bar */}
          <div className="mt-[1.2cqw] h-[1.3cqw] overflow-hidden rounded-full bg-white/[0.09]">
            <div className="h-full rounded-full bg-prism-600" style={{ width: `${ttlPct}%` }} />
          </div>
        </div>
      )}
    </div>
  )
}

/* ═════ 幕 0（Hero）：信号面板 / scene 0: the signal panel ═════ */
export function ScreenSignals({ t, on }: { t: T; on: boolean }) {
  return (
    <div className={`scr ${on ? 'on' : ''}`} data-scr="0">
      <div className="mb-[3.4cqw] flex items-center gap-[2cqw]">
        <b className="text-[5cqw] font-bold text-white">{t('landing.scrSignals')}</b>
        {/* 计数徽章：同 .count-badge / count badge, as .count-badge */}
        <span className="grid min-w-[4.6cqw] place-items-center rounded-[1.6cqw] bg-prism-600 px-[1.4cqw] py-[0.5cqw] text-[2.8cqw] font-bold text-white">
          2
        </span>
      </div>
      <div className="flex flex-col gap-[3cqw]">
        <MiniSignalCard
          t={t}
          sym="XAUUSD"
          side="buy"
          entry="3412.80"
          sl="3398.20"
          tp="3445.60"
          rr="1:2.26"
          ttlPct={78}
          fresh
        />
        <MiniSignalCard
          t={t}
          sym="EURUSD"
          side="sell"
          entry="1.08420"
          sl="1.08760"
          tp="1.07850"
          rr="1:1.68"
          ttlPct={41}
        />
      </div>
    </div>
  )
}

/* ═════ 幕 1：完整计划（倒计时是活的）/ scene 1: the full plan, live countdown ═════ */
export function ScreenPlan({ t, on }: { t: T; on: boolean }) {
  // 倒计时从 i18n 字符串解析初始值（scrTtl 形如「有效期 08:45」），每秒递减。
  // 这是「屏幕是真实 DOM」的展示位：烤成 WebGL 纹理的截图永远不会走字。
  // reduced-motion 下不启动定时器。/ Countdown parsed from the i18n string and
  // ticking every second — the showcase for real-DOM screens; a texture never
  // ticks. No timer under reduced-motion.
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

  return (
    <div className={`scr ${on ? 'on' : ''}`} data-scr="1">
      <div className="mb-[3cqw] flex items-baseline justify-between">
        <div className="flex items-baseline gap-[2cqw]">
          <b className="text-[6cqw] font-bold text-white">XAUUSD</b>
          <span className="text-[3.2cqw] text-neutral-500">{t('landing.scrGold')}</span>
        </div>
        <span className="rounded-[1.8cqw] border border-up/40 bg-up/10 px-[2.4cqw] py-[1cqw] text-[3.4cqw] font-bold text-up">
          {t('landing.scrBuy')}
        </span>
      </div>

      <MiniSignalCard
        t={t}
        sym="XAUUSD"
        side="buy"
        entry="3412.80"
        sl="3398.20"
        tp="3445.60"
        rr="1:2.26"
        ttlPct={100}
        compact
      />

      {/* 活倒计时 + 紫条，放大版 / the live countdown with the violet bar, enlarged */}
      <div className="mt-auto">
        <div className="flex items-baseline justify-between text-[3.2cqw]">
          <span className="text-neutral-500">{raw.replace(/\s*\d{1,2}:\d{2}\s*/, '')}</span>
          <span className="num font-semibold text-prism-300">{mmss}</span>
        </div>
        <div className="mt-[1.6cqw] h-[1.6cqw] overflow-hidden rounded-full bg-white/[0.09]">
          <div
            className="h-full rounded-full bg-prism-600"
            style={{ width: `${Math.round((left / init) * 100)}%`, transition: 'width 1s linear' }}
          />
        </div>
        {/* 下单入口：产品里这张卡的落点 / the card's real call in the product */}
        <div className="mt-[3.5cqw] grid place-items-center rounded-[3cqw] bg-prism-600 py-[3.2cqw] text-[3.6cqw] font-bold text-white">
          {t('landing.scrOrderTitle')}
        </div>
      </div>
    </div>
  )
}

/* ═════ 幕 2：滑动下单 / scene 2: slide-to-confirm ═════
   滑轨结构逐项对应 SlideOrderModal：轨道（.slide-track）+ 紫色填充层
   （.slide-track-fill，随滑块推进）+ 轨道中央提示（order.slideToConfirm，与
   产品同一个 i18n 键）+ 方圆角紫色滑块（.slide-knob）。
   滑块由外部驱动：scrub 模式里 GSAP 把它和滚动进度绑在一起——用户往下滚，
   滑块往右推，滚到位的瞬间「已成交」亮起。滚动手势与产品手势在这一刻是
   同一个动作，这是全页最重要的动效。
   The track mirrors SlideOrderModal element for element: track, violet fill
   following the knob, the centred order.slideToConfirm label (the product's own
   i18n key), and the squared violet knob. Externally driven: in scrub mode the
   knob IS the scroll, and the receipt lights exactly when it lands. */
export function ScreenOrder({ t, on }: { t: T; on: boolean }) {
  const rows = [
    { k: 'scrDir', v: t('landing.scrBuy'), cls: 'text-up font-bold' },
    { k: 'scrLots', v: '0.24', cls: 'num text-white font-semibold' },
    { k: 'scrMaxLoss', v: '-$118.40', cls: 'num text-down font-semibold' },
  ]
  return (
    <div className={`scr ${on ? 'on' : ''}`} data-scr="2">
      <div className="mb-[3.4cqw] border-b border-white/[0.08] pb-[3cqw]">
        <b className="text-[4.6cqw] font-bold text-white">{t('landing.scrOrderTitle')}</b>
      </div>
      <div className="flex flex-col">
        {rows.map((r) => (
          <div key={r.k} className="flex items-baseline justify-between border-b border-white/[0.06] py-[3.2cqw] last:border-0">
            <span className="text-[3.4cqw] text-neutral-400">{t(`landing.${r.k}`)}</span>
            <span className={`text-[4cqw] ${r.cls}`}>{r.v}</span>
          </div>
        ))}
      </div>

      <div className="mt-auto">
        {/* 滑轨 / the track */}
        <div className="js-track relative h-[14cqw] overflow-hidden rounded-[3.5cqw] border border-white/[0.1] bg-white/[0.05]">
          {/* 紫色填充层：transform-origin 左缘，scaleX 跟着滑块走。
              The violet fill, scaling from the left edge in step with the knob. */}
          <div className="js-fill absolute inset-0 origin-left scale-x-0 bg-prism-600/30" />
          <div className="absolute inset-0 grid place-items-center text-[3.2cqw] font-semibold text-neutral-300">
            {t('order.slideToConfirm')}
          </div>
          <div className="js-knob absolute left-[1.4cqw] top-1/2 grid h-[11cqw] w-[11cqw] -translate-y-1/2 place-items-center rounded-[3cqw] bg-prism-600 text-[4.6cqw] font-bold text-white">
            <span aria-hidden>››</span>
          </div>
        </div>
        {/* 成交回执 / the fill receipt */}
        <div className="js-filled mt-[3.2cqw] flex items-center justify-between rounded-[3cqw] border border-up/35 bg-up/10 px-[3.6cqw] py-[3cqw]">
          <span className="text-[3.4cqw] font-bold text-up">{t('landing.scrFilled')}</span>
          <span className="num text-[3.4cqw] text-neutral-200">3412.86</span>
        </div>
      </div>
    </div>
  )
}

/* ═════ 幕 3：自动守夜 / scene 3: automatic position management ═════ */
export function ScreenGuard({ t, on }: { t: T; on: boolean }) {
  return (
    <div className={`scr ${on ? 'on' : ''}`} data-scr="3">
      <div className="mb-[3.4cqw] flex items-center justify-between border-b border-white/[0.08] pb-[3cqw]">
        <b className="text-[4.6cqw] font-bold text-white">{t('landing.scrAutoTitle')}</b>
        {/* 呼吸点：真实「运行中」语义（同 EAStatusBadge）
            Breathing dot: genuine running-state semantics, as EAStatusBadge. */}
        <span className="h-[1.8cqw] w-[1.8cqw] animate-breathe rounded-full bg-up" />
      </div>
      <div className="relative overflow-hidden rounded-[3.4cqw] border border-white/[0.09] bg-white/[0.03]">
        <svg viewBox="0 0 100 62" className="block w-full" aria-hidden>
          <polyline
            points="2,52 12,48 18,50 26,42 33,44 42,34 49,37 58,27 64,30 73,20 81,23 90,13 98,15"
            fill="none"
            stroke="#35C97A"
            strokeWidth="1.6"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          <line x1="0" y1="46" x2="100" y2="46" stroke="#71717A" strokeWidth="0.7" strokeDasharray="2.4 2.4" />
          <g className="js-sl">
            <line x1="0" y1="56" x2="100" y2="56" stroke="#8B6CFF" strokeWidth="1.1" />
            <rect x="2" y="50.6" width="14" height="8" rx="1.6" fill="#5A22EE" />
            <text x="9" y="56.4" textAnchor="middle" fontSize="4.6" fontWeight="700" fill="#FFFFFF" fontFamily="inherit">
              SL
            </text>
          </g>
        </svg>
        <div className="js-be absolute left-[3.4cqw] top-[3.4cqw] rounded-[2cqw] border border-prism-400/40 bg-prism-600/25 px-[2.6cqw] py-[1.3cqw] text-[2.9cqw] font-semibold text-prism-200">
          {t('landing.scrBeMoved')}
        </div>
      </div>
      <p className="mt-[3.6cqw] text-[3.2cqw] leading-relaxed text-neutral-400">{t('landing.scrTrailOn')}</p>
    </div>
  )
}

/* ═════ 幕 4：全量留痕 / scene 4: the full record ═════
   赢单与亏单同字号同排版：亏损不缩小不变灰——这个视觉决定就是产品的核心主张。
   Wins and losses identical in size and layout: that decision IS the claim. */
export function ScreenRecord({ t, on }: { t: T; on: boolean }) {
  const rows = [
    { sym: 'XAUUSD', side: 'sell' as const, win: true, pnl: '+186.40' },
    { sym: 'EURUSD', side: 'buy' as const, win: false, pnl: '-92.15' },
    { sym: 'GBPUSD', side: 'buy' as const, win: true, pnl: '+214.77' },
    { sym: 'AUDUSD', side: 'sell' as const, win: true, pnl: '+158.03' },
  ]
  return (
    <div className={`scr ${on ? 'on' : ''}`} data-scr="4">
      <div className="mb-[3cqw] border-b border-white/[0.08] pb-[3cqw]">
        <b className="text-[4.6cqw] font-bold text-white">{t('landing.scrRecordTitle')}</b>
      </div>
      <div className="flex flex-col">
        {rows.map((r) => (
          <div key={r.sym} className="js-rec flex items-center justify-between border-b border-white/[0.06] py-[3cqw] last:border-0">
            <div className="flex items-center gap-[2cqw]">
              <b className="text-[3.8cqw] font-bold text-white">{r.sym}</b>
              <span
                className={`rounded-[1.5cqw] border px-[1.6cqw] py-[0.6cqw] text-[2.5cqw] font-bold ${
                  r.side === 'buy' ? 'border-up/35 bg-up/10 text-up' : 'border-down/35 bg-down/10 text-down'
                }`}
              >
                {t(r.side === 'buy' ? 'landing.scrBuy' : 'landing.scrSell')}
              </span>
            </div>
            <div className="text-right">
              <div className={`num text-[4cqw] font-bold leading-none ${r.win ? 'text-up' : 'text-down'}`}>{r.pnl}</div>
              <div className={`mt-[0.8cqw] text-[2.5cqw] ${r.win ? 'text-up/70' : 'text-down/70'}`}>
                {t(r.win ? 'landing.scrWin' : 'landing.scrLoss')}
              </div>
            </div>
          </div>
        ))}
      </div>
      <p className="mt-auto border-t border-white/[0.08] pt-[3cqw] text-[2.8cqw] text-neutral-500">
        {t('landing.scrRecordFoot')}
      </p>
    </div>
  )
}
