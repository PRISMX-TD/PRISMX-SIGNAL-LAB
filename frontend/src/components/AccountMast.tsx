// 账户抬头（手机版订单页）/ account masthead for the orders page on phones.
//
// 桌面版订单页把账号信息拆成两处：页头右侧的账号药丸（切换）+ 持仓页签里的六格
// 账本条（登录号 / 账户名 / 券商 / 余额 / 净值 / 杠杆）。手机上这两样叠起来占了
// 一屏的三分之二。这里把它们合成一块「抬头」，像手机银行的账户页：
//   第一行  ● 登录号 · 券商  ▾      —— 点击展开账号列表切换（只有一个账号时不可展开）
//   大数    净值                    —— 整页唯一的大字
//   小行    余额 / 浮动盈亏 / 杠杆
//   末行    账户名（券商那串长评估账号名，单行省略）
// 七项信息一项没少，高度从 ~420px 收到 ~130px。它跟页头的账号选择器一样是整页
// 的账号上下文，所以摆在页签条上面、三个页签共用。样式在 styles/orders.css
// 的 .ord-mast-* 段。
// Desktop splits account info across the head's pills (switching) and the
// positions tab's six-cell ledger. Stacked on a phone they ate two thirds of the
// first screen. This masthead merges them the way a banking app does: switcher
// line, one big equity figure, a facts line (balance / floating P&L / leverage)
// and the long account name ellipsised. Same seven facts, ~130px instead of
// ~420px. Like the head's selector it is page-wide context, so it sits above
// the tab bar and is shared by all three tabs. Styled by .ord-mast-* in
// styles/orders.css.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MT5Account } from '../api/types'

interface Props {
  accounts: MT5Account[]
  active: MT5Account
  onChoose: (login: string) => void
  // 当前账号下、经本平台开出的仓位的浮动盈亏合计（与持仓区同源）。
  // Floating P&L of the platform-opened positions under this account (same source as the list).
  floating: number
  // gateway 账号不落库券商名，回落到合作券商名。/ Gateway rows carry no company; fall back to the partner broker.
  brokerName: string
}

const money2 = (n: number | null | undefined): string =>
  n == null ? '—' : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

function Chevron() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
  )
}

export default function AccountMast({ accounts, active, onChoose, floating, brokerName }: Props) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const switchable = accounts.length > 1
  const broker = active.company || (active.source === 'gateway' ? brokerName : '')
  const up = floating >= 0
  const ccy = active.accountCurrency

  return (
    <section className="ord-mast" aria-label={t('orders.acct.section')}>
      <button
        type="button"
        className="ord-mast-sw"
        aria-expanded={switchable ? open : undefined}
        aria-label={switchable ? t('orders.mast.switch') : undefined}
        disabled={!switchable}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={`ord-mast-dot ${active.online ? 'on' : ''}`} />
        <span className="sr-only">{active.online ? t('common.online') : t('common.offline')}</span>
        <span className="ord-mast-login">{active.login}</span>
        {broker && <span className="ord-mast-broker">{broker}</span>}
        {switchable && <span className={`ord-mast-chev ${open ? 'open' : ''}`}><Chevron /></span>}
      </button>

      {open && switchable && (
        <div className="ord-mast-list" role="listbox" aria-label={t('orders.mast.switch')}>
          {accounts.map((a) => (
            <button
              key={a.login}
              type="button"
              role="option"
              aria-selected={a.login === active.login}
              className={`ord-mast-opt ${a.login === active.login ? 'on' : ''}`}
              onClick={() => { onChoose(a.login); setOpen(false) }}
            >
              <span className={`ord-mast-dot ${a.online ? 'on' : ''}`} />
              <span className="ord-mast-opt-login">{a.login}</span>
              <span className="ord-mast-opt-name">{a.accountName || a.company || a.server || ''}</span>
              <span className="ord-mast-opt-eq">{money2(a.equity)}</span>
            </button>
          ))}
        </div>
      )}

      <div className="ord-mast-eq">
        <span className="ord-k">{t('account.equity')}</span>
        <b>
          {money2(active.equity)}
          {ccy && <small>{ccy}</small>}
        </b>
      </div>

      <div className="ord-mast-facts">
        <span>
          <span className="ord-k">{t('account.balance')}</span>
          <b>{money2(active.balance)}</b>
        </span>
        <span>
          <span className="ord-k">{t('orders.mast.floating')}</span>
          <b className={up ? 'text-up' : 'text-down'}>{up ? '+' : ''}{floating.toFixed(2)}</b>
        </span>
        <span>
          <span className="ord-k">{t('account.leverage')}</span>
          <b>{active.leverage ? `1:${active.leverage}` : '—'}</b>
        </span>
      </div>

      {active.accountName && <div className="ord-mast-name">{active.accountName}</div>}
    </section>
  )
}
