import { describe, expect, it } from 'vitest'
import { INK_DARK, INK_LIGHT, PALETTE, bulbCount, fitLabel, labelInk, labelMetrics, luminance, slicePath, slotColor, splitLabel } from './wheelArt'

const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

describe('slotColor', () => {
  it('keeps a valid #rrggbb the admin picked', () => {
    expect(slotColor('#12AbEf', 3)).toBe('#12AbEf')
  })

  it('falls back to the palette, cycling by slot index', () => {
    expect(slotColor(null, 0)).toBe(PALETTE[0])
    expect(slotColor(undefined, PALETTE.length + 2)).toBe(PALETTE[2])
    expect(slotColor('red', 1)).toBe(PALETTE[1])
    expect(slotColor('#abc', 4)).toBe(PALETTE[4])
  })
})

describe('labelInk', () => {
  it('puts light ink on violet and dark ink on pale or gold slots', () => {
    expect(labelInk('#5A22EE')).toBe(INK_LIGHT)
    expect(labelInk('#2A2A33')).toBe(INK_LIGHT)
    expect(labelInk('#E9E4FF')).toBe(INK_DARK)
    expect(labelInk('#E0A83C')).toBe(INK_DARK)
  })

  it('gives every default palette colour at least 4.5:1 contrast', () => {
    for (const c of PALETTE) expect(contrast(c, labelInk(c))).toBeGreaterThanOrEqual(4.5)
  })
})

describe('splitLabel', () => {
  it('keeps a name that fits on one line', () => {
    expect(splitLabel('谢谢参与', 5)).toEqual(['谢谢参与'])
  })

  it('collapses whitespace and handles an empty name', () => {
    expect(splitLabel('   ', 5)).toEqual([''])
    expect(splitLabel('  PRO   7d ', 9)).toEqual(['PRO 7d'])
  })

  it('breaks CJK by character into two lines', () => {
    expect(splitLabel('一二三四五六七八', 5)).toEqual(['一二三四五', '六七八'])
  })

  it('truncates the second line with an ellipsis when it still overflows', () => {
    expect(splitLabel('一二三四五六七八九十十一十二', 4)).toEqual(['一二三四', '五六七…'])
  })

  it('prefers breaking at a space so Latin words stay whole', () => {
    expect(splitLabel('Free PRO month', 6)).toEqual(['Free PRO', 'month'])
  })
})

describe('fitLabel', () => {
  it('keeps a mixed CJK / Latin name whole at the standard size', () => {
    expect(fitLabel('7 天 PRO 会员', 8)).toEqual({ lines: ['7 天', 'PRO 会员'], size: 9 })
  })

  it('steps the font down before it truncates', () => {
    expect(fitLabel('一二三四五六七八九十', 8)).toEqual({ lines: ['一二三四五', '六七八九十'], size: 8 })
  })

  it('truncates at the smallest size when nothing fits', () => {
    const { lines, size } = fitLabel('一二三四五六七八九十一二三四五六七八九十', 8)
    expect(size).toBe(7)
    expect(lines[1].endsWith('…')).toBe(true)
  })
})

describe('slicePath', () => {
  it('starts slot 0 at the top and sweeps clockwise', () => {
    expect(slicePath(0, 4, 100)).toBe('M0 0 L0.000 -100.000 A100 100 0 0 1 100.000 0.000 Z')
  })
})

describe('labelMetrics', () => {
  it('stays within 3 to 9 ems and never grows as slots are added', () => {
    let prev = Infinity
    for (let n = 2; n <= 16; n++) {
      const { maxEm, size } = labelMetrics(n)
      expect(maxEm).toBeGreaterThanOrEqual(3)
      expect(maxEm).toBeLessThanOrEqual(9)
      expect(maxEm).toBeLessThanOrEqual(prev)
      expect(size).toBeGreaterThanOrEqual(8)
      prev = maxEm
    }
  })
})

describe('bulbCount', () => {
  it('is at least 16 and a multiple of the slot count', () => {
    for (let n = 2; n <= 16; n++) {
      const b = bulbCount(n)
      expect(b).toBeGreaterThanOrEqual(16)
      expect(b % n).toBe(0)
    }
    expect(bulbCount(3)).toBe(18)
    expect(bulbCount(8)).toBe(16)
    expect(bulbCount(12)).toBe(24)
  })
})
