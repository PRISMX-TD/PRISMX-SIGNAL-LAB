/**
 * 下单数学的回归测试（2026-09-19 审计后补）。
 *
 * 为什么偏偏是这个文件先有测试：这里是前端离用户的钱最近的一段纯函数——手数、
 * 止损止盈方向、风险估算。审计查出的两条 P1 都落在这里，而且都属于**不报错、只
 * 悄悄让用户少一道保护**的那一类：
 *
 *   1. 止损输入框不过滤，全角数字 / 逗号小数点 / 多打一个点 都会静默产生错误的
 *      止损，或者变成 NaN 最后以 `null` 发出去（下的是裸单），界面全程不报错。
 *   2. 提交用的手数走的是没有上限的吸附函数，"在手机上输入 50 手、直接滑动确认、
 *      全程不失焦"能把 50 手原样提交，而失焦那条路径明明夹到 10。
 *
 * 后端 `.gitignore` 里那段注释把道理写透了：这类 bug 全程不报错，只有测试拦得住，
 * 而测试留在本地等于没有。那段话对前端同样成立，这个文件是把它落到前端的起点。
 *
 * Regression tests for the order math — the frontend code closest to the user's
 * money. Both P1 findings from the audit live here, and both are the kind that
 * raises nothing and merely removes a protection. See each block for specifics.
 */
import { describe, expect, it } from 'vitest'

import { checkSlTp, clampLots, normalizeVolume, parseOptionalNumber, sanitizeDecimal } from './orderMath'

// ---------------------------------------------------------------------------
// 输入清洗 / input sanitising
// ---------------------------------------------------------------------------

describe('sanitizeDecimal', () => {
  it('放过正常输入 / leaves a plain decimal alone', () => {
    expect(sanitizeDecimal('3300')).toBe('3300')
    expect(sanitizeDecimal('3300.5')).toBe('3300.5')
  })

  it('把全角数字读成半角，而不是当非法字符删掉', () => {
    // 中文输入法没切回半角就会打出全角数字，双语界面上极其常见。
    // 直接删掉等于把用户填的止损清空 —— 然后下出去的是裸单。
    expect(sanitizeDecimal('３３００')).toBe('3300')
    expect(sanitizeDecimal('３３００．５')).toBe('3300.5')
  })

  it('把逗号当小数点，而不是直接删掉', () => {
    // 只删非法字符会把 `3300,5` 变成 `33005` —— 比原来错得更离谱。
    expect(sanitizeDecimal('3300,5')).toBe('3300.5')
    expect(sanitizeDecimal('3300，5')).toBe('3300.5')
  })

  it('只保留第一个小数点', () => {
    // parseFloat('1.2.3') 会悄悄读成 1.2，而 1.2 作为黄金止损的方向校验还恰好通过。
    expect(sanitizeDecimal('1.2.3')).toBe('1.23')
    expect(sanitizeDecimal('3300..5')).toBe('3300.5')
  })

  it('丢掉字母与空格 / drops letters and spaces', () => {
    expect(sanitizeDecimal('abc')).toBe('')
    expect(sanitizeDecimal('33 00')).toBe('3300')
  })

  it('清洗后的串能被 parseFloat 正确读出来 / the result round-trips through parseFloat', () => {
    // 这条是整个清洗的目的：输入框里显示什么，发出去的就是什么。
    for (const [raw, expected] of [
      ['3300', 3300],
      ['３３００', 3300],
      ['3300,5', 3300.5],
      ['1.2.3', 1.23],
    ] as const) {
      expect(parseFloat(sanitizeDecimal(raw))).toBe(expected)
    }
  })
})

// ---------------------------------------------------------------------------
// 止损止盈校验 / SL & TP validation
// ---------------------------------------------------------------------------

