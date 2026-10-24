// 用户分布卡片的纯逻辑：分档、名字、聚合。地图与卡片只管画。
// 台湾 / 香港 / 澳门只写名字（产品决定 2026-10-25），名字直接来自后端，这里不拼「中国」。
// Pure logic for the geo card: tiers, labels, lookups. TW/HK/MO names come from the
// backend as plain names; nothing here prefixes them.
import type { AdminGeoCity, AdminGeoCountry, AdminGeoDistribution, AdminGeoProvince } from '../../../api/types'

export const TOP_N = 20

// 香港、澳门在 110m 世界地图里没有形状，画成圆点 / no shapes at 110m, drawn as dots
export const SMALL_REGIONS: { code: 'HK' | 'MO'; lonLat: [number, number] }[] = [
  { code: 'HK', lonLat: [114.17, 22.32] },
  { code: 'MO', lonLat: [113.54, 22.19] },
]

export type Tier = 0 | 1 | 2 | 3 | 4 | 5

// 对数分档：头部国家人数远多于尾部，线性分档会让除第一名外全是最浅色。
// Log-scaled tiers: a linear scale would paint everything but the leader the palest shade.
export function tierOf(count: number, max: number): Tier {
  if (count <= 0 || max <= 0) return 0
  const t = Math.ceil((5 * Math.log1p(count)) / Math.log1p(max))
  return Math.min(5, Math.max(1, t)) as Tier
}

export function isZh(lang: string): boolean {
  return lang.toLowerCase().startsWith('zh')
}

export function countryLabel(c: AdminGeoCountry, lang: string): string {
  return isZh(lang) ? c.name : c.nameEn
}

export function cityLabel(c: AdminGeoCity, lang: string): string {
  if (c.countryCode === 'CN' && c.province) return `${c.province} · ${c.city}`
  const country = isZh(lang) ? c.country : c.countryCode ?? c.country
  return `${country} · ${c.city}`
}

export function unknownCount(d: AdminGeoDistribution): number {
  return Math.max(0, d.total - d.located)
}

export function countsByNumeric(list: AdminGeoCountry[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const c of list) if (c.numeric) m.set(c.numeric, (m.get(c.numeric) ?? 0) + c.count)
  return m
}

export function countsByProvince(list: AdminGeoProvince[]): Map<string, number> {
  return new Map(list.map((p) => [p.name, p.count]))
}
