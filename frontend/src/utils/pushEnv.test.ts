// deviceNotifHint：账号开关开着时，这台设备还差什么。钉住以前「看着开着、其实收不到」的两格——
// ready（这台设备从没授权过，例如 iPhone 重新添加主屏图标）要给「在本机开启」，granted 但订阅
// 失败要给「重试」；真正就绪才返回 null。
// deviceNotifHint: what this device still lacks while the account toggle is on — pins the two
// states that used to look "on" while nothing could arrive.
import { describe, expect, it } from 'vitest'
import { deviceNotifHint, PUSH_ENV_HINT_KEYS } from './pushEnv'

describe('deviceNotifHint', () => {
  it('offers "enable here" when this device never granted permission', () => {
    for (const device of ['unknown', 'ok', 'failed'] as const) {
      expect(deviceNotifHint('ready', device)).toEqual({ key: 'account.notifDeviceNotAllowed', action: 'enable' })
    }
  })

  it('is silent when granted and subscribed (or not yet known)', () => {
    expect(deviceNotifHint('granted', 'ok')).toBeNull()
    expect(deviceNotifHint('granted', 'unknown')).toBeNull()
  })

  it('offers "retry" when granted but subscribing failed', () => {
    expect(deviceNotifHint('granted', 'failed')).toEqual({ key: 'account.notifDeviceFailed', action: 'retry' })
  })

  it('falls back to the environment hint with no in-place action for the rest', () => {
    for (const env of ['denied', 'ios-needs-install', 'ios-too-old', 'unsupported'] as const) {
      expect(deviceNotifHint(env, 'unknown')).toEqual({ key: PUSH_ENV_HINT_KEYS[env], action: null })
    }
  })
})
