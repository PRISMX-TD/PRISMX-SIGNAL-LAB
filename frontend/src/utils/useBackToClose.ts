// 让弹窗/确认框接管手机的"返回"手势：打开时压入一条历史记录占位，
// 用户划一下返回（或按 Android 返回键）只关掉这个弹窗，而不是导航离开整个
// 页面。此前所有弹窗都只是纯 React state，浏览器的返回手势完全不知道弹窗的
// 存在，会直接触发路由级的后退——比如在图表页打开"指标设置"后一划返回，
// 退出的是整个图表页而不是弹窗，不符合 PWA 用户的直觉预期（弹窗应该先被
// "退出"）。
//
// Lets a modal/confirm-dialog claim the phone's "back" gesture: while open,
// it pushes a placeholder history entry, so swiping back (or pressing
// Android's back button) closes just that modal instead of navigating away
// from the whole page. Previously every modal was plain React state that the
// browser's back gesture had no notion of, so it fell straight through to a
// route-level back — e.g. opening "Indicator Settings" on the charts page and
// swiping back would exit the charts page entirely instead of the modal,
// which isn't what a PWA user expects (the modal should be what "backs out"
// first).
import { useEffect, useRef } from 'react'

// 当前打开的弹窗实例栈（后进先出，元素是每个实例自己的编号）。存在两个用途：
// 1. PwaBackGuard（见 components/PwaBackGuard.tsx）用"栈是否为空"判断这次
//    返回是不是已经有弹窗接管了，接管了就不该再抢着把它解读成"用户想彻底
//    退出"。
// 2. 弹窗可以互相嵌套（比如指标设置弹窗里的颜色选择面板）：一次 popstate
//    会让所有仍在监听的实例的处理函数都被调用一遍（原生事件监听没有"只通知
//    最后一个注册的"这种机制），如果每个实例收到就无条件关闭自己，嵌套时会
//    出现"划一次返回，内外两层一起被关掉"——实测复现过。用这个栈判断"我是
//    不是当前最上面（最后打开）那个"，只有栈顶的实例才应该把这次 popstate
//    当成"关闭我"，其余仍打开的祖先实例的历史记录根本没被消费，应该忽略
//    这次事件、继续挂着。
// Stack of currently open modal instances (LIFO; elements are each
// instance's own id). Serves two purposes:
// 1. PwaBackGuard (see components/PwaBackGuard.tsx) uses "is the stack
//    empty" to know whether this back navigation was already claimed by a
//    modal — if so, it shouldn't also interpret it as "the user wants to
//    exit entirely".
// 2. Modals can nest (e.g. the color picker inside the indicator settings
//    modal): a single popstate event invokes every still-listening
//    instance's handler (native event listeners have no "only notify the
//    most recently registered one" mechanism); if each instance
//    unconditionally closed itself on any popstate, nesting would mean one
//    back swipe closes both the inner and outer layers at once — reproduced
//    by hand. This stack answers "am I currently the topmost (most recently
//    opened) instance" — only the top of the stack should treat a given
//    popstate as "close me"; other still-open ancestors haven't actually had
//    their own history entry consumed and should ignore the event, staying
//    open.
const openStack: number[] = []
let nextId = 1

export function isAnyModalOpen(): boolean {
  return openStack.length > 0
}

