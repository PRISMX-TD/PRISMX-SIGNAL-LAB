// 交易终端：账户条（右栏底部 / 手机下单抽屉尾部）/ Trading terminal: account strip.
//
// 数据来自 useLive().accounts（桥接上报）。多账号时优先展示在线账号，其次第一个。
// 已用/可用保证金、保证金水平 MT5 桥接目前未单独上报，只展示余额/净值可得的部分，
// 绝不编造数字。
// Data from useLive().accounts (bridge-reported). With several accounts, prefer
// an online one, else the first. Used/free margin and margin level aren't
// reported by the bridge yet, so only what balance/equity give us is shown —
// never fabricated.
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

function money(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—'
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
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
  // the same snapshot the positions table renders. The old equity − balance
  // derivation lagged up to ~20s behind the positions and also absorbed unsettled
  // realized P/L, credit and commission. An absent login means no open positions,
  // so P/L is zero; we only fall back when there's no login at all.
  const pushedFloating = account ? funds[account.login] ?? 0 : null
  const floating =
    pushedFloating ??
    (balance != null && account?.equity != null ? account.equity - balance : null)

  // 净值 = 余额 + 浮动盈亏。余额只在出入金/平仓结算时变（低频，库里的值足够新），
  // 实时性由浮盈提供。/ Equity = balance + floating P/L; liveness comes from the
  // floating part, balance moves rarely enough for the stored value to be fresh.
  const equity =
    balance != null && floating != null ? balance + floating : account?.equity ?? null

  return (
    <div className={`term-ac ${className}`}>
      <div className="term-ph">
        <h3>{t('charts.account.title')}</h3>
        <span>{account ? `#${account.login}` : t('charts.account.disconnected')}</span>
      </div>
      {!account ? (
        <p className="term-ac-empty">{t('charts.account.empty')}</p>
      ) : (
        <>
          <div className="term-acg">
            <div>
              <div className="k">{t('charts.account.balance')}</div>
              <div className="v">{money(balance)}<small>{ccy}</small></div>
            </div>
            <div>
              <div className="k">{t('charts.account.equity')}</div>
              <div className="v">{money(equity)}<small>{ccy}</small></div>
            </div>
            <div>
              <div className="k">{t('charts.account.floating')}</div>
              <div className={`v ${floating == null ? '' : floating >= 0 ? 'up' : 'down'}`}>
                {floating == null ? '—' : `${floating >= 0 ? '+' : ''}${money(floating)}`}
              </div>
            </div>
            <div>
              <div className="k">{t('charts.account.leverageK')}</div>
              <div className="v">{account.leverage ? `1:${account.leverage}` : '—'}</div>
            </div>
          </div>
          <div className="term-acm">
            <span className={account.online ? 'ok' : ''}>
              {account.online ? t('charts.account.onlineK') : t('charts.account.offlineK')} · {account.server || account.company || ''}
            </span>
          </div>
        </>
      )}
    </div>
  )
}
