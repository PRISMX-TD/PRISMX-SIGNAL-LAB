// 交易使用：本期有成交的人数、成交笔数（都带对比），加一条按天成交笔数折线。
// Trading usage: distinct traders and fill count (with deltas) plus a daily fills line.
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { AdminOverview } from '../../../api/types'
import { DeltaBadge } from './HeadlineCards'
import LineChart, { SERIES_COLORS } from './LineChart'

export default function TradingUsageCard({ trading }: { trading: AdminOverview['trading'] }) {
  const { t } = useTranslation()
  const dates = useMemo(() => trading.daily.map((d) => d.date), [trading])
  const series = useMemo(
    () => [{ key: 'fills', label: t('admin.overview.trading.fills'), color: SERIES_COLORS[3], values: trading.daily.map((d) => d.fills) }],
    [trading, t],
  )
  return (
    <div className="glass p-5">
      <h2 className="mb-1 text-sm font-semibold text-white">{t('admin.overview.trading.title')}</h2>
      <p className="mb-3 text-xs text-neutral-500">{t('admin.overview.trading.hint')}</p>
      <div className="mb-4 grid grid-cols-2 gap-4">
        <div>
          <div className="text-xs text-neutral-400">{t('admin.overview.trading.traders')}</div>
          <div className="num mt-1 font-display text-2xl font-bold text-neutral-50">{trading.traders.current}</div>
          <DeltaBadge {...trading.traders} />
        </div>
        <div>
          <div className="text-xs text-neutral-400">{t('admin.overview.trading.fills')}</div>
          <div className="num mt-1 font-display text-2xl font-bold text-neutral-50">{trading.fills.current}</div>
          <DeltaBadge {...trading.fills} />
        </div>
      </div>
      <LineChart dates={dates} series={series} format={String} ariaLabel={t('admin.overview.trading.fills')}
                 peakLabel={(v) => t('admin.pageStats.peak', { value: v })} />
    </div>
  )
}
