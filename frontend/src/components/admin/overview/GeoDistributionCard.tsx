// 总览页「用户分布」：左地图、右排行，窄屏上下排。自己拉数据，与总览请求各自成败；
// 范围切换独立于总览页的时间范围（spec §5.2）。
// The "where users are" card: map left, ranking right (stacked on narrow screens).
// Self-fetching; its scope switch is independent of the overview range picker.
import { Suspense, lazy, useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { adminApi } from '../../../api/client'
import type { AdminGeoDistribution, GeoScope } from '../../../api/types'
import { localizeApiError } from '../../../api/utils'
import { SkeletonLine } from '../../Skeleton'
import { TOP_N, cityLabel, countryLabel, unknownCount } from './geoLogic'

const GeoMap = lazy(() => import('./GeoMap'))

const SCOPES: GeoScope[] = ['all', '7d', '30d']
type View = 'countries' | 'cities'

export default function GeoDistributionCard() {
  const { t, i18n } = useTranslation()
  const lang = i18n.resolvedLanguage ?? i18n.language
  const [scope, setScope] = useState<GeoScope>('all')
  const [data, setData] = useState<AdminGeoDistribution | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<View>('countries')
  const [mapMode, setMapMode] = useState<'world' | 'cn'>('world')
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let cancelled = false
    setError(null)
    setData(null)
    adminApi.geoDistribution(scope).then(
      (d) => { if (!cancelled) setData(d) },
      (err: unknown) => { if (!cancelled) setError(err instanceof Error ? localizeApiError(err.message) : '') },
    )
    return () => { cancelled = true }
  }, [scope, nonce])

  const retry = useCallback(() => setNonce((n) => n + 1), [])

  const pill = (active: boolean) =>
    `rounded-full px-3 py-1 text-[11px] transition ${
      active ? 'bg-prism-500/25 text-prism-100 ring-1 ring-prism-400/40' : 'text-neutral-400 hover:text-neutral-200'
    }`

  const rows = data
    ? view === 'countries'
      ? data.countries.slice(0, TOP_N).map((c) => ({ key: `${c.code ?? c.name}`, label: countryLabel(c, lang), count: c.count }))
      : data.cities.slice(0, TOP_N).map((c) => ({ key: `${c.countryCode}-${c.province}-${c.city}`, label: cityLabel(c, lang), count: c.count }))
    : []
  const top = rows.length ? rows[0].count : 0

  return (
    <div className="glass mb-5 p-5">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-white">{t('admin.overview.geo.title')}</h2>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('admin.overview.geo.scopeLabel')}>
          {SCOPES.map((s) => (
            <button key={s} type="button" aria-pressed={scope === s} onClick={() => setScope(s)} className={pill(scope === s)}>
              {t(`admin.overview.geo.scope.${s}`)}
            </button>
          ))}
        </div>
      </div>
      <p className="mb-4 text-xs text-neutral-500">{t('admin.overview.geo.hint')}</p>

      {error !== null && (
        <p className="text-xs text-down">
          {t('admin.overview.geo.failed')}{error ? `：${error}` : ''}
          <button type="button" onClick={retry} className="ml-2 text-prism-300 underline-offset-2 hover:underline">
            {t('admin.overview.geo.retry')}
          </button>
        </p>
      )}
      {error === null && !data && <SkeletonLine height={240} />}

      {data && (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[3fr_2fr]">
          <div>
            <div className="mb-2 flex items-center justify-between text-[11px] text-neutral-500">
              {mapMode === 'cn' ? (
                <button type="button" onClick={() => setMapMode('world')} className="text-prism-300 hover:underline">
                  ← {t('admin.overview.geo.backToWorld')}
                </button>
              ) : (
                <span>{t('admin.overview.geo.clickChina')}</span>
              )}
            </div>
            <Suspense fallback={<SkeletonLine height={240} />}>
              <GeoMap
                mode={mapMode}
                countries={data.countries}
                provinces={data.cnProvinces}
                lang={lang}
                onPickChina={() => setMapMode('cn')}
              />
            </Suspense>
            {data.located === 0 && <p className="mt-2 text-xs text-neutral-500">{t('admin.overview.geo.empty')}</p>}
          </div>

          <div>
            <div className="mb-2 flex gap-1.5">
              <button type="button" aria-pressed={view === 'countries'} onClick={() => setView('countries')} className={pill(view === 'countries')}>
                {t('admin.overview.geo.byCountry')}
              </button>
              <button type="button" aria-pressed={view === 'cities'} onClick={() => setView('cities')} className={pill(view === 'cities')}>
                {t('admin.overview.geo.byCity')}
              </button>
            </div>
            <ol className="space-y-1.5">
              {rows.map((r) => (
                <li key={r.key} className="grid grid-cols-[1fr_auto] items-center gap-3 text-xs">
                  <div className="relative h-5 overflow-hidden rounded bg-white/5">
                    <div className="absolute inset-y-0 left-0 rounded bg-prism-500/40" style={{ width: `${top ? Math.max(2, (r.count / top) * 100) : 0}%` }} />
                    <span className="relative px-2 leading-5 text-neutral-200">{r.label}</span>
                  </div>
                  <span className="tabular-nums text-neutral-100">{t('admin.overview.geo.people', { count: r.count })}</span>
                </li>
              ))}
            </ol>
            <p className="mt-3 text-[11px] text-neutral-500">{t('admin.overview.geo.unknown', { count: unknownCount(data) })}</p>
          </div>
        </div>
      )}
    </div>
  )
}
