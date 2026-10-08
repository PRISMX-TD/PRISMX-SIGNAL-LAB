// 完整性报告（§1.14）：有标记的参赛条目（对冲嫌疑 / 出入金 / 账户已撤销 / 非直连）+
// 对冲嫌疑配对。只读；处理（取消资格、隐藏名字）回到参赛者表里做。
// Integrity report (§1.14): flagged entries plus suspected hedge pairs. Read-only; act on
// them (disqualify, hide name) in the participants table.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import AdminSheet from '../AdminSheet'
import { SkeletonLine } from '../../Skeleton'
import { adminApi } from '../../../api/client'
import { fmtTime, localizeApiError } from '../../../api/utils'
import type { CompetitionIntegrity } from '../../../api/types'
import FlagKinds from './FlagKinds'
import { formatFlagDetail } from './promoLogic'

export default function IntegrityModal({ compId, onClose }: { compId: string; onClose: () => void }) {
  const { t } = useTranslation()
  const [data, setData] = useState<CompetitionIntegrity | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    adminApi
      .competitionIntegrity(compId)
      .then((d) => {
        if (alive) setData(d)
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? localizeApiError(err.message) : String(err))
      })
    return () => {
      alive = false
    }
  }, [compId])

  return (
    <AdminSheet title={t('admin.competitionPromo.integrity')} onClose={onClose} widthClass="sm:w-[680px]">
      {error && <p className="mt-3 text-sm text-down">{error}</p>}
      {!data && !error && (
        <div className="mt-4 space-y-2">
          <SkeletonLine height={14} />
          <SkeletonLine width="70%" height={14} />
        </div>
      )}
      {data && (
        <div className="mt-4 space-y-5">
          <section>
            <h4 className="text-sm font-semibold text-neutral-200">{t('admin.competitionPromo.flagsTitle')}</h4>
            {data.flags.length === 0 ? (
              <p className="mt-2 text-sm text-neutral-400">{t('admin.competitionPromo.integrityEmpty')}</p>
            ) : (
              <div className="mt-2 overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="text-neutral-500">
                      <th className="py-1.5 pr-4 font-medium">{t('admin.competitionPromo.colLogin')}</th>
                      <th className="py-1.5 pr-4 font-medium">{t('admin.competitionPromo.colUser')}</th>
                      <th className="py-1.5 pr-4 font-medium">{t('admin.competitionPromo.colKinds')}</th>
                      <th className="py-1.5 font-medium">{t('admin.competitionPromo.colDetail')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.flags.map((f) => (
                      <tr key={f.participantId} className="border-t border-white/5 align-top">
                        <td className="num py-1.5 pr-4 text-neutral-300">{f.login}</td>
                        <td className="py-1.5 pr-4 text-neutral-200">{f.displayName || '—'}</td>
                        <td className="py-1.5 pr-4">
                          <FlagKinds kinds={f.kinds} />
                        </td>
                        <td className="py-1.5 text-neutral-400">{formatFlagDetail(f.detail) || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <section>
            <h4 className="text-sm font-semibold text-neutral-200">{t('admin.competitionPromo.pairsTitle')}</h4>
            {data.pairs.length === 0 ? (
              <p className="mt-2 text-sm text-neutral-400">{t('admin.competitionPromo.pairsEmpty')}</p>
            ) : (
              <div className="mt-2 overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="text-neutral-500">
                      <th className="py-1.5 pr-4 font-medium">{t('admin.competitionPromo.colA')}</th>
                      <th className="py-1.5 pr-4 font-medium">{t('admin.competitionPromo.colB')}</th>
                      <th className="py-1.5 pr-4 font-medium">{t('admin.competitionPromo.colSymbol')}</th>
                      <th className="py-1.5 font-medium">{t('admin.competitionPromo.colAt')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.pairs.map((p, i) => (
                      <tr key={`${p.a.participantId}-${p.b.participantId}-${p.symbol}-${p.at ?? i}`} className="border-t border-white/5">
                        <td className="num py-1.5 pr-4 text-neutral-300">{p.a.login} {p.a.side}{p.sameUser ? ' ⚠' : ''}</td>
                        <td className="num py-1.5 pr-4 text-neutral-300">{p.b.login} {p.b.side}</td>
                        <td className="py-1.5 pr-4 text-neutral-200">{p.symbol}</td>
                        <td className="num py-1.5 text-neutral-400">{fmtTime(p.at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}
    </AdminSheet>
  )
}
