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
import BadgeIcon from '../badges/BadgeIcon'
import RankCoin from '../badges/RankCoin'

type T = (k: string, opts?: Record<string, unknown>) => string

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
    case 'growth':
      return (
        <svg viewBox="0 0 24 24" {...p}>
          <circle cx="12" cy="9" r="6" />
          <path d="M8.5 14.5L7 22l5-3 5 3-1.5-7.5" />
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
    { id: 'growth', k: 'nav.growth' },
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
    <div className="sig-card rounded-[3.4cqw] border border-white/[0.09] bg-white/[0.035] p-[3.8cqw]">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-[2cqw]">
          <b className="sig-sym text-[4.6cqw] font-bold text-white">{sym}</b>
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
          <div className="sig-rr num text-[4.4cqw] font-bold leading-none text-up">{rr}</div>
          <div className="mt-[0.8cqw] text-[2.9cqw] uppercase text-neutral-500">{t('landing.scrRr')}</div>
        </div>
      </div>

      {/* 三格 tile：中性入场 / 红染止损 / 绿染止盈（同 .tile-sl/.tile-tp）
          Three tiles: neutral entry, red-tinted SL, green-tinted TP. */}
      <div className="sig-tiles mt-[3cqw] grid grid-cols-3 gap-[1.8cqw]">
        <div className="rounded-[2.6cqw] border border-white/[0.09] bg-white/[0.03] px-[1cqw] py-[2cqw] text-center">
          <div className="sig-key text-[3.1cqw] text-neutral-500">{t('landing.scrEntry')}</div>
          <div className="sig-val num mt-[0.8cqw] text-[3.4cqw] font-bold text-white">{entry}</div>
        </div>
        <div className="rounded-[2.6cqw] border border-down/40 bg-down/[0.07] px-[1cqw] py-[2cqw] text-center">
          <div className="sig-key text-[3.1cqw] text-neutral-500">{t('landing.scrSl')}</div>
          <div className="sig-val num mt-[0.8cqw] text-[3.4cqw] font-bold text-down">{sl}</div>
        </div>
        <div className="rounded-[2.6cqw] border border-up/40 bg-up/[0.07] px-[1cqw] py-[2cqw] text-center">
          <div className="sig-key text-[3.1cqw] text-neutral-500">{t('landing.scrTp')}</div>
          <div className="sig-val num mt-[0.8cqw] text-[3.4cqw] font-bold text-up">{tp}</div>
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
          {/* 垂直居中用 top 定位而不是 -translate-y-1/2：transform 是单一属性，
              而滑块的横向动画要写 transform: translateX(...)，会把用于居中的那半个
              transform 整个覆盖掉——滑块因此从轨道里掉出去（steps 模式实测）。
              用 top:50% 配负 margin（滑块高的一半）而不是固定的上下内缩：top 的百分比是相对
              内边距框算的，而轨道有 1px 边框，固定内缩会让上下间隙差 2px（实测 7/5）。
              负 margin 与边框无关，永远精确对称。
              Centred with top rather than -translate-y-1/2: transform is a single
              property, and the knob's horizontal animation writes
              transform: translateX(...), which wipes out the half of the transform
              doing the centring - measured in steps mode, the knob fell out of the
              track. Using top:50% with a negative margin of half the knob height rather than a
              fixed inset: percentage top resolves against the padding box, and the
              track has a 1px border, so a fixed inset left the gaps 2px apart
              (measured 7 against 5). A negative margin is border-agnostic and always
              exactly symmetric. */}
          <div className="js-knob absolute left-[1.5cqw] top-1/2 -mt-[5.5cqw] grid h-[11cqw] w-[11cqw] place-items-center rounded-[3cqw] bg-prism-600 text-[4.6cqw] font-bold text-white">
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

/* ═════ 幕 3：全量留痕 / scene 3: the full record ═════
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
    <div className={`scr ${on ? 'on' : ''}`} data-scr="3">
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

/* ═════ 幕 0（Hero）：段位揭晓 / scene 0: the rank reveal ═════
   刻意不复刻成就页——首屏要的是「加冕」的分量，不是任务清单。一枚佩戴的默认
   勋章立在光锥里，脚下有倒影，两侧各一枚副戴退到暗处；下面只有等级药丸、称号、
   一句「距下一级」和六级关卡轨，其余全部让位。勋章、称号、文案都是站内真实资产
   （BadgeIcon / gamification 文案键），换掉的只是陈列方式。
   Deliberately not a copy of the achievements page: the opening needs the weight
   of a coronation, not a checklist. The worn default badge stands in a light cone
   with its reflection, the two side badges recede into the dark; below it only the
   level pill, the title, a "to next tier" line and the six-tier rail. Assets are
   the product's own; only the staging changes. */
const RANK_LEVELS = ['novice', 'junior', 'elite', 'senior', 'chief', 'legend'] as const
const RANK_NOW = 5

export function ScreenRank({ t, on }: { t: T; on: boolean }) {
  return (
    <div className={`scr scr-rank ${on ? 'on' : ''}`} data-scr="0">
      <div className="rk-stage">
        <span className="rk-cone" aria-hidden />
        <span className="rk-side rk-side-l cq-svg" aria-hidden><BadgeIcon id="winning_hand" tier={2} earned size={64} /></span>
        <span className="rk-side rk-side-r cq-svg" aria-hidden><BadgeIcon id="arena" tier={1} earned size={64} /></span>
        <div className="rk-hero">
          <span className="cq-svg block w-[44cqw]"><BadgeIcon id="comp_back_to_back" earned size={160} spin /></span>
          <span className="rk-refl cq-svg block w-[44cqw]" aria-hidden><BadgeIcon id="comp_back_to_back" earned size={160} /></span>
        </div>
        <span className="rk-floor" aria-hidden />
      </div>
      <div className="rk-title">
        <span className="rk-lv num">L{RANK_NOW}</span>
        <b>{t('gamification.titles.chief')}</b>
        <span className="rk-sub">
          {t('gamification.remainingToNext', { count: 2 })} · {t('gamification.titles.legend')}
        </span>
      </div>
      {/* 铭牌：四个大号等宽数字压在一圈发丝线框里，像奖杯下面那块刻字的牌。
          数字全部落在首席这一级的门槛之上（1000 笔 / 1000 手 / 胜率 > 55%），
          连续盈利 6 个月对应常青 · 银。示例数据。
          The plaque: four large tabular figures inside a hairline frame, like the
          engraved plate under a trophy. Every figure clears the Chief tier's
          thresholds; the six-month streak matches Evergreen silver. Sample data. */}
      <dl className="rk-plaque">
        <div>
          <dt>{t('gamification.winRateCard.combinedShort')}</dt>
          <dd className="num">58.4<small>%</small></dd>
        </div>
        <div>
          <dt>{t('landing.scrStatTrades')}</dt>
          <dd className="num">1,246<small>{t('landing.scrUnitTrades')}</small></dd>
        </div>
        <div>
          <dt>{t('landing.scrStatLots')}</dt>
          <dd className="num">1,137<small>{t('landing.scrUnitLots')}</small></dd>
        </div>
        <div>
          <dt>{t('landing.scrStatStreak')}</dt>
          <dd className="num">6<small>{t('landing.scrUnitMonths')}</small></dd>
        </div>
      </dl>
      <ol className="rk-rail" aria-label={t('gamification.levelLabel')}>
        {RANK_LEVELS.map((k, i) => {
          const lv = i + 1
          const cls = lv < RANK_NOW ? 'on' : lv === RANK_NOW ? 'on cur' : ''
          return (
            <li key={k} className={cls}>
              <i aria-hidden />
              <b>{t(`gamification.levelShort.${k}`)}</b>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

/* ═════ 幕 4：上榜 / scene 4: on the board ═════
   镜像 /leaderboard 的榜单行：名次币（前三真实 RankCoin）、打码昵称 + 账户号、
   收益率；「你」那一行紫底高亮（同 .lb-row.me）。底部一条勋章到手的提示，
   用真实 BadgeIcon——这一幕是整段叙事的落点：一笔交易最终变成名次和勋章。
   Mirrors the /leaderboard rows: rank coin (real RankCoin for the top three),
   masked name + account, return; the "you" row highlighted as .lb-row.me. A
   badge-earned toast closes the scene: one trade has become rank and honor. */
export function ScreenBoard({ t, on }: { t: T; on: boolean }) {
  const rows = [
    { r: 1, n: 'Mo***ch', a: '600 402', s: '+14.2%' },
    { r: 2, n: 'Ka***en', a: '600 118', s: '+9.4%' },
    { r: 3, n: 'Li***ng', a: '600 077', s: '+7.8%' },
    { r: 4, n: 'Wi***ow', a: '600 233', s: '+6.1%' },
    { r: 7, n: 'Tr***er', a: '600 231', s: '+4.9%', me: true },
  ]
  return (
    <div className={`scr ${on ? 'on' : ''}`} data-scr="4">
      <div className="mb-[2.4cqw] flex items-baseline justify-between border-b border-white/[0.08] pb-[3cqw]">
        <b className="text-[4.6cqw] font-bold text-white">{t('landing.scrBoardTitle')}</b>
        <span className="text-[2.7cqw] text-neutral-500">W37</span>
      </div>
      <div className="flex flex-col">
        {rows.map((x) => (
          <div
            key={x.r}
            className={`js-row flex items-center gap-[2.6cqw] border-b border-white/[0.06] py-[2.6cqw] last:border-0 ${
              x.me ? '-mx-[2cqw] rounded-[2cqw] bg-prism-600/20 px-[2cqw]' : ''
            }`}
          >
            <span className="grid w-[7.5cqw] flex-none place-items-center">
              {x.r <= 3 ? (
                <span className="cq-svg block w-[7cqw]"><RankCoin rank={x.r} size={28} /></span>
              ) : (
                <b className={`num text-[3.8cqw] ${x.me ? 'text-prism-300' : 'text-neutral-500'}`}>{x.r}</b>
              )}
            </span>
            <span className="min-w-0 flex-1 truncate text-[3.4cqw] text-white">
              <b className="font-semibold">{x.n}</b>
              <span className="num ml-[1.6cqw] text-[2.7cqw] text-neutral-500">{x.a}</span>
              {x.me && <span className="ml-[1.6cqw] text-[2.7cqw] font-semibold text-prism-300">{t('landing.scrBoardYou')}</span>}
            </span>
            <span className="num text-[3.6cqw] font-bold text-up">{x.s}</span>
          </div>
        ))}
      </div>
      <p className="mt-[2.4cqw] text-[2.8cqw] text-neutral-500">{t('landing.scrBoardGap')}</p>
      <div className="js-toast mt-auto flex items-center gap-[3cqw] rounded-[3cqw] border border-prism-400/40 bg-prism-600/20 px-[3.4cqw] py-[2.6cqw]">
        <span className="cq-svg w-[10cqw] flex-none"><BadgeIcon id="board_return" tier={1} earned /></span>
        <div className="min-w-0">
          <div className="text-[2.6cqw] uppercase tracking-[0.14em] text-prism-300">{t('landing.scrToast')}</div>
          <b className="block truncate text-[3.6cqw] font-bold text-white">{t('landing.scrToastBadge')}</b>
        </div>
      </div>
    </div>
  )
}
