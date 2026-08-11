// 一张策略卡片：名称、品种/周期标签、启用状态、实盘与回测胜率对比、操作按钮。
//
// 对比是本次改造的目标之一（spec 验收标准第 8 条）：启用之后用户此前完全看不到
// 策略的真实表现，只能凭回测时那个数字。样本不足时显示"样本不足"而不显示百分比
// ——1 胜 0 负呈现成 100% 会直接让人加仓。阈值取后端返回的 sampleThreshold，
// 前端不硬编码 10。
//
// One strategy card: name, symbol/interval tags, enabled state, live-vs-backtest
// win rate, action buttons.
//
// The comparison is one of this redesign's goals (spec acceptance criterion 8):
// after enabling a strategy the user previously had no view of its real
// behaviour, only the number from the backtest. Below the threshold no
// percentage is shown — 1-0 rendered as 100% talks people into sizing up. The
// threshold comes from the backend's sampleThreshold; it is not hardcoded here.
import { useTranslation } from 'react-i18next'
import { displaySymbol } from '../../api/utils'
import { intervalLabel } from './conditionTypes'
import type { StrategyPerformance, UserStrategy } from '../../api/types'

export interface StrategyCardProps {
  strategy: UserStrategy
  // 实盘绩效。null = 还没拉到（或拉取失败），此时不显示对比区，而不是显示 0%。
  // Live performance; null means not fetched yet (or the fetch failed), in which
  // case the comparison block is omitted rather than shown as 0%.
  performance: StrategyPerformance | null
  // 本次会话里对这个策略跑过的最近一次回测胜率（0-1）。后端不存回测快照
  // （Task 12 已说明理由），所以只有"这次打开页面跑过"才有值。
  // The win rate (0-1) of the most recent backtest run for this strategy in this
  // session. No backtest snapshots are persisted server-side, so this only has a
  // value if a run happened since the page opened.
  backtestWinRate: number | null
  // 策略名为空时显示的回退名称，由页面按模板算好传入（模板可能为 null）。
  // Fallback display name when the strategy is unnamed, computed by the page
  // (template may be null).
  fallbackName: string
  onEdit: () => void
  onToggle: () => void
  onDelete: () => void
}

export default function StrategyCard({
  strategy, performance, backtestWinRate, fallbackName, onEdit, onToggle, onDelete,
}: StrategyCardProps) {
  const { t } = useTranslation()
  const btnClass = 'rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-neutral-300 transition hover:text-white'
  const named = strategy.name?.trim()

  // 实盘胜率的三态：足够样本给百分比 / 不足样本给"样本不足 (n/阈值)" / 还没判定过
  // 任何一笔给"暂无"。三态分开是必须的——把后两者合并成"0%"就是在说谎。
  // Three live-win-rate states: enough sample → a percentage; too small → "sample
  // too small (n/threshold)"; nothing resolved at all → "none yet". Collapsing
  // the last two into "0%" would simply be false.
  const liveText = !performance
    ? null
    : performance.resolved === 0
      ? t('strategy.perfNoneYet')
      : performance.insufficientSample || performance.winRate == null
        ? t('strategy.perfInsufficient', { n: performance.resolved, threshold: performance.sampleThreshold })
        : `${Math.round(performance.winRate * 100)}%`

  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-neutral-100">{named || fallbackName}</span>
          {named && <span className="text-xs text-neutral-500">{fallbackName}</span>}
          <span className="tag bg-white/5 text-neutral-400">{displaySymbol(strategy.symbol)}</span>
          <span className="tag bg-white/5 text-neutral-400">{intervalLabel(strategy.interval)}</span>
          <span className={`tag ${strategy.enabled ? 'bg-up/15 text-up' : 'bg-white/5 text-neutral-500'}`}>
            {strategy.enabled ? t('strategy.enabled') : t('strategy.disabled')}
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={onEdit} className={btnClass}>{t('strategy.editStrategy')}</button>
          <button type="button" onClick={onToggle} className={btnClass}>
            {strategy.enabled ? t('strategy.disable') : t('strategy.enable')}
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="rounded-lg border border-down/30 bg-down/10 px-3 py-1.5 text-xs text-down transition hover:bg-down/20"
          >
            {t('strategy.delete')}
          </button>
        </div>
      </div>

      {performance && (
        <div className="mt-2.5 flex flex-wrap items-center gap-x-5 gap-y-1.5 border-t border-white/5 pt-2.5 text-[11px]">
          <span className="text-neutral-500">
            {t('strategy.perfLiveWinRate')} <span className="font-mono text-neutral-200">{liveText}</span>
          </span>
          <span className="text-neutral-500">
            {t('strategy.perfBacktestWinRate')}{' '}
            <span className="font-mono text-neutral-200">
              {backtestWinRate == null ? t('strategy.perfNoBacktest') : `${Math.round(backtestWinRate * 100)}%`}
            </span>
          </span>
          <span className="font-mono text-neutral-500">
            {t('strategy.perfBreakdown', {
              wins: performance.wins,
              losses: performance.losses,
              timeouts: performance.timeouts,
              pending: performance.pending,
            })}
          </span>
          {performance.avgRr != null && (
            <span className="text-neutral-500">
              {t('simulator.avgRr')} <span className="font-mono text-neutral-200">{performance.avgRr.toFixed(2)}R</span>
            </span>
          )}
          {performance.maxLossStreak > 0 && (
            // 用带窗口的文案而非 simulator.maxLossStreak：卡片的连亏只回看最近
            // streakWindow 笔已判定信号，不是全历史。回测面板与模拟器的同名数字
            // 是全量的，所以那两处仍用原文案。
            // Windowed label, not simulator.maxLossStreak: the card's streak looks
            // back only streakWindow resolved signals, not all history. The
            // backtest panel and simulator show a full-history figure, so they
            // keep the original label.
            <span className="text-neutral-500">
              {t('strategy.maxLossStreakWindowed', { count: performance.streakWindow })}{' '}
              <span className="font-mono text-neutral-200">{performance.maxLossStreak}</span>
            </span>
          )}
        </div>
      )}
    </div>
  )
}
