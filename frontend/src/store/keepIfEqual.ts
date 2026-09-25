// 「内容没变就沿用旧引用」的比较工具，从 live.tsx 拆出来单独可测。
// Keep-the-old-reference helpers, split out of live.tsx so they can be unit-tested.

// 浅比较两个对象的自有字段（值均为原始类型时可靠）/ shallow-compare own fields
export function shallowEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null || b == null || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a as object)
  const kb = Object.keys(b as object)
  if (ka.length !== kb.length) return false
  for (const k of ka) {
    if ((a as Record<string, unknown>)[k] !== (b as Record<string, unknown>)[k]) return false
  }
  return true
}

// 内容未变则保留旧引用，避免无意义的整树重渲染（持仓每 1.5 秒、账号每 5 秒
// 会重复推送相同数据）。改用浅比较替代双重 JSON.stringify，省下主线程序列化开销。
//
// 比较深度固定两层：数组逐项、字典逐值，各自再做一次浅比较——正好覆盖
// 「Position[]」「{symbol: Quote}」「{symbol: Trend}」这类「容器 + 扁平记录」。
// 更深一层的嵌套对象按引用比，接口每次都回新对象，于是判为「变了」、换新引用：
// 这个方向只会多渲染一次，绝不会把真变化吞掉。
//
// Keep the previous reference when content is unchanged, so identical pushes
// (positions every 1.5s, accounts every 5s) don't re-render. Two levels deep:
// arrays item by item and dictionaries value by value, each shallow-compared —
// exactly the "container of flat records" shape of Position[], {symbol: Quote}
// and {symbol: Trend}. Anything nested deeper compares by reference, which a
// fresh API response never matches, so it errs towards one extra render and
// never swallows a real change.
export function keepIfEqual<T>(prev: T, next: T): T {
  if (prev === next) return prev
  if (Array.isArray(prev) && Array.isArray(next)) {
    if (prev.length !== next.length) return next
    for (let i = 0; i < prev.length; i++) {
      if (!shallowEqual(prev[i], next[i])) return next
    }
    return prev
  }
  if (prev == null || next == null || typeof prev !== 'object' || typeof next !== 'object') {
    return next
  }
  if (Array.isArray(prev) !== Array.isArray(next)) return next
  const kp = Object.keys(prev as object)
  const kn = Object.keys(next as object)
  if (kp.length !== kn.length) return next
  for (const k of kp) {
    if (!Object.prototype.hasOwnProperty.call(next, k)) return next
    if (!shallowEqual((prev as Record<string, unknown>)[k], (next as Record<string, unknown>)[k])) return next
  }
  return prev
}
