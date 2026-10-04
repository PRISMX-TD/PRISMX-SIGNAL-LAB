import { describe, it, expect } from 'vitest'
import type { TFunction } from 'i18next'
import { ApiHttpError } from '../../api/client'
import type { OpsStatus } from '../../api/types'
import { fmtDuration, isUnreachable, watchdogComponent, WATCHDOG_STALE_SEC } from './SystemStatusPanel'

// 只看取了哪个 key、带了什么数：/ echo the key and count back
const t = ((key: string, opts?: { n?: number }) => (opts?.n == null ? key : `${key}:${opts.n}`)) as unknown as TFunction

describe('isUnreachable', () => {
  it('没拿到任何响应算读不到后端 / no response at all', () => {
    expect(isUnreachable(new TypeError('Failed to fetch'))).toBe(true)
  })

  it('任何 5xx 都算——各环境的代理回的状态码不一样 / any 5xx (nginx 502, Vite dev proxy 500)', () => {
    expect(isUnreachable(new ApiHttpError('', 500))).toBe(true)
    expect(isUnreachable(new ApiHttpError('', 502))).toBe(true)
    expect(isUnreachable(new ApiHttpError('', 504))).toBe(true)
  })

  it('4xx 是别的问题（权限、登录），不是后端挂了 / 4xx is not an outage', () => {
    expect(isUnreachable(new ApiHttpError('', 403))).toBe(false)
    expect(isUnreachable(new ApiHttpError('', 404))).toBe(false)
  })
})

describe('fmtDuration', () => {
  it('按最大的整单位显示 / largest whole unit', () => {
    expect(fmtDuration(t, 0)).toBe('admin.health.unit.s:0')
    expect(fmtDuration(t, 59)).toBe('admin.health.unit.s:59')
    expect(fmtDuration(t, 60)).toBe('admin.health.unit.m:1')
    expect(fmtDuration(t, 3599)).toBe('admin.health.unit.m:59')
    expect(fmtDuration(t, 7200)).toBe('admin.health.unit.h:2')
    expect(fmtDuration(t, 3 * 86400 + 5)).toBe('admin.health.unit.d:3')
  })

  it('没有数据时说「未知」/ unknown when missing', () => {
    expect(fmtDuration(t, null)).toBe('admin.health.unknown')
    expect(fmtDuration(t, undefined)).toBe('admin.health.unknown')
  })
})

describe('watchdogComponent', () => {
  const ops = (over: Partial<OpsStatus> = {}): OpsStatus => ({
    backend: { restartsUsed: 0, restartsMax: 3, cooldownSec: 0, lastTickAgoSec: 5 },
    gateway: { restartsUsed: 0, restartsMax: 3, cooldownSec: 0, lastTickAgoSec: 10 },
    operators: 2,
    history: [],
    ...over,
  })

  it('还没读到时是灰灯 / idle before the first answer', () => {
    expect(watchdogComponent(null, null).level).toBe('idle')
  })

  it('两边都在、额度没满是绿灯 / both online', () => {
    const c = watchdogComponent(ops(), null)
    expect(c.level).toBe('ok')
    expect(c.sg).toBe('ok')
    expect(c.vps).toBe('ok')
  })

  it('SG 看门狗连不上是红灯 / SG unreachable is down', () => {
    const c = watchdogComponent(null, 'HTTP 502')
    expect(c.level).toBe('down')
    expect(c.reasons).toEqual(['sgDown'])
  })

  it('主循环卡住（接口还活着）也是红灯 / stuck main loop is down', () => {
    const o = ops()
    o.backend.lastTickAgoSec = WATCHDOG_STALE_SEC + 1
    expect(watchdogComponent(o, null).reasons).toContain('sgStale')
    expect(watchdogComponent(o, null).level).toBe('down')
  })

  it('VPS 看门狗连不上是黄灯 / VPS unreachable is warn', () => {
    const c = watchdogComponent(ops({ gateway: { error: 'unreachable' } }), null)
    expect(c.level).toBe('warn')
    expect(c.reasons).toEqual(['vpsDown'])
  })

  it('额度用完是红灯，没人有口令是黄灯 / budget exhausted is down, no operators is warn', () => {
    const full = ops()
    full.backend.restartsUsed = 3
    expect(watchdogComponent(full, null).level).toBe('down')
    expect(watchdogComponent(ops({ operators: 0 }), null).level).toBe('warn')
  })

  it('旧版看门狗没有 lastTickAgoSec 时不判卡住 / old watchdogs without the field are not flagged', () => {
    const o = ops()
    delete o.backend.lastTickAgoSec
    delete o.gateway.lastTickAgoSec
    expect(watchdogComponent(o, null).level).toBe('ok')
  })
})
