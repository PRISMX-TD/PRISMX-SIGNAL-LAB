// 读屏播报 / screen-reader announcements.
//
// Layout 里常驻两个空的 live region（components/LiveRegions.tsx）：role="status"（polite）
// 和 role="alert"（assertive）。要播报时往里写字，而不是新挂载一个已经带字的 role="status"。
// 原因：live region 必须先存在、内容后变化，读屏器才会可靠地读出来；随文字一起挂载的区域在
// TalkBack / VoiceOver 上经常整句被跳过，以前的 toast 就是这样挂载的。错误用 assertive
// （打断当前朗读），其余用 polite。
//
// Two empty live regions stay mounted in Layout (components/LiveRegions.tsx): role="status"
// (polite) and role="alert" (assertive). Announcing writes text into them instead of mounting a
// role="status" that already holds its text: a live region must exist before its content
// changes for screen readers to read it reliably, and one mounted together with its text is
// often skipped by TalkBack / VoiceOver, which is how the toast used to mount. Errors are
// assertive; everything else is polite.
//
// 用全局 setTimeout 而不是 window.setTimeout：单测跑在没有 window 的 node 环境里。
// Global setTimeout rather than window.setTimeout: the unit test runs in node, with no window.

export type Politeness = 'polite' | 'assertive'

const regions: Record<Politeness, HTMLElement | null> = { polite: null, assertive: null }
const timers: Record<Politeness, ReturnType<typeof setTimeout> | undefined> = { polite: undefined, assertive: undefined }

/** LiveRegions 挂载时登记、卸载时传 null / registered by LiveRegions on mount, null on unmount */
export function registerLiveRegion(politeness: Politeness, el: HTMLElement | null): void {
  regions[politeness] = el
}

/** 播报一句话；没有登记的区域（页面不在 Layout 下）时什么都不做。
 *  Announce one line; a no-op when no region is registered (page outside Layout). */
export function announce(text: string, politeness: Politeness = 'polite'): void {
  const el = regions[politeness]
  if (!el || !text) return
  // 先清空、隔 50ms 再写：同一句话连续出现两次（例如连着两次被拒）时，内容没变，读屏器不会
  // 再读第二遍。连续两句时只留最后一句。
  // Clear, then write 50ms later: an identical line twice in a row (two rejections) is
  // otherwise no change and is not read again. Two lines in quick succession keep the last.
  el.textContent = ''
  clearTimeout(timers[politeness])
  timers[politeness] = setTimeout(() => { el.textContent = text }, 50)
}
