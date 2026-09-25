// 推送诊断的失败抽样上报：闸门（每环每会话一次、全局限频、抽样）与脱敏
// （endpoint / 密钥 / token 绝不出门）。reportClientError 整个换成桩——这里要钉的是
// 「什么时候报、报出去的字符串长什么样」，不是 fetch 本身（那条在 clientErrorReport 里）。
//
// Sampled push-diagnostic reporting: the gates (once per step per session, global
// rate limit, sampling) and redaction (endpoints / keys / tokens never leave).
// reportClientError is stubbed — what is pinned here is when a report goes out and
// what its message looks like, not the fetch itself.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const reportClientError = vi.fn()
vi.mock('./clientErrorReport', () => ({ reportClientError: (...a: unknown[]) => reportClientError(...a) }))

const diag = await import('./pushDiag')
const { recordDiag, getPushDiag, redactDiagMessage, REPORT_MIN_GAP_MS, REPORT_MAX_PER_SESSION } = diag

beforeEach(() => {
  vi.stubEnv('PROD', true)
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
  diag._resetDiagReportingForTest()
  diag._setRandForTest(() => 0) // 抽样必中 / always sampled in
  reportClientError.mockClear()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const sentMessages = () => reportClientError.mock.calls.map((c) => (c[1] as Error).message)

describe('recordDiag 失败上报', () => {
  it('失败时以 kind=push + step 上报；成功不报', () => {
    recordDiag('sw-ready')
    recordDiag('subscribe', new Error('AbortError: push service error'))
    expect(reportClientError).toHaveBeenCalledTimes(1)
    const [kind, err, extra] = reportClientError.mock.calls[0]
    expect(kind).toBe('push')
    expect((err as Error).message).toBe('AbortError: push service error')
    expect((err as Error).stack).toBe('')
    expect(extra).toEqual({ step: 'subscribe' })
  })

  it('诊断格子照旧记录，与上报无关', () => {
    recordDiag('prefs', 'boom')
    expect(getPushDiag().get('prefs')).toMatchObject({ ok: false, error: 'boom' })
  })

  it('同一环每会话只报一次', () => {
    recordDiag('subscribe', 'a')
    vi.advanceTimersByTime(REPORT_MIN_GAP_MS * 2)
    recordDiag('subscribe', 'b')
    expect(reportClientError).toHaveBeenCalledTimes(1)
  })

  it('抽样没中也算决定过：同一环之后再失败也不会再报', () => {
    diag._setRandForTest(() => 0.99)
    recordDiag('subscribe', 'a')
    diag._setRandForTest(() => 0)
    vi.advanceTimersByTime(REPORT_MIN_GAP_MS * 2)
    recordDiag('subscribe', 'b')
    expect(reportClientError).not.toHaveBeenCalled()
  })

  it('全局限频：间隔内的另一环不报，但过了间隔再失败还能报', () => {
    recordDiag('sw-register', 'x')
    recordDiag('sw-ready', 'y')
    expect(reportClientError).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(REPORT_MIN_GAP_MS)
    recordDiag('sw-ready', 'y')
    expect(reportClientError).toHaveBeenCalledTimes(2)
  })

  it('每会话最多 REPORT_MAX_PER_SESSION 条', () => {
    const steps = ['sw-register', 'sw-ready', 'subscribe', 'report', 'vapid-key', 'prefs'] as const
    for (const s of steps) {
      recordDiag(s, 'fail')
      vi.advanceTimersByTime(REPORT_MIN_GAP_MS)
    }
    expect(reportClientError).toHaveBeenCalledTimes(REPORT_MAX_PER_SESSION)
  })

  it('非生产环境不上报', () => {
    vi.stubEnv('PROD', false)
    recordDiag('subscribe', 'x')
    expect(reportClientError).not.toHaveBeenCalled()
  })

  it('上报本身抛异常也不影响调用方', () => {
    reportClientError.mockImplementationOnce(() => { throw new Error('nope') })
    expect(() => recordDiag('subscribe', 'x')).not.toThrow()
  })

  it('真实形状：订阅上报失败时的错误对象里带着 endpoint 与密钥——出门前全部抹掉', () => {
    const endpoint = 'https://fcm.googleapis.com/fcm/send/dQw4w9WgXcQ:APA91bHPRgkF3JUikC4ENAHEeMrd41Zxv3hVZjC9KtT8OvPVGJ-hQMRKRrZuJAEcl7B338qju59zJMjw2DELjzEvxwYv7hH5Ynpc1ODQ0aT4U4OFEeco8ohsN5PjL1iC2dNtk2BAokeMCg2ZXKqpc8FXKmhX94kIxQ'
    const err = {
      endpoint,
      keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' },
      detail: 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    }
    recordDiag('report', err)
    const [msg] = sentMessages()
    for (const secret of [endpoint, 'APA91b', 'BNcRdreALRFX', 'tBHItJI5svbpez7KI4CCXg', 'eyJhbGciOiJIUzI1NiJ9', 'fcm.googleapis.com']) {
      expect(msg, secret).not.toContain(secret)
    }
    expect(msg.length).toBeLessThanOrEqual(300)
  })
})

describe('redactDiagMessage', () => {
  it('URL 整段抹掉（http / https / ws / wss）', () => {
    expect(redactDiagMessage('POST https://api.x.com/api/push/subscribe?e=abc failed')).toBe('POST <url> failed')
    expect(redactDiagMessage('wss://api.x.com/ws/client closed')).toBe('<url> closed')
  })

  it('key=value / key: value 形式的敏感字段抹值', () => {
    expect(redactDiagMessage('token=abc123')).toBe('token=<redacted>')
    expect(redactDiagMessage('{"auth":"short"}')).toBe('{"auth":<redacted>}')
    expect(redactDiagMessage('p256dh: xyz')).toBe('p256dh: <redacted>')
  })

  it('长 base64 / base64url 串抹掉，普通报错（含长 API 名）原样保留', () => {
    expect(redactDiagMessage('key BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4Yf== bad')).toBe('key <redacted> bad')
    expect(redactDiagMessage('Failed to execute subscribe on PushManager: ServiceWorkerRegistration inactive'))
      .toBe('Failed to execute subscribe on PushManager: ServiceWorkerRegistration inactive')
    expect(redactDiagMessage('jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIx.abc')).toBe('jwt <redacted>')
    expect(redactDiagMessage('Registration failed - permission denied')).toBe('Registration failed - permission denied')
    expect(redactDiagMessage('Service Worker 未在时限内就绪 / worker not ready within the deadline'))
      .toBe('Service Worker 未在时限内就绪 / worker not ready within the deadline')
  })

  it('截断到 300 字', () => {
    expect(redactDiagMessage('x '.repeat(400)).length).toBe(300)
  })
})
