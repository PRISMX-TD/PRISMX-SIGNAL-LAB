// Select / MultiSelect 的键盘移动规则，单独成纯函数以便测试（项目没有 DOM 测试环境）。
// listbox 弹出模式：上下键移一格、到头停住（不回绕：回绕在长列表里会让人以为跳到了别处），
// Home / End 到两端；其它键返回 null，交给按钮自己的原生行为（Enter / Space 触发 click）。
// Keyboard movement for Select / MultiSelect, kept pure so it can be unit-tested (no DOM
// test environment here). Listbox popup pattern: arrows move one step and stop at the
// ends (no wrap — in a long list wrapping reads as jumping somewhere else), Home/End go
// to the ends; any other key returns null and is left to the button's native behaviour.

/** 方向键 / Home / End 之后的高亮下标；不处理的键返回 null。
 *  Next highlighted index for arrow / Home / End; null for keys we don't handle. */
export function nextIndex(key: string, current: number, count: number): number | null {
  if (count <= 0) return null
  switch (key) {
    case 'ArrowDown':
      return Math.min(count - 1, current + 1)
    case 'ArrowUp':
      return Math.max(0, current - 1)
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return null
  }
}

/** 打开菜单时先高亮哪一项：选中项，没有就第一项；空列表返回 -1。
 *  Index to highlight on open: the selected one, else the first; -1 for an empty list. */
export function initialIndex(selected: number, count: number): number {
  if (count <= 0) return -1
  return selected >= 0 && selected < count ? selected : 0
}
