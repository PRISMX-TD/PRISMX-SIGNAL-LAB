// 注册邮箱域名拼错（gamil.com、qq.con）识别。后端 services/email_domains.py 的
// suggest_domain_fix 才是真正的闸门（老 App 包、直接调接口都绕不过）；这里是同一套
// 规则的镜像，只为在提交前就用界面语言告诉用户对的写法，并给一个一键改正。
// 改规则时两边一起改，两边测试用的是同一张用例表。
//
// 只认主流邮箱的「一键之差」：名字够长的看名字和后缀，名字短的（qq、163）只看后缀；
// 一键之差 = 漏打一个字母 / 相邻两字母对调 / 某个字母多打一次 / 按到键盘上相邻的键。
// 名字和后缀各错一处（gamil.con）也算。mail.com / cloud.com / ymail.com 是真邮箱，先放行。
//
// Misspelled sign-up domain detection (gamil.com, qq.con). The backend's
// services/email_domains.py suggest_domain_fix is the real gate (old app bundles
// and direct API calls can't skip it); this mirrors the same rules only so the
// page can name the right address in the UI language before submitting and
// offer a one-tap fix. Change both together — their tests share one case table.

// 名字够长、一键之差基本只可能是手误 / long names: one slip is a typo
const NAME_TARGETS = [
  'gmail.com', 'googlemail.com', 'hotmail.com', 'outlook.com',
  'yahoo.com', 'icloud.com', 'foxmail.com', 'protonmail.com',
]
// 名字太短，改一个字就是另一个真域名，只看后缀 / short names: suffix only
const SUFFIX_TARGETS = [
  'qq.com', '163.com', '126.com', '139.com', 'sina.com', 'sohu.com',
  'aliyun.com', 'live.com', 'msn.com', 'aol.com', 'yeah.net',
]
// 和主流邮箱一键之差、但确实有人在用的域名 / real domains one slip from a target
const REAL_LOOKALIKES = new Set(['mail.com', 'cloud.com', 'ymail.com'])

const KEY_ROWS = ['1234567890', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm']

// QWERTY 上每个键周围的键：同一排左右，上一排同位和右一位，下一排左一位和同位。
// Each key's neighbours on a staggered QWERTY layout.
const NEIGHBOURS: Record<string, string> = (() => {
  const near: Record<string, string> = {}
  KEY_ROWS.forEach((row, r) => {
    for (let i = 0; i < row.length; i++) {
      const keys = new Set<string>()
      const spots: [number, number[]][] = [[r, [i - 1, i + 1]], [r - 1, [i, i + 1]], [r + 1, [i - 1, i]]]
      for (const [rr, cols] of spots) {
        const other = KEY_ROWS[rr]
        if (!other) continue
        for (const c of cols) if (c >= 0 && c < other.length) keys.add(other[c])
      }
      near[row[i]] = [...keys].sort().join('')
    }
  })
  return near
})()

/** word 手滑一下能变成的所有写法 / every spelling one slip away from word */
function oneSlip(word: string): Set<string> {
  const out = new Set<string>()
  for (let i = 0; i < word.length; i++) {
    const ch = word[i]
    out.add(word.slice(0, i) + word.slice(i + 1)) // 漏打 / dropped
    out.add(word.slice(0, i) + ch + word.slice(i)) // 多打 / doubled
    for (const k of NEIGHBOURS[ch] ?? '') out.add(word.slice(0, i) + k + word.slice(i + 1)) // 旁边的键 / neighbour key
    if (i + 1 < word.length) out.add(word.slice(0, i) + word[i + 1] + ch + word.slice(i + 2)) // 对调 / swapped
  }
  out.delete(word)
  out.delete('')
  return out
}

interface TypoRow {
  target: string
  name: string
  suffix: string
  nameSlips: Set<string>
  suffixSlips: Set<string>
}

let table: TypoRow[] | null = null

function typoTable(): TypoRow[] {
  if (table) return table
  table = [...NAME_TARGETS, ...SUFFIX_TARGETS].map((target) => {
    const dot = target.lastIndexOf('.')
    const name = target.slice(0, dot)
    const suffix = target.slice(dot + 1)
    return {
      target,
      name,
      suffix,
      nameSlips: NAME_TARGETS.includes(target) ? oneSlip(name) : new Set<string>(),
      suffixSlips: oneSlip(suffix),
    }
  })
  return table
}

/** 域名像是主流邮箱打错了，就返回改正后的完整邮箱（小写），否则 null。
 *  The corrected address (lowercased) when the domain looks like a mistyped
 *  mainstream mailbox, else null. */
export function suggestEmailFix(email: string | null | undefined): string | null {
  const raw = (email ?? '').trim().toLowerCase()
  const at = raw.lastIndexOf('@')
  if (at <= 0) return null
  const local = raw.slice(0, at)
  const domain = raw.slice(at + 1)
  if (REAL_LOOKALIKES.has(domain) || NAME_TARGETS.includes(domain) || SUFFIX_TARGETS.includes(domain)) return null
  const dot = domain.lastIndexOf('.')
  const name = domain.slice(0, dot)
  const suffix = domain.slice(dot + 1)
  // 只看「名字.后缀」两段：hotmail.co.uk、vip.qq.com 不在这条规则里。
  // Two-label domains only: hotmail.co.uk / vip.qq.com are out of scope.
  if (dot <= 0 || name.includes('.')) return null
  for (const row of typoTable()) {
    if ((name === row.name || row.nameSlips.has(name)) && (suffix === row.suffix || row.suffixSlips.has(suffix))) {
      return `${local}@${row.target}`
    }
  }
  return null
}
