// 转化时间线：注册 → 邮箱验证 → 首次付费 / MC 真实账户，按发生时间排；待审核、已驳回单独标出，
// 记在我名下的加一个「我的业绩」小标签。只显示事件，不显示金额（设计 §7）。
// Conversion timeline: register → verified → first paid / MC real account, in time order;
// pending review and rejected are marked, and ones credited to me get a "mine" chip. Events only,
// never amounts (design §7).
import { useTranslation } from 'react-i18next'
import { fmtDate } from '../../api/utils'
import type { SupportConversion } from '../../api/supportTypes'

const DOT: Record<string, string> = {
  confirmed: 'bg-up',
  pending_review: 'bg-amber-400',
  rejected: 'bg-neutral-600',
}

export default function ConversionTimeline({ items }: { items: SupportConversion[] }) {
  const { t } = useTranslation()
  if (items.length === 0) return <p className="text-xs text-neutral-500">{t('supportDesk.conversions.empty')}</p>
  return (
    <ol className="relative ml-1.5 space-y-3 border-l border-white/10 pl-4">
      {items.map((c) => (
        <li key={c.id} className="relative">
          <span className={`absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full ${DOT[c.status] ?? 'bg-neutral-500'}`} aria-hidden="true" />
          <div className="flex flex-wrap items-center gap-1.5 text-sm">
            <span className={c.status === 'rejected' ? 'text-neutral-500 line-through' : 'text-neutral-100'}>
              {t(`supportDesk.conversions.kind.${c.kind}`)}
            </span>
            {c.status !== 'confirmed' && (
              <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-neutral-400">{t(`supportDesk.conversions.status.${c.status}`)}</span>
            )}
            {c.source === 'manual' && (
              <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-neutral-400">{t('supportDesk.conversions.manual')}</span>
            )}
            {c.creditedToMe && (
              <span className="rounded bg-prism-600/20 px-1.5 py-0.5 text-[10px] text-prism-200">{t('supportDesk.conversions.mine')}</span>
            )}
          </div>
          <div className="num text-[11px] text-neutral-500">{fmtDate(c.createdAt)}</div>
        </li>
      ))}
    </ol>
  )
}
