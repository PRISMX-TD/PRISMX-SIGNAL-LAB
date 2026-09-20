import { describe, it, expect } from 'vitest'
import { DISABLE_REASON_MAX, isUserDisabled, normalizeDisableReason } from './userStatus'

describe('isUserDisabled', () => {
  it('后端还没上线这两个字段时视为正常 / treats a missing field as active', () => {
    // 前端先于后端上线的那段时间里，users 响应里根本没有 disabledAt。
    // While the frontend runs ahead of the backend the payload has no disabledAt.
    expect(isUserDisabled({})).toBe(false)
  })

  it('null 视为正常 / null is active', () => {
    expect(isUserDisabled({ disabledAt: null })).toBe(false)
  })

  it('有时间戳即为已停用 / any timestamp means disabled', () => {
    expect(isUserDisabled({ disabledAt: '2026-09-20T03:00:00Z' })).toBe(true)
  })
})

describe('normalizeDisableReason', () => {
  it('去掉首尾空白 / trims', () => {
    expect(normalizeDisableReason('  刷单套利 / arbitrage abuse  ')).toBe('刷单套利 / arbitrage abuse')
  })

  it('把换行与连续空白折成一个空格 / collapses newlines and runs of whitespace', () => {
    // textarea 里粘进来的多行文本最终会渲染在一个 <p> 里，换行不保留。
    // Multi-line paste ends up in a <p> that does not keep the breaks.
    expect(normalizeDisableReason('第一行\n\n第二行\t第三行')).toBe('第一行 第二行 第三行')
  })

  it('空白输入返回 null / whitespace-only yields null', () => {
    expect(normalizeDisableReason('')).toBeNull()
    expect(normalizeDisableReason('   \n\t  ')).toBeNull()
  })

  it('超长截断到上限 / truncates to the ceiling', () => {
    const long = 'a'.repeat(DISABLE_REASON_MAX + 50)
    const out = normalizeDisableReason(long)
    expect(out).not.toBeNull()
    expect(out).toHaveLength(DISABLE_REASON_MAX)
  })

  it('截断发生在折叠之后 / truncation happens after collapsing', () => {
    // 先折叠再截断，否则一段以空格开头的输入会白白吃掉额度。
    // Collapse first, then truncate; otherwise leading blanks eat the budget.
    const padded = '   ' + 'b'.repeat(DISABLE_REASON_MAX)
    expect(normalizeDisableReason(padded)).toHaveLength(DISABLE_REASON_MAX)
  })

  it('恰好等于上限时原样保留 / a reason exactly at the ceiling is untouched', () => {
    const exact = 'c'.repeat(DISABLE_REASON_MAX)
    expect(normalizeDisableReason(exact)).toBe(exact)
  })
})
