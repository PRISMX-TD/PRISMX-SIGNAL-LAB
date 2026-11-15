// 方向键漫游的下标计算：两端循环、Home / End、不接管的键、空组。
// Index maths for arrow-key roving: wrap-around, Home / End, keys left alone, empty group.
import { describe, expect, it } from 'vitest'
import { rovingNext } from './rovingTabs'

describe('rovingNext', () => {
  it('moves forward with ArrowRight / ArrowDown and wraps at the end', () => {
    expect(rovingNext('ArrowRight', 0, 3)).toBe(1)
    expect(rovingNext('ArrowDown', 1, 3)).toBe(2)
    expect(rovingNext('ArrowRight', 2, 3)).toBe(0)
  })

  it('moves back with ArrowLeft / ArrowUp and wraps at the start', () => {
    expect(rovingNext('ArrowLeft', 2, 3)).toBe(1)
    expect(rovingNext('ArrowUp', 1, 3)).toBe(0)
    expect(rovingNext('ArrowLeft', 0, 3)).toBe(2)
  })

  it('jumps to the ends with Home / End', () => {
    expect(rovingNext('Home', 2, 3)).toBe(0)
    expect(rovingNext('End', 0, 3)).toBe(2)
  })

  it('leaves other keys alone', () => {
    expect(rovingNext('Enter', 0, 3)).toBeNull()
    expect(rovingNext(' ', 0, 3)).toBeNull()
    expect(rovingNext('Tab', 0, 3)).toBeNull()
    expect(rovingNext('a', 0, 3)).toBeNull()
  })

  it('returns null for an empty group', () => {
    expect(rovingNext('ArrowRight', 0, 0)).toBeNull()
  })
})
