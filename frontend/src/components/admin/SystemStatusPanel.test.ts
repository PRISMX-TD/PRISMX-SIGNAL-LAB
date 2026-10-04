import { describe, it, expect } from 'vitest'
import type { TFunction } from 'i18next'
import { ApiHttpError } from '../../api/client'
import { fmtDuration, isUnreachable } from './SystemStatusPanel'

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
