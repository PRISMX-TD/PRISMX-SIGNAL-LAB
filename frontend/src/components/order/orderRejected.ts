// 券商当场拒单（REJECTED）或结果未知（FAILED）时，滑动确认弹窗那条下单路径抛出的错误。
//
// 为什么要抛：OrderSheet 的契约是「onConfirm 的 promise 正常 resolve = 已提交」，据此渲染
// 绿色「已提交」回执、2 秒后关闭并跳到交易页。被拒的单如果正常 resolve，用户就会同时看到
// 绿色回执和一条红色 toast，两个相反的结论。带上整条 Order，是因为调用方要按 status 决定
// 幂等号换不换（REJECTED 换，FAILED 不换）。
//
// Thrown on the slide-to-confirm path when the broker rejects on the spot (REJECTED) or the
// outcome is unknown (FAILED). OrderSheet treats a resolved promise as "submitted" and shows a
// green receipt, then closes and navigates; a rejected order that resolves produced that green
// receipt next to a red toast. The whole Order rides along because the caller decides from its
// status whether to rotate the idempotency key (REJECTED: rotate, FAILED: keep).
import type { Order } from '../../api/types'

/** 下单被拒 / 结果未知；message 是券商原文（未本地化）。
 *  Order rejected or outcome unknown; message is the broker's raw text (not localized). */
export class OrderRejectedError extends Error {
  order: Order
  constructor(order: Order) {
    super(order.message ?? '')
    this.name = 'OrderRejectedError'
    this.order = order
  }
}
