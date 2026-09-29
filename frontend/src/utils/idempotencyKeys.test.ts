// 平仓 / 改单幂等号：只在「没拿到任何响应」时复用，拿到过响应必须换号；key 里带参数。
// Close / modify idempotency ids: reused only when no response was received; once any response
// arrived the id must change; parameters are part of the key.
import { describe, expect, it, vi } from 'vitest'

vi.mock('../api/utils', () => ({ clientOrderId: () => 'unused' }))
vi.mock('../api/client', () => {
  class ApiHttpError extends Error {
    status: number
    constructor(m: string, status: number) {
      super(m)
      this.status = status
    }
  }
  return { ApiHttpError, hasHttpResponse: (e: unknown) => e instanceof ApiHttpError }
})

import { createIdempotencyKeys } from './idempotencyKeys'
import { ApiHttpError } from '../api/client'

function keys() {
  let n = 0
  return createIdempotencyKeys(() => `id${++n}`)
}

describe('createIdempotencyKeys', () => {
  it('同一个 key 重复获取得到同一个号 / same key, same id', () => {
    const k = keys()
    expect(k.acquire('close:1:full')).toBe('id1')
    expect(k.acquire('close:1:full')).toBe('id1')
  })

  it('网络错误 / 超时（没拿到响应）保留号：重试用同一个', () => {
    const k = keys()
    const first = k.acquire('close:1:full')
    k.afterThrow('close:1:full', new TypeError('Failed to fetch'))
    expect(k.acquire('close:1:full')).toBe(first)
    const abort = new Error('aborted')
    abort.name = 'AbortError'
    k.afterThrow('close:1:full', abort)
    expect(k.acquire('close:1:full')).toBe(first)
  })

  it('拿到 HTTP 错误响应（被拒）必须换号', () => {
    const k = keys()
    const first = k.acquire('close:1:full')
    k.afterThrow('close:1:full', new ApiHttpError('rejected', 400))
    expect(k.acquire('close:1:full')).not.toBe(first)
  })

  it('成功拿到响应（含桥接的 PENDING）后 settle，下次点击换号', () => {
    const k = keys()
    const first = k.acquire('close:1:full')
    k.settle('close:1:full')
    expect(k.acquire('close:1:full')).not.toBe(first)
  })

  it('部分平仓的手数 / 改单的止损止盈在 key 里：参数变了就是另一个号', () => {
    const k = keys()
    const a = k.acquire('close:1:0.1')
    const b = k.acquire('close:1:0.2')
    expect(a).not.toBe(b)
    const m1 = k.acquire('modify:1:1900:1950')
    const m2 = k.acquire('modify:1:1900:1960')
    expect(m1).not.toBe(m2)
  })
})
