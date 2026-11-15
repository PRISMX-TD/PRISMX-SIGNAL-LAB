import { describe, expect, it } from 'vitest'
import { initialIndex, nextIndex } from './selectKeys'

describe('nextIndex', () => {
  it('moves one step and stops at the ends', () => {
    expect(nextIndex('ArrowDown', 0, 3)).toBe(1)
    expect(nextIndex('ArrowDown', 2, 3)).toBe(2)
    expect(nextIndex('ArrowUp', 2, 3)).toBe(1)
    expect(nextIndex('ArrowUp', 0, 3)).toBe(0)
  })

  it('jumps to the ends with Home / End', () => {
    expect(nextIndex('Home', 2, 5)).toBe(0)
    expect(nextIndex('End', 0, 5)).toBe(4)
  })

  it('ignores other keys and empty lists', () => {
    expect(nextIndex('Enter', 1, 3)).toBeNull()
    expect(nextIndex(' ', 1, 3)).toBeNull()
    expect(nextIndex('a', 1, 3)).toBeNull()
    expect(nextIndex('ArrowDown', 0, 0)).toBeNull()
  })
})

describe('initialIndex', () => {
  it('starts on the selected option, else the first', () => {
    expect(initialIndex(2, 4)).toBe(2)
    expect(initialIndex(-1, 4)).toBe(0)
    expect(initialIndex(9, 4)).toBe(0)
    expect(initialIndex(0, 0)).toBe(-1)
  })
})
