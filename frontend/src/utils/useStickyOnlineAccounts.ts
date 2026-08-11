// 下单弹窗用的账号列表：一旦在本次弹窗里出现过，就不会因为"在线"标志抖动而消失。
//
// 为什么需要它：两个下单弹窗原本都是 `accounts.filter(a => a.online)`，而账号切换
// 器的渲染条件是 `列表长度 > 1`、表单区的渲染条件是 `列表长度 > 0`。只要某个账号的
// online 在用户操作的那一瞬间翻成 false，整个切换器（连同已展开的下拉菜单）就会被
// 卸载——用户看到的是"一点切换，框就没了"，会以为是点击本身把它关掉的。
//
// Gateway 账号尤其容易踩到：它没有心跳，在线与否靠后端跨公网探活 /health，偶发
// 失败是常态（后端侧已补了失败宽限，见 gateway_client.is_gateway_online，但那只
// 降低频率，不能根除）。而"用户正在读下拉里的余额、挑账号"恰好是个几秒的窗口，
// 撞上的概率并不低。
//
// 取舍：列表里因此可能留着一个此刻真的离线的账号。这是有意的——弹窗生命周期很短
// （就下一单），界面在用户手指底下重排的代价，远大于"选了个离线账号、提交时拿到
// 一句明确的失败提示"。下拉里会给离线项标一个灰点，不隐瞒状态。
// 账号被**解绑**（从 accounts 里彻底消失）时仍会正常移除,只有"掉线"才保留。
//
// Account list for the order modals: once an account has shown up online during
// this modal's lifetime it stays listed, so a flickering `online` flag can't
// unmount the switcher mid-interaction — which read to users as "clicking an
// account closes the dialog". Gateway accounts have no heartbeat and their
// liveness comes from a cross-internet probe, so transient false readings are
// expected. The tradeoff is that a genuinely offline account can linger for the
// modal's short lifetime; it's marked with a grey dot, and submitting to it
// yields a clear error — far better than the UI reshuffling under the cursor.
// Accounts that get *unbound* still disappear; only "offline" is tolerated.
import { useRef } from 'react'
import type { MT5Account } from '../api/types'

export function useStickyOnlineAccounts(accounts: MT5Account[]): MT5Account[] {
  // 本次弹窗里出现过在线状态的 login。渲染期间写 ref 是幂等的（重复渲染只会把
  // 同样的 key 再加一遍），不会因为 StrictMode 的双渲染产生差异。
  // Written during render, but idempotent — StrictMode's double render just
  // re-adds the same keys.
  const seen = useRef<Set<string>>(new Set())

  for (const a of accounts) {
    if (a.online) seen.current.add(a.login)
  }

  // 保持 accounts 的原始顺序，不要用 Set 的插入顺序——否则列表会按"谁先上线"
  // 排，用户每次打开看到的顺序都可能不一样。
  // Keep the caller's ordering rather than the Set's insertion order, or the
  // list would be sorted by "who came online first" and shuffle between opens.
  return accounts.filter((a) => a.online || seen.current.has(a.login))
}
