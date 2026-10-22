// 抽奖记录 / 待发奖页的纯逻辑：筛选 → 查询参数、翻页越界回退、备注输入校验、CSV 文件名。
// 放在 .ts 里是因为仓库没有 DOM 测试环境，这些判断写在组件里就测不到。
// Pure logic for the draws / pending tab: filter → query params, page clamping, note-input
// validation and the CSV file name. Kept in a .ts file because the repo has no DOM test
// environment, so the same checks inside the component would go untested.
import type { LuckyFulfillment } from '../../../api/luckyTypes'

export type DrawsMode = 'all' | 'pending'
export type DrawsStatus = LuckyFulfillment | ''

export const PAGE = 50
// 与后端 LuckyHandleIn.note 的 max_length 一致 / matches the backend LuckyHandleIn.note max_length
export const NOTE_MAX = 200

/**
 * 待发奖队列固定查 open（pending + submitted），不理会下拉框；全部记录页按所选状态，空串 = 不筛。
 * The pending queue always asks for `open` (pending + submitted) and ignores the dropdown; the
 * all-records tab uses the chosen status, empty = no filter.
 */
export function drawsQuery(mode: DrawsMode, status: DrawsStatus, offset: number) {
  return { status: mode === 'pending' ? ('open' as const) : status, limit: PAGE, offset }
}

/**
 * 处理完最后一条后当前页会变空：回退到最后一个有数据的页，不然管理员会看到「没有记录」而总数却不是 0。
 * Handling the last row empties the current page: step back to the last page that has rows,
 * or the admin would see "no records" next to a non-zero total.
 */
export function clampOffset(offset: number, total: number): number {
  if (total <= 0) return 0
  if (offset < total) return Math.max(0, offset)
  return Math.floor((total - 1) / PAGE) * PAGE
}

export type NoteResult = { kind: 'abort' } | { kind: 'empty' } | { kind: 'long' } | { kind: 'ok'; note: string }

/**
 * 对 window.prompt 的返回值做校验：点「取消」= 放弃；发放备注可空；取消奖品必须写原因（用户看得到），
 * 且都不能超过后端长度上限（超了后端会 422，不如在这里先说清楚）。
 * Validates what window.prompt returned: dismissing = abort; a delivery note may be blank; a
 * cancellation needs a reason (the user sees it); neither may exceed the backend length cap
 * (the server would answer 422, so say so up front).
 */
export function parseNote(kind: 'deliver' | 'cancel', raw: string | null): NoteResult {
  if (raw === null) return { kind: 'abort' }
  const note = raw.trim()
  if (kind === 'cancel' && !note) return { kind: 'empty' }
  if (note.length > NOTE_MAX) return { kind: 'long' }
  return { kind: 'ok', note }
}

export function csvFileName(mode: DrawsMode, status: DrawsStatus): string {
  if (mode === 'pending') return 'lucky-draws-pending.csv'
  return status ? `lucky-draws-${status}.csv` : 'lucky-draws.csv'
}
