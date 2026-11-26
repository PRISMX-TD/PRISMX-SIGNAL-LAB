import { describe, expect, it } from 'vitest'
import { MAX_PRESETS, normalizePresets, withPreset, withoutPreset } from './presets'

describe('per-indicator templates', () => {
  it('drops unknown kinds, blank or duplicate names and bad inputs', () => {
    const n = normalizePresets({
      nope: [{ name: 'x', inputs: {}, styles: {} }],
      ema: [
        { name: '  快线 ', inputs: { len: 9, bogus: 1 }, styles: { ma: { color: '#ff0000', width: 2 } } },
        { name: '快线', inputs: { len: 50 } },
        { name: '', inputs: {} },
        'junk',
      ],
    })
    expect(Object.keys(n)).toEqual(['ema'])
    expect(n.ema).toHaveLength(1)
    expect(n.ema[0].name).toBe('快线')
    expect(n.ema[0].inputs.len).toBe(9)
    expect(n.ema[0].inputs.bogus).toBeUndefined()
    expect(normalizePresets(null)).toEqual({})
    expect(normalizePresets([1, 2])).toEqual({})
  })

  it('saving the same name overwrites and moves it last; the list is capped', () => {
    let all = withPreset({}, 'rsi', { name: 'a', inputs: { len: 7 }, styles: {} })
    all = withPreset(all, 'rsi', { name: 'b', inputs: { len: 21 }, styles: {} })
    all = withPreset(all, 'rsi', { name: 'a', inputs: { len: 9 }, styles: {} })
    expect(all.rsi.map((x) => x.name)).toEqual(['b', 'a'])
    expect(all.rsi[1].inputs.len).toBe(9)
    for (let i = 0; i < 40; i++) all = withPreset(all, 'rsi', { name: `p${i}`, inputs: {}, styles: {} })
    expect(all.rsi).toHaveLength(MAX_PRESETS)
    expect(all.rsi[MAX_PRESETS - 1].name).toBe('p39')
  })

  it('deleting the last template of a kind removes the kind', () => {
    const all = withPreset({}, 'macd', { name: 'x', inputs: {}, styles: {} })
    expect(withoutPreset(all, 'macd', 'x')).toEqual({})
    expect(withoutPreset(all, 'macd', 'y').macd).toHaveLength(1)
  })
})
