// ACCOUNTS_STATUS 推送怎么落到账号列表上。单独成文件是为了能单测：这段逻辑错过一次，
// 表现就是 gateway 账号在界面上无缘无故闪「未连接」。
// How an ACCOUNTS_STATUS push lands on the account list. Its own module so it can be
// unit-tested: getting it wrong once made gateway accounts flash "disconnected".
import type { MT5Account } from '../api/types'

// onlineLogins 只由桥接心跳生成，从来不含 gateway 账号——gateway 的在线与否取决于
// 网关服务本身，只有 /bridge/accounts 轮询知道。以前对所有账号一律 online.has(login)，
// 而 gateway 轮询每次余额变化（每平一笔仓）、以及每次 WS 重连后的首帧都会发这条消息，
// 于是 gateway 账号每次都被打成「未连接」，直到下一次 15 秒轮询才恢复——这就是用户说的
// 「MT5 连接不稳定」。
//
// 余额只更新推送里出现的账号。未出现不代表余额归零，可能是该账号当前离线——保留原值。
//
// onlineLogins comes from bridge heartbeats only and never lists gateway accounts,
// whose liveness only the /bridge/accounts poll knows. Applying it to every account
// flipped gateway accounts to "disconnected" on each balance change and after every
// WS reconnect, until the next 15s poll. Balances are only touched for logins present
// in the push; absence doesn't mean zero.
export function applyAccountsStatus(
  accounts: MT5Account[],
  onlineLogins: string[] | undefined,
  balances: Record<string, number> | undefined,
): MT5Account[] {
  const online = new Set(onlineLogins || [])
  return accounts.map((a) => {
    const next = a.source === 'gateway' ? { ...a } : { ...a, online: online.has(a.login) }
    if (balances && a.login in balances) next.balance = balances[a.login]
    return next
  })
}
