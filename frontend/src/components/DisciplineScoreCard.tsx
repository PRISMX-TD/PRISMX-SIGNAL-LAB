// 纪律分卡：回答"有没有按计划执行"，与赚不赚钱无关。只有自己能看到自己的。
//
// 2026-07-17 重新设计：总分旁边加一个"这是什么"小圆点按钮，点开一个用大白话
// 讲清楚三个维度怎么判的说明弹窗（面向完全不懂技术的普通交易者，不讲实现
// 细节，只讲"什么行为会被算作违规"）；总分下方加一句定性总结（"纪律很好/
// 还可以/需要加强"），比一个孤零零的数字更容易一眼看懂。
//
// Discipline Score card: whether the plan was followed, independent of P&L.
// Visible only to the user themself.
//
// 2026-07-17 redesign: a small "what is this" info button next to the score
// opens a plain-language modal explaining how each dimension is judged
// (written for a non-technical trader, describing what counts as a
// violation, not the implementation); a qualitative one-liner under the
// score ("great / okay / needs work") reads faster than a bare number alone.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { orderApi } from '../api/client'
import { useBackToClose } from '../utils/useBackToClose'
import type { DisciplineScore } from '../api/types'
import RadialGauge from './RadialGauge'

interface Props {
  // 只看这一个账号（订单页的账号标签驱动）；不传则是当前绑定的全部账号。
  // Narrow to one account (driven by the Orders page's account tab); omitted covers all currently-bound accounts.
  login?: string
  // 当前用户是否为 PRO——决定要不要展示逐维度明细区（后端已经按 plan 裁剪
  // 响应体，这里只是决定"没有 dimensions 时显示什么"）。
  // Whether the current user is PRO — decides whether to render the
  // per-dimension area (the backend already gates the response by plan;
  // this only decides what to show when `dimensions` is absent).
  isPro: boolean
}

const SVG_W = 300
const SVG_H = 60

const DIMENSION_KEYS = ['stopLoss', 'volume', 'exit'] as const
const DIMENSION_I18N: Record<(typeof DIMENSION_KEYS)[number], string> = {
  stopLoss: 'discipline.dimStop',
  volume: 'discipline.dimVolume',
  exit: 'discipline.dimExit',
}

function scoreColorClass(score: number): string {
  if (score >= 80) return 'text-up'
  if (score >= 50) return 'text-slate-300'
  return 'text-down'
}

function scoreBarClass(score: number): string {
  if (score >= 80) return 'bg-up'
  if (score >= 50) return 'bg-slate-400'
  return 'bg-down'
}

// 环形进度表用的颜色——三档配色跟上面两个函数是同一套阈值,只是要一个
// SVG stroke 能直接用的颜色值,不是 Tailwind 类名。
// Color for the radial gauge — same three-tier thresholds as the two
// functions above, just needs a raw color value SVG stroke can use directly,
// not a Tailwind class name.
function scoreGaugeColor(score: number): string {
  if (score >= 80) return 'var(--up)'
  if (score >= 50) return '#94a3b8'
  return 'var(--down)'
}

// 定性总结：一句话比孤零零的数字更快让人读懂"这算好还是不好"。
// Qualitative summary: a one-liner reads faster than a bare number alone.
function scoreLevelKey(score: number): string {
  if (score >= 80) return 'discipline.levelGreat'
  if (score >= 50) return 'discipline.levelOk'
  return 'discipline.levelPoor'
}

function buildTrendPoints(trend: Array<{ date: string; total: number | null }>): string {
  const withValues = trend.filter((t) => t.total != null) as Array<{ date: string; total: number }>
  if (withValues.length < 2) return ''
  const stepX = SVG_W / (withValues.length - 1)
  return withValues
    .map((t, i) => {
      const x = Math.round(stepX * i)
      const y = Math.round(SVG_H - (t.total / 100) * SVG_H)
      return `${x},${y}`
    })
    .join(' ')
}

