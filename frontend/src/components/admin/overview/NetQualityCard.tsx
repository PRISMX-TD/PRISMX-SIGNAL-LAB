// 用户连接质量：此刻在线的连接延迟分布、最近 24 小时的趋势与断线次数、延迟最差的连接。
// 实时数据，不跟上面的时间范围走；每 30 秒自动刷新一次。口径见 backend services/net_quality.py。
// Live connection quality: current latency distribution, 24h trend with
// disconnects, and the worst connections. Not bound to the range picker;
// refreshes every 30s. Semantics in backend services/net_quality.py.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { adminApi } from '../../../api/client'
import type { AdminNetQuality } from '../../../api/types'
import { localizeApiError } from '../../../api/utils'
import { SkeletonLine } from '../../Skeleton'

const REFRESH_MS = 30_000
const SEG = [
  { k: 'good', cls: 'bg-up' },
  { k: 'fair', cls: 'bg-amber-300' },
  { k: 'poor', cls: 'bg-orange-400' },
  { k: 'unknown', cls: 'bg-neutral-600' },
] as const

export default function NetQualityCard() {
  const { t } = useTranslation()
  const [data, setData] = useState<AdminNetQuality | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = () =>
      adminApi.netQuality().then(
        (d) => { if (!cancelled) { setData(d); setError(null) } },
        (err: unknown) => { if (!cancelled) setError(err instanceof Error ? localizeApiError(err.message) : '') },
      )
    load()
    const id = window.setInterval(load, REFRESH_MS)
    return () => { cancelled = true; window.clearInterval(id) }
  }, [])

  const live = data?.live
  const total = live ? SEG.reduce((n, s) => n + live.dist[s.k], 0) : 0
  const hours = data?.hourly ?? []
  const maxSamples = Math.max(1, ...hours.map((h) => h.good + h.fair + h.poor))
  const disc24 = hours.reduce((n, h) => n + h.disconnects, 0)
  const conn24 = hours.reduce((n, h) => n + h.connects, 0)

  const Stat = ({ label, value }: { label: string; value: string }) => (
    <div className="rounded-inner border border-white/10 px-3 py-2">
      <div className="text-xs text-neutral-500">{label}</div>
      <div className="num mt-0.5 text-lg font-semibold text-white">{value}</div>
    </div>
  )

  return (
    <div className="glass mb-5 p-5">
      <h2 className="mb-1 text-sm font-semibold text-white">{t('admin.netQuality.title')}</h2>
      <p className="mb-4 text-xs text-neutral-500">
        {t('admin.netQuality.hint', { good: data?.thresholds.good ?? 150, fair: data?.thresholds.fair ?? 400 })}
      </p>

      {error !== null && !data && (
        <p className="text-xs text-down">{t('admin.netQuality.failed')}{error ? `：${error}` : ''}</p>
      )}
      {!data && error === null && <SkeletonLine height={120} />}

      {data && live && (
        <>
          <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label={t('admin.netQuality.online')} value={`${live.connections} / ${live.users}`} />
            <Stat label={t('admin.netQuality.p50')} value={live.p50 == null ? '—' : `${live.p50} ms`} />
            <Stat label={t('admin.netQuality.p90')} value={live.p90 == null ? '—' : `${live.p90} ms`} />
            <Stat label={t('admin.netQuality.disconnects24')} value={`${disc24} / ${conn24}`} />
          </div>

          {/* 当前分布条 / live distribution bar */}
          <div className="mb-1 flex h-3 overflow-hidden rounded-full bg-white/5">
            {total > 0 && SEG.map((s) => live.dist[s.k] > 0 && (
              <div key={s.k} className={s.cls} style={{ width: `${(live.dist[s.k] / total) * 100}%` }} />
            ))}
          </div>
          <div className="mb-5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-neutral-400">
            {SEG.map((s) => (
              <span key={s.k} className="flex items-center gap-1.5">
                <i className={`inline-block h-2 w-2 rounded-full ${s.cls}`} />
                {t(`admin.netQuality.${s.k}`)} <span className="num text-neutral-200">{live.dist[s.k]}</span>
              </span>
            ))}
            <span className="ml-auto">
              App <span className="num text-neutral-200">{live.byKind.app}</span> · Web <span className="num text-neutral-200">{live.byKind.web}</span>
            </span>
          </div>

          {/* 24 小时：每小时样本按好中差堆叠 / 24h stacked by quality */}
          <h3 className="mb-2 text-xs font-medium text-neutral-300">{t('admin.netQuality.trend')}</h3>
          <div className="mb-1 flex h-24 items-end gap-[3px]">
            {hours.map((h) => {
              const n = h.good + h.fair + h.poor
              const title = `${new Date(h.hour).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit' })}  ` +
                `${t('admin.netQuality.avg')} ${h.avgRtt ?? '—'}ms · ${t('admin.netQuality.poor')} ${n ? Math.round((h.poor / n) * 100) : 0}% · ` +
                `${t('admin.netQuality.disconnectsShort')} ${h.disconnects}`
              return (
                <div key={h.hour} title={title} className="flex h-full flex-1 flex-col justify-end">
                  <div className="flex flex-col-reverse overflow-hidden rounded-sm" style={{ height: `${(n / maxSamples) * 100}%` }}>
                    {(['good', 'fair', 'poor'] as const).map((k) => (
                      <div key={k} className={SEG.find((s) => s.k === k)!.cls} style={{ height: n ? `${(h[k] / n) * 100}%` : 0 }} />
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
          <div className="mb-5 flex justify-between text-[10px] text-neutral-500">
            <span>-24h</span><span>{t('admin.netQuality.now')}</span>
          </div>

          <h3 className="mb-2 text-xs font-medium text-neutral-300">{t('admin.netQuality.worst')}</h3>
          {data.worst.length === 0 ? (
            <p className="text-xs text-neutral-500">{t('admin.netQuality.noData')}</p>
          ) : (
            <table className="w-full text-left text-xs">
              <tbody>
                {data.worst.map((w, i) => (
                  <tr key={i} className="border-t border-white/5">
                    <td className="py-1.5 pr-2 text-neutral-200">{w.email ?? `#${w.userId}`}</td>
                    <td className="py-1.5 pr-2 text-neutral-500">{w.kind === 'app' ? 'App' : 'Web'}</td>
                    <td className="num py-1.5 pr-2 text-right text-orange-300">{w.rtt} ms</td>
                    <td className="num py-1.5 text-right text-neutral-500">{w.jit == null ? '' : `±${w.jit}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  )
}
