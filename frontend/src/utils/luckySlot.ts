// 开奖后把「中了哪个奖」对到本地转盘的格子上。
// 后端的 slotIndex 按**它此刻**的上架顺序算；管理员中途改奖项 / 下架后，本地缓存的奖品列表
// 就过期了，照 slotIndex 转会停在和弹框对不上的那一格。所以先按奖项 id 在本地列表里找，
// 找不到或与 slotIndex 不一致（consistent=false）就由调用方重新拉 state 再解析一次。
// Maps "which prize was won" onto a slot of the locally rendered wheel. The backend's slotIndex
// follows ITS current listing order; if an admin edits or unlists prizes mid-round our cached list
// is stale and spinning to slotIndex would stop on a slot that disagrees with the result modal.
// So look the prize up by id first; when it is missing or disagrees with slotIndex
// (consistent=false) the caller refetches state and resolves again.
export interface SlotResolution {
  /** 要转到的格；-1 = 无处可转（调用方跳过动画直接出结果）/ slot to land on; -1 = nowhere to spin to */
  index: number
  /** 本地列表与后端 slotIndex 一致 / local list agrees with the backend's slotIndex */
  consistent: boolean
}

export function resolveSlot(
  prizes: { id: string }[],
  prizeId: string,
  slotIndex: number | null | undefined,
): SlotResolution {
  const found = prizes.findIndex((p) => p.id === prizeId)
  const consistent = found >= 0 && (slotIndex == null || slotIndex === found)
  if (found >= 0) return { index: found, consistent }
  const fallback = slotIndex != null && Number.isInteger(slotIndex) && slotIndex >= 0 && slotIndex < prizes.length
  return { index: fallback ? (slotIndex as number) : -1, consistent: false }
}
