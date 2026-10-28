// 消息正文里的「可复制片段」（2026-10-28）：工单回复里用户贴的转账地址、邮箱、MT5 账号、交易号这类
// 长串，自动认出来包成 Copyable，点一下就复制，不用再长按选字。其余文字原样显示。
// Copyable fragments inside message text (2026-10-28): the payout addresses, emails, MT5 logins
// and transaction ids users paste into ticket replies are recognised and wrapped in Copyable,
// so one click copies them instead of a long-press selection. Everything else renders as is.
import Copyable from './Copyable'

// 邮箱；或 ≥5 位纯数字（账号、订单号）；或 ≥16 位字母数字混排（钱包地址、交易哈希）。
// Emails; ≥5-digit numbers (logins, order ids); or ≥16-char alphanumerics (wallet addresses, tx hashes).
const TOKEN = /([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|\b\d{5,}\b|\b(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{16,}\b)/g

export function splitCopyable(text: string): { text: string; copy: boolean }[] {
  const out: { text: string; copy: boolean }[] = []
  let last = 0
  for (const m of text.matchAll(TOKEN)) {
    const i = m.index ?? 0
    if (i > last) out.push({ text: text.slice(last, i), copy: false })
    out.push({ text: m[0], copy: true })
    last = i + m[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last), copy: false })
  return out
}

export default function CopyableText({ text }: { text: string }) {
  return (
    <>
      {splitCopyable(text).map((p, i) =>
        p.copy ? (
          <Copyable key={i} text={p.text} className="font-mono text-[var(--purple-hi)]" />
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  )
}
