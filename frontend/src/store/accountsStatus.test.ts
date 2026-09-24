import { describe, it, expect } from 'vitest'
import type { MT5Account } from '../api/types'
import { applyAccountsStatus } from './accountsStatus'

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
