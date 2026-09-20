// 账号停用状态的纯计算 / pure helpers for the account-disabled state
//
// 单独成模块而不是写在 AdminPage 里：这几条规则同时被用户表、停用弹窗和恢复
// 弹窗用到，而"确认框里显示的原因"与"真正发给后端的原因"必须是同一个值——
// 批量修改那处已经吃过这个教训（见 AdminPage 的 bulkPayload 注释：文案与
// payload 由同一个函数产出）。同时它们是纯函数，可以直接被 vitest 覆盖。
//
// Their own module rather than inline in AdminPage: these rules are used by the
// user table, the disable dialog and the restore dialog alike, and "the reason
// shown in the dialog" must be the very same value as "the reason sent to the
// backend" — the bulk-edit path already learned this (see bulkPayload's comment
// in AdminPage: copy and payload come out of one function). Being pure, they
// are also directly coverable by vitest.

import type { AdminUser } from '../../api/types'

/** 停用原因的长度上限。
 *
 *  这个字符串不是内部备注：它会被后端塞进该用户此后每一个 403 的 detail 里，
 *  再由前端的全局遮罩原样显示给他本人看。太长的一段话在手机遮罩里会挤掉"怎么
 *  联系客服"那一行——而那恰恰是这个界面唯一的出路。200 字足够写清"什么时间、
 *  因为什么、下一步做什么"，写不下的属于内部记录，该进备注字段。
 *
 *  Maximum length of a disable reason. This string is not an internal note: the
 *  backend embeds it in the detail of every 403 that user subsequently gets, and
 *  the frontend's overlay shows it to them verbatim. An essay pushes the "how to
 *  reach support" line off a phone-sized overlay — the one way out of that
 *  screen. 200 characters is enough for when, why and what next; anything longer
 *  is an internal record and belongs in the note field. */
export const DISABLE_REASON_MAX = 200

/** 是否已被停用。判据只看 disabledAt，不看 disabledReason——原因可以为空
 *  （后端只要求非空即可，但历史数据、或将来放宽必填都可能留下空原因），
 *  而"有没有被停用"必须只有一个真源。
 *
 *  Whether the account is disabled. Judged on disabledAt alone, never on
 *  disabledReason: a reason may be absent (legacy rows, or a future relaxation
 *  of the requirement), while "is it disabled" must have exactly one source. */
export function isUserDisabled(u: Pick<AdminUser, 'disabledAt'>): boolean {
  return !!u.disabledAt
}

/** 把管理员输入的原因规范成要发给后端的那一份；不可用时返回 null。
 *
 *  - 首尾空白去掉，内部连续空白（含换行）折成一个空格：textarea 里粘进来的
 *    多行文本会原样进到 403 的 detail 里，而那句话最终渲染在一个 <p> 里，
 *    换行既不保留也不好看。
 *  - 全是空白 → null，调用方据此禁用确认按钮。停用是不可逆且用户能看见的
 *    操作，"因为什么"不能留空。
 *  - 超长截断而不是拒绝：管理员写超了应该少写几个字，而不是在点确认时才被
 *    一个红字拦住；截断结果同时用于确认框，所见即所发。
 *
 *  Normalise an admin's typed reason into the exact value sent to the backend,
 *  or null when unusable.
 *  - Trim, and collapse internal whitespace runs (newlines included) to a single
 *    space: multi-line text pasted into the textarea would otherwise ride into
 *    the 403 detail, which is finally rendered inside a <p> that neither keeps
 *    nor benefits from the line breaks.
 *  - All whitespace → null, which the caller uses to keep Confirm disabled. A
 *    disable is irreversible-looking and user-visible; it cannot go unexplained.
 *  - Over-length is truncated rather than rejected: someone who typed too much
 *    should write less, not be stopped by red text at the moment of confirming.
 *    The truncated value is what the dialog shows too, so what is seen is sent. */
export function normalizeDisableReason(raw: string): string | null {
  const collapsed = raw.replace(/\s+/g, ' ').trim()
  if (!collapsed) return null
  return collapsed.slice(0, DISABLE_REASON_MAX)
}
