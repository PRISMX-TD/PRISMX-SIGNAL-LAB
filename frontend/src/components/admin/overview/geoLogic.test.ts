import { describe, expect, it } from 'vitest'
import type { AdminGeoDistribution } from '../../../api/types'
import { cityLabel, countryLabel, countsByNumeric, countsByProvince, isZh, tierOf, unknownCount } from './geoLogic'

describe('tierOf', () => {
  it('0 for no users, 5 for the max, monotonic in between', () => {
    expect(tierOf(0, 100)).toBe(0)
    expect(tierOf(100, 100)).toBe(5)
    expect(tierOf(1, 100)).toBeGreaterThanOrEqual(1)
    const tiers = [1, 3, 10, 30, 100].map((n) => tierOf(n, 100))
    expect([...tiers].sort()).toEqual(tiers)
  })
  it('max of 1 still colours the single country', () => {
    expect(tierOf(1, 1)).toBe(5)
  })
})

describe('labels', () => {
  const tw = { code: 'TW', numeric: '158', name: '台湾', nameEn: 'Taiwan', count: 3 }
  it('Chinese UI uses the Chinese name, others use English', () => {
    expect(isZh('zh')).toBe(true)
    expect(isZh('zh-CN')).toBe(true)
    expect(isZh('ja')).toBe(false)
    expect(countryLabel(tw, 'zh')).toBe('台湾')
    expect(countryLabel(tw, 'en')).toBe('Taiwan')
    expect(countryLabel(tw, 'th')).toBe('Taiwan')
  })
  it('never prefixes TW/HK/MO with China', () => {
    for (const lang of ['zh', 'en', 'ja', 'th', 'vi']) {
      expect(countryLabel(tw, lang)).not.toMatch(/中国|China/)
    }
  })
  it('city label: mainland shows province, elsewhere shows country', () => {
    expect(cityLabel({ countryCode: 'CN', country: '中国', province: '广东', city: '深圳', count: 1 }, 'zh')).toBe('广东 · 深圳')
    expect(cityLabel({ countryCode: 'MY', country: '马来西亚', province: null, city: 'Kuala Lumpur', count: 1 }, 'zh')).toBe('马来西亚 · Kuala Lumpur')
  })
})

describe('aggregates', () => {
  const d: AdminGeoDistribution = {
    scope: 'all', total: 10, located: 7,
    countries: [
      { code: 'CN', numeric: '156', name: '中国', nameEn: 'China', count: 5 },
      { code: null, numeric: null, name: 'Atlantis', nameEn: 'Atlantis', count: 2 },
    ],
    cnProvinces: [{ name: '广东', count: 4 }],
    cities: [],
  }
  it('unknown = total − located', () => {
    expect(unknownCount(d)).toBe(3)
  })
  it('maps by ISO numeric id and skips countries without one', () => {
    const m = countsByNumeric(d.countries)
    expect(m.get('156')).toBe(5)
    expect(m.size).toBe(1)
  })
  it('maps provinces by short name', () => {
    expect(countsByProvince(d.cnProvinces).get('广东')).toBe(4)
  })
})