describe('checkSlTp', () => {
  const REF = 3350 // 参考价 / reference price

  it('买单：止损低于现价、止盈高于现价 → 合法', () => {
    const { slInvalid, tpInvalid } = checkSlTp(true, 3300, 3400, REF)
    expect(slInvalid).toBe(false)
    expect(tpInvalid).toBe(false)
  })

  it('买单：止损高于现价 → 非法', () => {
    expect(checkSlTp(true, 3400, null, REF).slInvalid).toBe(true)
  })

  it('卖单方向相反 / SELL is mirrored', () => {
    expect(checkSlTp(false, 3400, 3300, REF).slInvalid).toBe(false)
    expect(checkSlTp(false, 3300, null, REF).slInvalid).toBe(true)
  })

  it('止损止盈填反 → 两边都非法，即使拿不到参考价', () => {
    const { slInvalid, tpInvalid } = checkSlTp(true, 3400, 3300, null)
    expect(slInvalid).toBe(true)
    expect(tpInvalid).toBe(true)
  })

  it('没填 → 合法（止损本就可以不填）', () => {
    const { slInvalid, tpInvalid } = checkSlTp(true, null, null, REF)
    expect(slInvalid).toBe(false)
    expect(tpInvalid).toBe(false)
  })

  it('填了但读不出来（NaN）→ 必须判非法，不能当成没填', () => {
    // 这是审计查出的那条：NaN 原来走进"没填"分支，于是界面不报错、滑动确认不禁用，
    // 而 NaN 经 JSON.stringify 变成 null —— 下出去的是一张没有止损的裸单。
    expect(checkSlTp(true, NaN, null, REF).slInvalid).toBe(true)
    expect(checkSlTp(true, null, NaN, REF).tpInvalid).toBe(true)
  })

  it('端到端：输入框里敲进去的东西不会变成没有止损的裸单', () => {
    // 走完整链路：用户键入 → sanitizeDecimal → parseOptionalNumber → checkSlTp。
    // 任何一种输入，要么得到一个能用的止损，要么被判非法挡住提交。
    // 绝不允许出现"既没有止损、又不报错"。
    for (const typed of ['abc', '３３００', '1.2.3', '3300,5', '.', '3300', '']) {
      const cleaned = sanitizeDecimal(typed)
      const value = parseOptionalNumber(cleaned)
      const { slInvalid } = checkSlTp(true, value, null, REF)
      const wouldSendNull = value == null || Number.isNaN(value)
      expect(
        !wouldSendNull || slInvalid || cleaned === '',
        `输入 ${JSON.stringify(typed)} 既没产生止损也没被判非法`,
      ).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// 手数 / lot sizing
// ---------------------------------------------------------------------------

describe('clampLots', () => {
  it('夹到上限 10 手 / caps at 10 lots', () => {
    // 提交路径原来用的是没有上限的 snapLot，手机上不失焦直接滑动确认就能提交 50 手。
    expect(clampLots(50, 'XAUUSD')).toBe(10)
    expect(clampLots(10.5, 'XAUUSD')).toBe(10)
  })

  it('不低于最小手数 / never below the minimum', () => {
    expect(clampLots(0.001, 'XAUUSD')).toBe(0.01)
  })

  it('向下吸附到品种步长 / floors onto the symbol step', () => {
    // 非整数倍手数不会被券商拒单，而是锁死仓位 —— 所以必须吸附而不是四舍五入。
    expect(clampLots(0.137, 'XAUUSD')).toBeCloseTo(0.13, 10)
  })

  it('原油步长是 0.1，不是 0.01 / WTI steps by 0.1', () => {
    // 写死按 0.01 取整会产出 0.13 这种永远不会成交的原油手数。
    expect(clampLots(0.137, 'WTI')).toBeCloseTo(0.1, 10)
    expect(clampLots(1.55, 'WTI')).toBeCloseTo(1.5, 10)
  })
})

describe('normalizeVolume', () => {
  it('空 / 非法 → 最小手数', () => {
    expect(normalizeVolume('', 'XAUUSD')).toBe('0.01')
    expect(normalizeVolume('abc', 'XAUUSD')).toBe('0.01')
  })

  it('与 clampLots 给出同一个上限 —— 失焦与提交两条路径不能有分歧', () => {
    // 两条路径口径不一致正是那条 P1 的成因。
    expect(parseFloat(normalizeVolume('50', 'XAUUSD'))).toBe(clampLots(50, 'XAUUSD'))
  })
})