// 说明弹窗：用大白话讲清楚三个维度各自在查什么，面向完全不懂技术的普通
// 交易者——只讲"什么行为算违规"，不讲后端实现。复用全站统一的抽屉式弹窗
// 样式（.slide-overlay/.slide-sheet，移动端自动变成贴底全屏抽屉、自带
// safe-area-inset 内边距）。
//
// 纯展示组件，不在这里调用 useBackToClose——那个 hook 要挂在"本来就一直
// 挂载着"的组件上，靠传入的 isOpen 布尔值变化去驱动 pushState/popstate；
// 如果反过来把它放进一个"只在打开时才被整个创建出来"的子组件里、又传死
// 一个 true，会在 React 18 StrictMode 的开发模式下撞上"挂载→（诊断用的）
// 卸载→再挂载"这套模拟流程——cleanup 阶段那次自我触发的 history.back()
// 是异步的，等它真正落地时，栈顶已经变成第二次挂载登记的那个新 id，第二次
// 挂载自己的 popstate 监听器会把这次事件误判成"该我关了"，导致弹窗一开
// 出来就被自己关掉（本地开发这么点了一次就复现，生产构建没有这个双重挂载
// 诊断流程，不会触发，但开发体验会一直很诡异，所以还是按现成的正确写法
// 来）。全站其它弹窗（NotificationBell、UserMenu、ChartsPage 的指标设置等）
// 无一例外都是把 useBackToClose 放在常驻组件里，见 DisciplineScoreCard
// 本体的调用。
//
// Help modal: plain-language explanation of what each dimension checks, for
// a non-technical trader — what counts as a violation, not the backend
// implementation. Reuses the site's shared sheet-modal styling
// (.slide-overlay/.slide-sheet, full-width bottom sheet with safe-area-inset
// padding on mobile).
//
// Presentational only — useBackToClose is NOT called here. That hook must
// live on a component that's already permanently mounted, driven by a
// changing `isOpen` boolean to trigger pushState/popstate. Calling it instead
// inside a child that's only ever *created* while open (passing a hardcoded
// `true`) collides with React 18 StrictMode's dev-only mount→(diagnostic)
// unmount→remount cycle: the self-triggered `history.back()` from the fake
// cleanup fires its popstate asynchronously, and by the time it lands the
// stack's top is the *second* mount's id — whose own listener then wrongly
// concludes "this is my close" and shuts the modal immediately after it
// opens (reproduced locally on the very first click). Production builds
// never run that diagnostic double-mount, so this wouldn't surface for real
// users, but the dev experience stays broken — better to follow the
// established pattern. Every other modal in the app (NotificationBell,
// UserMenu, the charts page's indicator settings, etc.) calls
// useBackToClose from the permanent parent — see the call in
// DisciplineScoreCard itself below.
function DisciplineHelpModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()

  const sections: Array<{ titleKey: string; bodyKey: string }> = [
    { titleKey: 'discipline.helpStopTitle', bodyKey: 'discipline.helpStopBody' },
    { titleKey: 'discipline.helpVolumeTitle', bodyKey: 'discipline.helpVolumeBody' },
    { titleKey: 'discipline.helpExitTitle', bodyKey: 'discipline.helpExitBody' },
  ]

  return (
    <div className="slide-overlay" onClick={onClose}>
      {/* 桌面端加宽到 480px 用 Tailwind 的 sm: 前缀，不要用内联 style——
          .slide-sheet 自己的移动端媒体查询（<640px 变成贴底全屏抽屉）靠的是
          纯 CSS 类选择器，内联 style 的优先级会盖过媒体查询把它废掉，这是
          指标设置弹窗已经踩过、写进代码注释的坑。
          Widen to 480px on desktop via Tailwind's sm: prefix, never an inline
          style — .slide-sheet's own mobile media query (a full-width bottom
          sheet below 640px) relies on a plain CSS class selector, and an
          inline style's specificity would clobber it. Already a documented
          lesson from the indicator settings modal. */}
      <div className="slide-sheet sm:w-[480px]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-bold text-white">{t('discipline.helpTitle')}</h3>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-white" aria-label={t('common.close')}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
          </button>
        </div>

        <p className="mt-3 text-sm leading-relaxed text-slate-300">{t('discipline.helpIntro')}</p>

        <div className="mt-4 flex flex-col gap-3">
          {sections.map((s) => (
            <div key={s.titleKey} className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
              <h4 className="text-sm font-semibold text-slate-100">{t(s.titleKey)}</h4>
              <p className="mt-1.5 text-xs leading-relaxed text-slate-400">{t(s.bodyKey)}</p>
            </div>
          ))}
        </div>

        <p className="mt-4 text-xs leading-relaxed text-slate-500">{t('discipline.helpNote')}</p>

        <button onClick={onClose} className="btn-primary mt-5 w-full py-2.5 text-sm">
          {t('discipline.helpGotIt')}
        </button>
      </div>
    </div>
  )
}