export function useBackToClose(isOpen: boolean, onClose: () => void) {
  // 用 ref 存最新的 onClose，避免它的引用变化触发 effect 重新绑定
  // （每次渲染传一个新的箭头函数很常见，不应该导致重新 push 历史记录）。
  // Keep the latest onClose in a ref so its identity changing doesn't
  // re-trigger the effect (passing a fresh arrow function each render is
  // common and shouldn't cause a re-push of the history entry).
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  // 记录"这次打开是否还欠着一条历史记录没撤销"，避免重复 push/pop
  // Tracks whether this open still owes an un-popped history entry, to avoid
  // double-pushing or double-popping.
  const pendingRef = useRef(false)

  useEffect(() => {
    if (!isOpen) return

    const id = nextId++
    window.history.pushState({ __modalBack: true }, '', window.location.href)
    pendingRef.current = true
    openStack.push(id)

    const onPopState = () => {
      // 不是当前最上层：这次返回消费的是更上面某个实例的记录，跟我无关，
      // 忽略——我的记录还原封不动地留在栈里，继续挂着。
      // Not currently the topmost: this back navigation consumed some other,
      // more-recently-opened instance's entry, not mine — ignore it, my own
      // entry is still sitting there untouched.
      if (openStack[openStack.length - 1] !== id) return
      openStack.pop()
      pendingRef.current = false
      onCloseRef.current()
    }
    window.addEventListener('popstate', onPopState)

    return () => {
      window.removeEventListener('popstate', onPopState)
      if (!pendingRef.current) return
      pendingRef.current = false
      const stackIdx = openStack.lastIndexOf(id)
      if (stackIdx !== -1) openStack.splice(stackIdx, 1)

      // 弹窗是被"点击关闭/完成/确认"这类正常操作关掉的（不是靠返回手势），
      // 之前压入的那条历史记录还留在栈里，需要主动撤销，否则用户下次划
      // 返回会先"空转"一次（回到弹窗刚打开时的那个状态，界面上却看不出
      // 变化）才轮到真正离开页面。额外检查当前 history.state 确实还是我们
      // 压的那条标记——如果弹窗打开期间发生了其它真实导航（比如非全屏的
      // 小面板允许点穿到别的链接），history 顶端已经不是我们压的那条了，
      // 这时候瞎调 back() 反而会把用户刚点的导航撤销掉，宁可留一条无害的
      // 死记录也不做这个动作。
      // The modal was closed by a normal action (tap close/confirm/done),
      // not the back gesture, so the history entry pushed above is still
      // sitting on the stack — pop it now, otherwise the next back swipe
      // would "burn" one step landing back on the moment the modal opened
      // (visually indistinguishable, since the modal is already closed)
      // before the user could actually leave the page. Extra check: only do
      // this if history.state is still our own marker — if a real navigation
      // happened while the modal was open (e.g. a non-fullscreen panel that
      // lets clicks through to a nav link), the top of history is no longer
      // ours, and blindly calling back() would undo the navigation the user
      // just made. Leaving a harmless dead entry behind is the safer choice.
      if (!(window.history.state as { __modalBack?: boolean } | null)?.__modalBack) return

      // 关键点：这里主动调用的 history.back() 会异步触发一次 popstate——
      // PwaBackGuard 的监听器（挂载得比这里早，同一事件里总是先跑）此时也会
      // 收到这次 popstate。如果在这里就立刻把自己从 openStack 移除（已经
      // 移除了），等那次异步 popstate 真正到达时，栈可能已经空了，
      // PwaBackGuard 会误以为"没有弹窗接管这次返回"而抢着触发自己的跳转
      // 逻辑——这正是实测复现过的 bug（点击弹窗的关闭按钮后被跳到了另一个
      // 页面，而不是停在原地）。修复：临时把自己重新压回栈里，等这次自己
      // 触发的 popstate 真正落地之后才彻底移除。
      // Key point: the history.back() call below asynchronously fires a
      // popstate — PwaBackGuard's listener (mounted earlier, and thus always
      // runs first for the same event) also receives that popstate. If we'd
      // already removed ourselves from openStack (which we have), by the
      // time that async popstate arrives the stack could already be empty,
      // and PwaBackGuard would wrongly conclude "no modal claimed this back"
      // and fire its own redirect — this is exactly the bug reproduced by
      // hand (clicking a modal's close button ended up navigating to a
      // different page instead of staying put). Fix: temporarily push
      // ourselves back onto the stack until this self-triggered popstate
      // actually lands, then remove for good.
      openStack.push(id)
      const onSelfTriggeredPop = () => {
        window.removeEventListener('popstate', onSelfTriggeredPop)
        const i = openStack.lastIndexOf(id)
        if (i !== -1) openStack.splice(i, 1)
      }
      window.addEventListener('popstate', onSelfTriggeredPop)
      window.history.back()
    }
  }, [isOpen])
}
