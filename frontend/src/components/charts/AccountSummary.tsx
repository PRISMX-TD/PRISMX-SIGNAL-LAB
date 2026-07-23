// 交易终端：账户摘要（右栏底部）/ Trading terminal: account summary.
//
// 数据来自 useLive().accounts（桥接上报）。多账号时优先展示在线账号，其次第一个。
// 已用/可用保证金、保证金水平 MT5 桥接目前未单独上报，用余额/净值可得的部分
// 如实展示，其余标注"—"，绝不编造数字。
// Data from useLive().accounts (bridge-reported). With several accounts, prefer
// an online one, else the first. Used/free margin and margin level aren't
// separately reported by the bridge yet, so we show what balance/equity give us
// and mark the rest "—" — never fabricate numbers.
import type { MT5Account } from '../../api/types'

interface Props {
  account: MT5Account | null
  className?: string
}

function money(v: number | null | undefined, ccy: string): string {
  if (v == null || !Number.isFinite(v)) return '—'
  return `${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${ccy}`
}

export default function AccountSummary({ account, className = '' }: Props) {
  const ccy = account?.accountCurrency || 'USD'
  const balance = account?.balance ?? null
  const equity = account?.equity ?? null
  // 浮动盈亏 = 净值 − 余额（桥接未单独给，可由二者推出）。
  // Floating P&L = equity − balance (derivable when the bridge doesn't give it directly).
  const floating = balance != null && equity != null ? equity - balance : null

  return (
    <div className={`term-panel term-account ${className}`}>
      <div className="term-pane-head">
        账户
        <span className="term-pane-head-r">{account ? `#${account.login}` : '未连接'}</span>
      </div>
      <div className="term-account-body">
        {!account ? (
          <div className="term-account-empty">
            连接 PRISMX Bridge 后显示账户余额、净值与保证金。
          </div>
        ) : (
          <>
            <Row k="余额 Balance" v={money(balance, ccy)} />
            <Row k="净值 Equity" v={money(equity, ccy)} strong />
            <Row
              k="浮动盈亏"
              v={money(floating, ccy)}
              tone={floating == null ? undefined : floating >= 0 ? 'up' : 'down'}
            />
            <div className="term-account-meta">
              <span>{account.leverage ? `杠杆 1:${account.leverage}` : ''}</span>
              <span className={account.online ? 'up' : ''}>
                {account.online ? '● 在线' : '○ 离线'} · {account.server || account.company || ''}
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function Row({ k, v, strong, tone }: { k: string; v: string; strong?: boolean; tone?: 'up' | 'down' }) {
  const cls = tone === 'up' ? 'up' : tone === 'down' ? 'down' : ''
  return (
    <div className="term-account-row">
      <span className="term-account-k">{k}</span>
      <span className={`term-account-v num ${strong ? 'strong' : ''} ${cls}`}>{v}</span>
    </div>
  )
}
