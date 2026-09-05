import { useTranslation } from 'react-i18next'

// 上一页 / 下一页 + 「第 x/y 页 · 共 n 条」。此前在订单页、已平仓列表、回测明细、
// 回放模拟四处各抄一份同样的两颗按钮；改样式要改四遍。统一在这里，页码从 0 起。
// Prev / next buttons with the "page x of y · n items" caption. Was copy-pasted
// in four places (orders, closed trades, backtest trades, simulator); now one
// component. `page` is zero-based.
interface Props {
  page: number
  totalPages: number
  total: number
  onPrev: () => void
  onNext: () => void
  loading?: boolean
  className?: string
}

const BTN =
  'rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-neutral-300 transition hover:text-white disabled:cursor-not-allowed disabled:opacity-40'

export default function Pager({ page, totalPages, total, onPrev, onNext, loading = false, className = 'mt-3' }: Props) {
  const { t } = useTranslation()
  return (
    <div className={`flex items-center justify-between text-xs text-neutral-400 ${className}`.trim()}>
      <span>{loading ? t('common.loading') : t('orders.pageInfo', { page: page + 1, totalPages, total })}</span>
      <div className="flex items-center gap-2">
        <button type="button" onClick={onPrev} disabled={loading || page === 0} className={BTN}>
          {t('common.prevPage')}
        </button>
        <button type="button" onClick={onNext} disabled={loading || page + 1 >= totalPages} className={BTN}>
          {t('common.nextPage')}
        </button>
      </div>
    </div>
  )
}
