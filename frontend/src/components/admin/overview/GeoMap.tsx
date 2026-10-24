// 用户分布地图：世界按国家上色，中国可切到省级。按需加载（d3-geo + 地图数据约 250KB，
// 只有打开总览页才下载）。香港、澳门在 110m 世界图里没有形状，画成圆点；台湾按自己的
// 形状上色。所有名字只写名字（产品决定 2026-10-25）。
// The geo map: countries on the world view, provinces on the China view. Lazily
// loaded. HK and MO have no 110m shapes and are drawn as dots; Taiwan keeps its own
// shape. Every label is the plain name.
import { geoMercator, geoNaturalEarth1, geoPath } from 'd3-geo'
import type { FeatureCollection, Geometry } from 'geojson'
import { useMemo, useState, type MouseEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { feature } from 'topojson-client'
import type { Topology } from 'topojson-specification'
import world from 'world-atlas/countries-110m.json'
import type { AdminGeoCountry, AdminGeoProvince } from '../../../api/types'
import cnProvinces from '../../../assets/geo/cn-provinces.json'
import { SMALL_REGIONS, countryLabel, countsByNumeric, countsByProvince, tierOf, type Tier } from './geoLogic'

const W = 800
const H = 420
const CHINA_NUMERIC = '156'

// 0 档是「没人」，其余 5 档由浅到深 / tier 0 = nobody, 1..5 light → dark
const TIER_CLASS: Record<Tier, string> = {
  0: 'fill-white/[0.06]',
  1: 'fill-prism-500/20',
  2: 'fill-prism-500/35',
  3: 'fill-prism-500/50',
  4: 'fill-prism-400/70',
  5: 'fill-prism-300/90',
}

type Props = {
  mode: 'world' | 'cn'
  countries: AdminGeoCountry[]
  provinces: AdminGeoProvince[]
  lang: string
  onPickChina: () => void
}

type Hover = { name: string; count: number; x: number; y: number }

const worldFeatures = feature(world as unknown as Topology, (world as unknown as Topology).objects.countries) as unknown as FeatureCollection<Geometry, { name: string }>
const cnFeatures = feature(cnProvinces as unknown as Topology, (cnProvinces as unknown as Topology).objects.provinces) as unknown as FeatureCollection<Geometry, { name: string }>

export default function GeoMap({ mode, countries, provinces, lang, onPickChina }: Props) {
  const { t } = useTranslation()
  const [hover, setHover] = useState<Hover | null>(null)

  const byNumeric = useMemo(() => countsByNumeric(countries), [countries])
  const byProvince = useMemo(() => countsByProvince(provinces), [provinces])
  const byCode = useMemo(() => new Map(countries.filter((c) => c.code).map((c) => [c.code as string, c])), [countries])

  const fc = mode === 'world' ? worldFeatures : cnFeatures
  const projection = useMemo(
    () => (mode === 'world' ? geoNaturalEarth1() : geoMercator()).fitSize([W, H], fc),
    [mode, fc],
  )
  const path = useMemo(() => geoPath(projection), [projection])
  const counts = mode === 'world' ? [...byNumeric.values()] : [...byProvince.values()]
  const max = Math.max(0, ...counts)

  const nameOfWorld = (id: string, fallback: string) => {
    const c = countries.find((x) => x.numeric === id)
    return c ? countryLabel(c, lang) : fallback
  }

  const show = (e: MouseEvent<SVGElement>, name: string, count: number) => {
    const box = (e.currentTarget.ownerSVGElement ?? e.currentTarget).getBoundingClientRect()
    setHover({ name, count, x: e.clientX - box.left, y: e.clientY - box.top })
  }

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={t('admin.overview.geo.title')}>
        {fc.features.map((f, i) => {
          const id = String((f as { id?: string | number }).id ?? '')
          const count = mode === 'world' ? byNumeric.get(id) ?? 0 : byProvince.get(f.properties.name) ?? 0
          const name = mode === 'world' ? nameOfWorld(id, f.properties.name) : f.properties.name
          const clickable = mode === 'world' && id === CHINA_NUMERIC
          return (
            <path
              key={`${id}-${i}`}
              d={path(f) ?? undefined}
              className={`${TIER_CLASS[tierOf(count, max)]} stroke-black/40 transition-opacity hover:opacity-80 ${clickable ? 'cursor-pointer' : ''}`}
              strokeWidth={0.5}
              onMouseMove={(e) => show(e, name, count)}
              onMouseLeave={() => setHover(null)}
              onClick={clickable ? onPickChina : undefined}
            />
          )
        })}
        {mode === 'world' && SMALL_REGIONS.map((r) => {
          const c = byCode.get(r.code)
          const p = projection(r.lonLat)
          if (!c || !p) return null
          return (
            <circle
              key={r.code}
              cx={p[0]}
              cy={p[1]}
              r={4}
              className={`${TIER_CLASS[tierOf(c.count, max)]} stroke-white/60`}
              strokeWidth={0.8}
              onMouseMove={(e) => show(e, countryLabel(c, lang), c.count)}
              onMouseLeave={() => setHover(null)}
            />
          )
        })}
      </svg>
      {hover && (
        <div
          className="pointer-events-none absolute z-10 rounded bg-black/80 px-2 py-1 text-[11px] text-white"
          style={{ left: hover.x + 12, top: hover.y + 12 }}
        >
          {t('admin.overview.geo.tooltip', { name: hover.name, count: hover.count })}
        </div>
      )}
    </div>
  )
}
