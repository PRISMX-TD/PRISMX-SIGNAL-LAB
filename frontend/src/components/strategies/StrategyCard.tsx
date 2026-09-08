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
import type { CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { displaySymbol } from '../../api/utils'
import { symbolMeta } from '../../utils/symbolMeta'
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
  // 行序号：进场动画逐行错开 45ms。/ Row index: staggers the entrance by 45ms per row.
  index?: number
  onEdit: () => void
  onToggle: () => void
  onDelete: () => void
}

export default function StrategyCard({
  strategy, performance, backtestWinRate, fallbackName, index = 0, onEdit, onToggle, onDelete,
}: StrategyCardProps) {
  const { t } = useTranslation()
  const named = strategy.name?.trim()
  const meta = symbolMeta(strategy.symbol)

  // 实盘胜率的三态：足够样本给百分比 / 不足样本给"样本不足 (n/阈值)" / 还没判定过
  // 任何一笔给"暂无"。三态分开是必须的——把后两者合并成"0%"就是在说谎。
  // Three live-win-rate states: enough sample → a percentage; too small → "sample
  // too small (n/threshold)"; nothing resolved at all → "none yet". Collapsing
  // the last two into "0%" would simply be false.
  const liveNumeric = !!performance && performance.resolved > 0 && !performance.insufficientSample && performance.winRate != null
  const liveText = !performance
    ? null
    : performance.resolved === 0
      ? t('strategy.perfNoneYet')
      : !liveNumeric
        ? t('strategy.perfInsufficient', { n: performance.resolved, threshold: performance.sampleThreshold })
        : `${Math.round(performance.winRate! * 100)}%`

  return (
    <div className="stg-row" style={{ '--i': index } as CSSProperties}>
      <div className="stg-row-top">
        <span className="sym-ava" style={{ background: meta.color + '33', color: meta.ink }} aria-hidden="true">{meta.letter}</span>
        <div className="stg-row-name">
          <b className="font-display">{named || fallbackName}</b>
          <div className="stg-row-by">
            <span className="sym num">{displaySymbol(strategy.symbol)}</span>
            <span className="tag">{intervalLabel(strategy.interval)}</span>
            {named && <span>{fallbackName}</span>}
          </div>
        </div>
        <span className={`stg-state ${strategy.enabled ? 'on' : 'off'}`}>
          <i aria-hidden="true" />
          {strategy.enabled ? t('strategy.enabled') : t('strategy.disabled')}
        </span>
        <div className="stg-acts">
          <button type="button" onClick={onEdit} className="stg-act">{t('strategy.editStrategy')}</button>
          <button type="button" onClick={onToggle} className={`stg-act${strategy.enabled ? '' : ' accent'}`}>
            {strategy.enabled ? t('strategy.disable') : t('strategy.enable')}
          </button>
          <button type="button" onClick={onDelete} className="stg-act danger">
            {t('strategy.delete')}
          </button>
        </div>
      </div>

      {performance && (
        <div className="stg-perf">
          <span>
            <span className="k">{t('strategy.perfLiveWinRate')}</span>
            <span className={`v${liveNumeric ? ' num' : ' txt'}`}>{liveText}</span>
          </span>
          <span>
            <span className="k">{t('strategy.perfBacktestWinRate')}</span>
            <span className={`v${backtestWinRate == null ? ' txt' : ' num'}`}>
              {backtestWinRate == null ? t('strategy.perfNoBacktest') : `${Math.round(backtestWinRate * 100)}%`}
            </span>
          </span>
          {performance.avgRr != null && (
            <span>
              <span className="k">{t('simulator.avgRr')}</span>
              <span className="v num">{performance.avgRr.toFixed(2)}<small>R</small></span>
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
            <span>
              <span className="k">{t('strategy.maxLossStreakWindowed', { count: performance.streakWindow })}</span>
              <span className="v num">{performance.maxLossStreak}</span>
            </span>
          )}
          <span className="stg-perf-note num">
            {t('strategy.perfBreakdown', {
              wins: performance.wins,
              losses: performance.losses,
              timeouts: performance.timeouts,
              pending: performance.pending,
            })}
          </span>
        </div>
      )}
    </div>
  )
}