export default function DisciplineScoreCard({ login, isPro }: Props) {
  const { t } = useTranslation()
  const [data, setData] = useState<DisciplineScore | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)
  // 挂在这个常驻组件上，不要挪进只在打开时才创建的 DisciplineHelpModal——
  // 见该组件顶部注释里详细的原因。
  // Lives on this permanently-mounted component, not inside the
  // only-created-while-open DisciplineHelpModal — see that component's
  // header comment for the detailed reason.
  useBackToClose(helpOpen, () => setHelpOpen(false))

  useEffect(() => {
    let mounted = true
    const load = () => {
      orderApi.discipline(login).then((r) => { if (mounted) setData(r) }).catch(() => {})
    }
    // 切换账号标签时先清空旧数字再拉新的，避免短暂显示"上一个账号的纪律分"。
    // Clear the stale number before refetching on an account switch, so the
    // previous account's score doesn't flash before the new one loads.
    setData(null)
    load()
    const timer = window.setInterval(() => {
      if (!document.hidden) load()
    }, 45_000)
    const onVisible = () => { if (!document.hidden) load() }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      mounted = false
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [login])

  const trendPoints = data ? buildTrendPoints(data.trend) : ''

  const card = (
    <section className="card glass p-5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <h3 className="text-lg font-bold text-white">{t('discipline.title')}</h3>
          <button
            type="button"
            onClick={() => setHelpOpen(true)}
            className="flex h-[18px] w-[18px] items-center justify-center rounded-full border border-white/20 text-[10px] font-bold text-slate-400 transition hover:border-prism-400/60 hover:text-prism-300"
            aria-label={t('discipline.helpButton')}
          >
            ?
          </button>
        </div>
        <span className="text-[11px] text-slate-500">{t('discipline.windowHint', { n: data?.windowDays ?? 90 })}</span>
      </div>

      {data == null || data.total == null ? (
        <div className="mt-3 py-3 text-center text-sm text-slate-500">{t('discipline.noData')}</div>
      ) : (
        <>
          <div className="mt-4 flex items-center gap-4">
            <RadialGauge value={data.total} color={scoreGaugeColor(data.total)} size={116} strokeWidth={10}>
              <b className={`num font-bold text-3xl ${scoreColorClass(data.total)}`}>{Math.round(data.total)}</b>
              <span className={`mt-0.5 text-center text-[10px] font-medium leading-tight ${scoreColorClass(data.total)}`}>
                {t(scoreLevelKey(data.total))}
              </span>
            </RadialGauge>
            {trendPoints && (
              <div className="flex-1">
                <span className="text-[11px] uppercase tracking-wide text-slate-500">{t('discipline.trendLabel')}</span>
                <svg viewBox={`0 0 ${SVG_W} ${SVG_H}`} className="mt-1.5 w-full text-prism-300" preserveAspectRatio="none">
                  <polyline
                    fill="none" stroke="currentColor" strokeWidth="2"
                    strokeLinecap="round" strokeLinejoin="round" points={trendPoints}
                    vectorEffect="non-scaling-stroke"
                  />
                </svg>
              </div>
            )}
          </div>

          {data.dimensions ? (
            <div className="mt-4 flex flex-col gap-3">
              {DIMENSION_KEYS.map((key) => {
                const dim = data.dimensions![key]
                return (
                  <div key={key}>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-slate-300">{t(DIMENSION_I18N[key])}</span>
                      {dim.score == null ? (
                        <span className="text-slate-600">{t('discipline.insufficient')}</span>
                      ) : (
                        <span className="text-slate-500">{t('discipline.violations', { v: dim.violations, n: dim.samples })}</span>
                      )}
                    </div>
                    <div className="mt-1.5 h-1.5 rounded-full bg-white/[0.06]">
                      {dim.score != null && (
                        <div className={`h-1.5 rounded-full ${scoreBarClass(dim.score)}`} style={{ width: `${dim.score}%` }} />
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          ) : !isPro ? (
            <div className="mt-3 rounded-lg border border-prism-500/20 bg-prism-600/5 p-3 text-center text-xs text-slate-400">
              {t('discipline.upgradeHint')}{' '}
              <Link to="/upgrade" className="text-prism-300 underline hover:text-prism-200">
                {t('winrate.viewDetail')}
              </Link>
            </div>
          ) : null}
        </>
      )}
      <p className="mt-3 text-[10px] text-slate-600">{t('discipline.disclaimer')}</p>
    </section>
  )

  // 弹窗必须挂在 .card.glass 这个 section 之外——.glass 用了 backdrop-filter，
  // 会给里面的 position:fixed 后代建立一个新的包含块，导致弹窗被这张卡片的
  // 尺寸/位置困住，而不是覆盖整个视口，看起来就像被其它卡片挡住/切掉一样。
  // Must render outside the .card.glass section — .glass sets backdrop-filter,
  // which creates a new containing block for any position:fixed descendant.
  // Left inside, the overlay gets trapped to this card's box instead of
  // covering the full viewport, which is exactly why it looked clipped by
  // neighboring cards.
  return (
    <>
      {card}
      {helpOpen && <DisciplineHelpModal onClose={() => setHelpOpen(false)} />}
    </>
  )
}
