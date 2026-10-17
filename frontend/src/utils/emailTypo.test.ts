// 注册邮箱域名拼错识别。用例表和后端 tests/test_email_typo.py 是同一张：两边规则
// 必须一致，否则会出现前端放行、后端拒绝（或反过来）的怪事。
// Same case table as the backend's tests/test_email_typo.py — the two rule sets
// must agree, or the page and the API would disagree on the same address.
import { describe, expect, it } from 'vitest'
import { suggestEmailFix } from './emailTypo'

const TYPOS: [string, string][] = [
  ['joeyluv2004@gamil.com', 'joeyluv2004@gmail.com'], // 2026-10-17 后台那个真实案例
  ['u@gmial.com', 'u@gmail.com'],
  ['u@gmai.com', 'u@gmail.com'],
  ['u@gmaill.com', 'u@gmail.com'],
  ['u@gnail.com', 'u@gmail.com'],
  ['u@gmail.con', 'u@gmail.com'],
  ['u@gmail.cm', 'u@gmail.com'],
  ['u@gmail.co', 'u@gmail.com'],
  ['u@gmail.comm', 'u@gmail.com'],
  ['u@gmail.vom', 'u@gmail.com'],
  ['u@gamil.con', 'u@gmail.com'],
  ['u@hotmial.com', 'u@hotmail.com'],
  ['u@hotmail.co', 'u@hotmail.com'],
  ['u@outlok.com', 'u@outlook.com'],
  ['u@yaho.com', 'u@yahoo.com'],
  ['u@iclod.com', 'u@icloud.com'],
  ['u@qq.con', 'u@qq.com'],
  ['u@qq.cm', 'u@qq.com'],
  ['u@163.con', 'u@163.com'],
  ['u@126.cpm', 'u@126.com'],
  ['u@yeah.ner', 'u@yeah.net'],
  ['  U.Name@GaMil.COM ', 'u.name@gmail.com'],
]

// 后端那张表还额外跑了整个放行表（ALLOW_DOMAINS）；这里挑出和主流邮箱长得最像的。
// The backend also runs its whole allowlist; these are the closest lookalikes.
const REAL = [
  'gmail.com', 'googlemail.com', 'hotmail.com', 'outlook.com', 'yahoo.com', 'icloud.com',
  'foxmail.com', 'protonmail.com', 'qq.com', '163.com', '126.com', '139.com', 'sina.com',
  'sohu.com', 'aliyun.com', 'live.com', 'msn.com', 'aol.com', 'yeah.net',
  'mail.com', 'cloud.com', 'ymail.com', 'email.com', 'gmx.com', 'me.com', 'mail.ru',
  'hotmail.co.uk', 'yahoo.co.jp', 'vip.qq.com', 'mail.163.com',
  'sina.cn', '163.net', '126.net', 'live.cn', 'hotmail.fr', 'outlook.jp', 'yahoo.de',
  'q.com', 'company.com', 'example.org',
]

describe('suggestEmailFix', () => {
  it.each(TYPOS)('%s → %s', (email, expected) => {
    expect(suggestEmailFix(email)).toBe(expected)
  })

  it.each(REAL)('leaves user@%s alone', (domain) => {
    expect(suggestEmailFix(`user@${domain}`)).toBeNull()
  })

  it.each(['', null, undefined, 'no-at-sign', '@gamil.com', 'u@', 'u@localhost'])(
    'leaves malformed input (%s) to the browser / backend',
    (raw) => {
      expect(suggestEmailFix(raw)).toBeNull()
    },
  )
})
