import { describe, expect, it } from 'vitest'
import { resolveSlot } from './luckySlot'

const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]

describe('resolveSlot', () => {
  it('finds the prize by id and is consistent when slotIndex agrees', () => {
    expect(resolveSlot(list, 'b', 1)).toEqual({ index: 1, consistent: true })
  })

  it('treats a missing slotIndex as consistent when the prize is found', () => {
    expect(resolveSlot(list, 'c', null)).toEqual({ index: 2, consistent: true })
  })

  it('trusts the id over a disagreeing slotIndex but flags it as stale', () => {
    // 管理员改了顺序：本地列表里 a 在 0，后端说 2
    expect(resolveSlot(list, 'a', 2)).toEqual({ index: 0, consistent: false })
  })

  it('falls back to an in-range slotIndex when the prize is not in the list', () => {
    expect(resolveSlot(list, 'gone', 1)).toEqual({ index: 1, consistent: false })
  })

  it('returns -1 when neither the id nor slotIndex can be placed', () => {
    expect(resolveSlot(list, 'gone', 7)).toEqual({ index: -1, consistent: false })
    expect(resolveSlot(list, 'gone', null)).toEqual({ index: -1, consistent: false })
    expect(resolveSlot([], 'a', 0)).toEqual({ index: -1, consistent: false })
  })
})
