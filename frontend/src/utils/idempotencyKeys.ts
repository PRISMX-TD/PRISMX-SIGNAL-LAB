// 平仓 / 改单 / 撤挂单的幂等号：只在「没拿到任何响应」时复用，拿到过响应必须换号。
//
// 请求发出后连接断了 / 超时（没有响应）：用户再点一次，必须带同一个号，后端按 clientOrderId
// 去重，拿回第一笔的结果，而不是再下一张。可一旦拿到过响应——不管是 FILLED、桥接的
// PENDING「已发出」，还是被拒的 HTTP 错误——这个号对应的那条订单就定了：桥接随后异步拒绝的话，
// 复用旧号会命中后端幂等分支，直接返回那条旧的 REJECTED，平仓再也发不出去。所以响应一到就换号。
// key 里要带会改变请求含义的参数（部分平仓的手数、改单的止损止盈），否则换了参数重试会拿到
// 旧参数那条订单。
//
// Idempotency ids for close / modify / cancel-pending: reused ONLY when no response was ever
// received; once any response arrived, the id must be replaced. After a dropped/timed-out request
// the retry must carry the same id so the backend dedupes by clientOrderId and returns the first
// attempt's result. But once a response arrived — FILLED, a bridge's PENDING "sent", or a
// rejecting HTTP error — the order behind that id is settled: if the bridge rejects
// asynchronously, reusing the id would hit the backend's idempotent branch and return that old
// REJECTED row, and the close could never be sent again. So a response ends the id. The key must
// include parameters that change the request's meaning (partial-close volume, modify SL/TP).
import { clientOrderId } from '../api/utils'
import { hasHttpResponse } from '../api/client'

export interface IdempotencyKeys {
  /** 取（或新建）这个动作的幂等号 / get (or mint) the id for this action */
  acquire(key: string): string
  /** 拿到了响应：作废这个号 / a response arrived: retire the id */
  settle(key: string): void
  /** 调用抛错后：有 HTTP 响应就作废，没拿到任何响应（网络断 / 超时）就保留 / after a throw */
  afterThrow(key: string, err: unknown): void
}

export function createIdempotencyKeys(gen: () => string = clientOrderId): IdempotencyKeys {
  const ids = new Map<string, string>()
  return {
    acquire(key) {
      let id = ids.get(key)
      if (!id) {
        id = gen()
        ids.set(key, id)
      }
      return id
    },
    settle(key) {
      ids.delete(key)
    },
    afterThrow(key, err) {
      if (hasHttpResponse(err)) ids.delete(key)
    },
  }
}
