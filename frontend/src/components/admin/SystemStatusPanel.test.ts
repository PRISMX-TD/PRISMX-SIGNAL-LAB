import { describe, it, expect } from 'vitest'
import type { TFunction } from 'i18next'
import { ApiHttpError } from '../../api/client'
import type { OpsStatus } from '../../api/types'
import { fmtDuration, isUnreachable, loopErrorKind, watchdogComponent, WATCHDOG_STALE_SEC } from './SystemStatusPanel'

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

describe('loopErrorKind', () => {
  it('Supabase pooler 连不上算数据库 / pooler refusals are db', () => {
    expect(loopErrorKind(
      'competition loop failed: OperationalError: (psycopg2.OperationalError) connection to server at '
      + '"aws-0-ap-southeast-1.pooler.supabase.com" (54.255.219.82), port 5432 failed: FATAL: Failed to connect '
      + 'to database: {:error, :econnrefused} (Background on this error at: https://sqlalche.me/e/20/e3q8)',
    )).toBe('db')
    // 前缀带 gateway、正文带 Connection refused，也还是数据库
    expect(loopErrorKind(
      'gateway_positions_loop 异常: OperationalError: (psycopg2.OperationalError) connection to server at '
      + '"aws-0-ap-southeast-1.pooler.supabase.com" (52.74.252.201), port 5432 failed: Connection refused',
    )).toBe('db')
  })

  it('数据库超时、连接池排满算「太忙」/ statement timeout and pool exhaustion are dbBusy', () => {
    expect(loopErrorKind('x: OperationalError: (psycopg2.errors.QueryCanceled) canceling statement due to statement timeout')).toBe('dbBusy')
    expect(loopErrorKind('x: TimeoutError: QueuePool limit of size 5 overflow 10 reached, connection timed out, timeout 30.00')).toBe('dbBusy')
  })

  it('只认 gateway_client 自己的报错 / gateway only from the client\'s own lines', () => {
    expect(loopErrorKind('Gateway 连不上，请求未发出 (3001.2ms): http://10.0.0.2/positions ...')).toBe('gateway')
    expect(loopErrorKind('Gateway 超时 (8000.0ms): http://10.0.0.2/positions')).toBe('gateway')
    expect(loopErrorKind('Gateway HTTP 500: http://10.0.0.2/positions boom')).toBe('gateway')
    expect(loopErrorKind("gateway_positions_loop 异常: KeyError: 'login'")).toBe('other')
  })

  it('其余几类 / the rest', () => {
    expect(loopErrorKind('x: ConnectionError: Error 111 connecting to localhost:6379. Connection refused.')).toBe('redis')
    expect(loopErrorKind('sentiment_loop error: HTTPStatusError: Client error \'429 Too Many Requests\'')).toBe('rateLimit')
    expect(loopErrorKind('sentiment_loop error: ReadTimeout: timed out')).toBe('timeout')
    expect(loopErrorKind('sentiment_loop error: ConnectError: [Errno -2] Name or service not known')).toBe('network')
    expect(loopErrorKind('循环意外结束（没有异常）')).toBe('stopped')
    expect(loopErrorKind("signal_loop error: ZeroDivisionError: division by zero")).toBe('other')
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
