import { describe, it, expect } from 'vitest'
import { pickBootstrapSection } from './bootstrapMerge'
import type { BootstrapResponse } from '../api/client'

const base: BootstrapResponse = {
  signals: { signals: [] },
  accounts: { accounts: [], accountLimit: null, brokerLock: {} as never },
  trends: null,
  quotes: { quotes: [] },
  symbols: { symbols: ['XAUUSD'] },
  failed: ['trends'],
}

describe('pickBootstrapSection', () => {
  it('returns ok sections', () => {
    expect(pickBootstrapSection(base, 'symbols')).toEqual({ symbols: ['XAUUSD'] })
    expect(pickBootstrapSection(base, 'signals')).toEqual({ signals: [] })
  })
  it('null section / failed section -> null (fallback)', () => {
    expect(pickBootstrapSection(base, 'trends')).toBeNull()
    expect(pickBootstrapSection({ ...base, failed: ['quotes'] }, 'quotes')).toBeNull()
  })
  it('missing section (old/odd backend) -> null', () => {
    expect(pickBootstrapSection({} as BootstrapResponse, 'accounts')).toBeNull()
  })
})
