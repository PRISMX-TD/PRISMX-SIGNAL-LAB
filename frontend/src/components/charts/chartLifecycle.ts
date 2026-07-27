/** 记录哪些 chart 已经被 remove() 销毁，供子组件在 cleanup 里判断能否再碰它。
 *
 * 为什么需要它：React 卸载时按父 → 子的顺序执行 cleanup。ChartsPage 是父，它的
 * cleanup 先跑 chart.remove()；等到 PositionOverlay 这类子组件的 cleanup 执行
 * series.detachPrimitive() 时，chart 和 series 都已经销毁了。
 *
 * 光用 try/catch 包住 detachPrimitive() 不够：detach 内部通过
 * requestAnimationFrame 排一帧重绘，"Object is disposed" 是下一帧在
 * fancy-canvas 的 canvasElement getter 里抛出来的（销毁时 _canvasElement 被置
 * null），已经不在 detach 的同步栈上，catch 抓不到，只会变成控制台里的
 * Uncaught Error。所以必须先判断、根本不去调用——不调用就不会排帧。
 *
 * 用外部登记而不是探测 chart 状态：lightweight-charts 的 remove() 只是清空内部
 * 结构，不设任何 disposed 标记，也没有公开 isDisposed 接口；像 timeScale().width()
 * 这类 getter 在销毁后仍会正常返回值，探测不出来。销毁时机只有调用 remove() 的那
 * 一方知道，所以由它显式登记。
 *
 * 用 WeakSet 存：不持有 chart 的强引用，chart 被回收时登记自动消失，不会泄漏。
 *
 * Tracks which charts have been destroyed via remove(), so child components can
 * tell whether it's still safe to touch them during cleanup.
 *
 * Why this exists: React runs cleanups parent-first. ChartsPage is the parent, so
 * its cleanup calls chart.remove() before children like PositionOverlay get to run
 * series.detachPrimitive() — by which point both chart and series are gone.
 *
 * Wrapping detachPrimitive() in try/catch isn't enough: detach schedules a redraw
 * via requestAnimationFrame, and "Object is disposed" is thrown on the *next*
 * frame from fancy-canvas's canvasElement getter (_canvasElement is nulled on
 * dispose), off the synchronous stack where catch can't reach it — it surfaces as
 * an uncaught console error. So the call has to be skipped up front; no call means
 * no scheduled frame.
 *
 * Registered externally rather than probed: lightweight-charts' remove() only
 * clears internal structures without setting any disposed flag, and exposes no
 * isDisposed API — getters like timeScale().width() still return values after
 * disposal, so there's nothing to probe. Only the caller of remove() knows when it
 * happened, so it registers explicitly.
 *
 * A WeakSet holds no strong reference, so entries disappear with the chart itself.
 */
const disposedCharts = new WeakSet<object>()

/** 在调用 chart.remove() 之后立即登记。/ Call right after chart.remove(). */
export function markChartDisposed(chart: object): void {
  disposedCharts.add(chart)
}

/** chart 是否仍可安全调用。/ Whether the chart is still safe to call into. */
export function isChartAlive(chart: object | null | undefined): boolean {
  return !!chart && !disposedCharts.has(chart)
}
