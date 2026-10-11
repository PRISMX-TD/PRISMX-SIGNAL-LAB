import { describe, it, expect } from 'vitest'
import type { MT5Account } from '../api/types'
import { applyAccountsStatus, applyAccountFunds, liveEquity } from './accountsStatus'

const bridge = (login: string, online: boolean, balance = 100): MT5Account => ({
  login, source: 'bridge', online, balance,
})
const gateway = (login: string, online: boolean, balance = 100): MT5Account => ({
  login, source: 'gateway', online, balance,
})

describe('applyAccountsStatus', () => {
  it('gateway 账号的在线状态不受这条推送影响 / gateway liveness is left alone', () => {
    // 这就是那个 bug：onlineLogins 只含桥接账号，gateway 账号一收到推送就被打成离线。
    // The bug: onlineLogins lists bridge accounts only, so gateway accounts went offline.
    const out = applyAccountsStatus([gateway('500039', true)], [], { '500039': 250 })
    expect(out[0].online).toBe(true)
    expect(out[0].balance).toBe(250)
  })

  it('gateway 离线时也不会被这条推送拉成在线 / nor pulled online by it', () => {
    const out = applyAccountsStatus([gateway('500039', false)], ['500039'], undefined)
    expect(out[0].online).toBe(false)
  })

  it('桥接账号仍按在线名单判定 / bridge accounts still follow the list', () => {
    const out = applyAccountsStatus(
      [bridge('600144', false), bridge('600145', true)],
      ['600144'],
      undefined,
    )
    expect(out.map((a) => a.online)).toEqual([true, false])
  })

  it('推送里没有的账号余额保留原值 / balances absent from the push are kept', () => {
    const out = applyAccountsStatus([bridge('600144', true, 80), gateway('500039', true, 90)], ['600144'], {})
    expect(out.map((a) => a.balance)).toEqual([80, 90])
  })
})

describe('applyAccountFunds', () => {
  it('只改推送里有的账号的余额 / 净值 / 保证金 / only listed logins change', () => {
    const out = applyAccountFunds(
      [gateway('100503', true, 21000), bridge('600144', true, 80)],
      { '100503': { balance: 21555.92, equity: 22300, margin: 3300, adj: -11.92 } },
    )
    expect(out[0]).toMatchObject({ balance: 21555.92, equity: 22300, margin: 3300, online: true })
    expect(out[1].balance).toBe(80)
  })
})

describe('liveEquity', () => {
  it('有 adj 时 = 余额 + 实时浮盈 + adj，三个数对得上 / balance + floating + adj', () => {
    // 截图里的账号：库里净值 20,283.92 早已过时，余额 21,555.92、浮盈 +756。
    // The screenshot's account: stored equity 20,283.92 was stale; balance 21,555.92, floating +756.
    const acc = { balance: 21555.92, equity: 20283.92 }
    expect(liveEquity(acc, 756, 0)).toBe(22311.92)
    expect(liveEquity(acc, 756, -12.5)).toBe(22299.42)
  })

  it('没有 adj 退回库里的净值 / falls back to stored equity without adj', () => {
    expect(liveEquity({ balance: 100, equity: 120 }, 5, undefined)).toBe(120)
    expect(liveEquity({ balance: 100, equity: null }, 5, undefined)).toBeNull()
  })
})
