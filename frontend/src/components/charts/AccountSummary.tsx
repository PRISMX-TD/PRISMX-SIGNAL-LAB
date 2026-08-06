// 交易终端：账户摘要（右栏底部）/ Trading terminal: account summary.
//
// 数据来自 useLive().accounts（桥接上报）。多账号时优先展示在线账号，其次第一个。
// 已用/可用保证金、保证金水平 MT5 桥接目前未单独上报，用余额/净值可得的部分
// 如实展示，其余标注"—"，绝不编造数字。
// Data from useLive().accounts (bridge-reported). With several accounts, prefer
// an online one, else the first. Used/free margin and margin level aren't
// separately reported by the bridge yet, so we show what balance/equity give us
// and mark the rest "—" — never fabricate numbers.
//
// 浮动盈亏与净值走 useAccountFunds()（随持仓同拍推送），不再用库里 5 秒轮询来的
// equity 反推。原因见下方 floating 处的注释。
// Floating P/L and equity come from useAccountFunds() (pushed on the same tick as
// positions) rather than being derived from the 5s-polled equity column; see the
// comment at `floating` below.
import { useTranslation } from 'react-i18next'
import type { MT5Account } from '../../api/types'
import { useAccountFunds } from '../../store/live'

interface Props {
  account: MT5Account | null
  className?: string
}

function money(v: number | null | undefined, ccy: string): string {
  if (v == null || !Number.isFinite(v)) return '—'
  return `${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${ccy}`
}

export default function AccountSummary({ account, className = '' }: Props) {
  const { t } = useTranslation()
  const funds = useAccountFunds()
  const ccy = account?.accountCurrency || 'USD'
  const balance = account?.balance ?? null

  // 浮动盈亏优先用推送值：它是当前各持仓 profit 之和，与持仓表同源同拍。
  //
  // 旧做法是 equity − balance 反推，有两个问题：
  //   1. equity 来自 mt5_accounts 表，前端 5 秒轮询 + 后端最长 15 秒刷新，
  //      最坏落后 20 秒，而持仓表的 profit 只落后一两秒 —— 同屏两个数字对不上。
  //   2. 即使时间对齐，equity − balance 也不严格等于"持仓浮盈之和"：未结算的
  //      已实现盈亏、信用额度、佣金入账都会掉进这个差值里。
  //
  // 推送值缺席（login 不在表里）说明该账号当前没有持仓，浮盈就是 0。
  // 只有连 login 都没有（account 为 null）时才回退到反推。
  //
  // Prefer the pushed figure: it's the sum of the current positions' profit, from
  // the same snapshot the positions table renders.
  //
  // The old equity − balance derivation had two problems: equity comes from the
  // DB (5s frontend poll on top of a refresh up to 15s old, so ~20s worst case)
  // while position profit is 1-2s old, making the two disagree on screen; and
  // even time-aligned, equity − balance isn't strictly the sum of open-position
  // profit (unsettled realized P/L, credit, and commission all land in it).
  //
  // An absent login means the account has no open positions, so P/L is zero. We
  // only fall back to the derivation when there's no login at all.
  const pushedFloating = account ? funds[account.login] ?? 0 : null
  const floating =
    pushedFloating ??
    (balance != null && account?.equity != null ? account.equity - balance : null)

  // 净值 = 余额 + 浮动盈亏。余额只在出入金/平仓结算时变（低频，库里的值足够新），
  // 实时性由浮盈提供，所以这样算出来的净值比直接读库的 equity 及时得多。
  // Equity = balance + floating P/L. Balance only moves on deposits/withdrawals
  // and closes (low-frequency, so the DB value is fresh enough); the liveness
  // comes from the floating part, making this far timelier than the stored equity.
  const equity =
    balance != null && floating != null ? balance + floating : account?.equity ?? null

  return (
    <div className={`term-panel term-account ${className}`}>
      <div className="term-pane-head">
        {t('charts.account.title')}
        <span className="term-pane-head-r">{account ? `#${account.login}` : t('charts.account.disconnected')}</span>
      </div>
      <div className="term-account-body">
        {!account ? (
          <div className="term-account-empty">
            {t('charts.account.empty')}
          </div>
        ) : (
          <>
            <Row k={String(t('charts.account.balance'))} v={money(balance, ccy)} />
            <Row k={String(t('charts.account.equity'))} v={money(equity, ccy)} strong />
            <Row
              k={String(t('charts.account.floating'))}
              v={money(floating, ccy)}
              tone={floating == null ? undefined : floating >= 0 ? 'up' : 'down'}
            />
            <div className="term-account-meta">
              <span>{account.leverage ? t('charts.account.leverage', { leverage: account.leverage }) : ''}</span>
              <span className={account.online ? 'up' : ''}>
                {account.online ? t('charts.account.online') : t('charts.account.offlineDot')} · {account.server || account.company || ''}
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
