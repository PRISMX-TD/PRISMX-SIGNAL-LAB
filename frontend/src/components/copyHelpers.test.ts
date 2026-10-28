import { describe, expect, it } from 'vitest'
import { splitCopyable } from './CopyableText'
import { fillTemplate } from './support/ticketTools'
import { csvCell } from './admin/users/usersCsv'

describe('splitCopyable', () => {
  it('picks out wallet addresses, emails and account numbers', () => {
    const parts = splitCopyable('地址 TGSo9XgPeX9ZLPzGrja5am3mRJFb4pob1A，账号100609，邮箱 a.b@qq.com 谢谢')
    expect(parts.filter((p) => p.copy).map((p) => p.text)).toEqual([
      'TGSo9XgPeX9ZLPzGrja5am3mRJFb4pob1A',
      '100609',
      'a.b@qq.com',
    ])
    expect(parts.map((p) => p.text).join('')).toBe('地址 TGSo9XgPeX9ZLPzGrja5am3mRJFb4pob1A，账号100609，邮箱 a.b@qq.com 谢谢')
  })

  it('leaves short numbers and plain words alone', () => {
    expect(splitCopyable('第 3 名 收益 2717.8% hello').every((p) => !p.copy)).toBe(true)
  })
})

describe('fillTemplate', () => {
  it('fills nickname, email and ticket title', () => {
    expect(fillTemplate('你好 {nickname}（{email}），关于「{ticket}」', { userNickname: 'Rex', userEmail: 'r@x.com', title: '冠军' })).toBe(
      '你好 Rex（r@x.com），关于「冠军」',
    )
  })

  it('falls back to the email name when there is no nickname', () => {
    expect(fillTemplate('Hi {nickname}', { userNickname: null, userEmail: 'cedric@gmail.com', title: 't' })).toBe('Hi cedric')
  })
})

describe('csvCell', () => {
  it('quotes commas and guards formulas', () => {
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`)
    expect(csvCell(null)).toBe('')
    expect(csvCell(3)).toBe('3')
  })
})
