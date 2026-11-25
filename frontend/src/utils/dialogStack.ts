// 模态弹窗栈 + 读屏的「背景不可达」。
//
// 栈原来写在 useDialogA11y 里，只用来判断「我是不是最上面那层」（Esc / Tab 只给栈顶）。
// 现在它多管一件事：栈顶弹窗在 #root 外面（portal 到 body）时，把 #root 标成
// aria-hidden="true"。原因是 aria-modal 在安卓 TalkBack 与 iOS 13 以前的 VoiceOver 上
// 不生效，手指一划就读到弹窗后面的页面；inert 要 Chrome 102+，低于本项目 Chrome 70 的底线。
// 判断只看「栈顶在不在 #root 里」：手机「更多」抽屉这类不 portal 的弹窗就渲染在 #root
// 里面，给 #root 加 aria-hidden 会把它自己也藏掉；嵌套时（抽屉上再弹确认框）以最上面那层
// 为准，关掉上层自动回到下层的状态，等于按栈引用计数，不需要另外的计数器。
//
// Modal stack + "background unreachable" for screen readers. The stack used to live in
// useDialogA11y purely to answer "am I the topmost?" (Escape/Tab go to the top only).
// It now also sets aria-hidden="true" on #root while the topmost dialog sits outside
// #root (portalled to body): aria-modal is ignored by Android TalkBack and pre-iOS-13
// VoiceOver, and inert needs Chrome 102+, below our Chrome 70 floor. The decision is
// "is the top entry outside #root" only — non-portalled dialogs (the mobile "More"
// sheet) live inside #root and would hide themselves; with nesting the top entry wins
// and popping restores the layer below, which is reference counting by construction.

/** #root 需要的最小接口；测试里传假对象。/ The slice of #root we use; tests pass a fake. */
export interface AppRoot {
  contains(other: unknown): boolean
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
}

interface Entry {
  id: number
  el: unknown
}

const stack: Entry[] = []
let nextId = 1

const appRoot = (): AppRoot | null =>
  typeof document === 'undefined' ? null : document.getElementById('root')

function sync(app: AppRoot | null) {
  if (!app) return
  const top = stack[stack.length - 1]
  if (top && !app.contains(top.el)) app.setAttribute('aria-hidden', 'true')
  else app.removeAttribute('aria-hidden')
}

/** 弹窗打开：入栈并同步 #root。调用前先把焦点移进弹窗（见 useDialogA11y）。
 *  Dialog opened: push and sync #root. Move focus into the dialog first. */
export function pushDialog(el: unknown, app: AppRoot | null = appRoot()): number {
  const id = nextId++
  stack.push({ id, el })
  sync(app)
  return id
}

/** 弹窗关闭：出栈并同步 #root。调用后才把焦点还给 #root 里的打开者。
 *  Dialog closed: pop and sync #root. Return focus to the opener only afterwards. */
export function popDialog(id: number, app: AppRoot | null = appRoot()): void {
  const i = stack.findIndex((e) => e.id === id)
  if (i !== -1) stack.splice(i, 1)
  sync(app)
}

/** 弹窗容器的最小接口；测试里传假对象。/ The slice of a dialog element we use; tests pass a fake. */
export interface FocusTarget {
  contains(other: unknown): boolean
  focus(options?: FocusOptions): void
  hasAttribute(name: string): boolean
  setAttribute(name: string, value: string): void
}

/** 入栈前确认焦点已经离开 #root：先移焦点要是没成功（目标不可聚焦、进场动画里暂时不可见……），
 *  退回到弹窗容器本身；还不行就把原来的焦点放掉。否则入栈给 #root 加 aria-hidden 时焦点还在
 *  #root 里，Chrome 会拦下这次 aria-hidden 并在 console 报「Blocked aria-hidden…」，
 *  读屏也照样能读到弹窗背后的页面。
 *  Before pushing, make sure focus has left #root: if moving it in failed (target not
 *  focusable, momentarily invisible during an enter animation…), fall back to the dialog
 *  container; failing that, drop the old focus. Otherwise #root gets aria-hidden while it
 *  still holds focus, Chrome blocks it with "Blocked aria-hidden…" in the console, and
 *  screen readers still reach the page behind the dialog. */
export function settleFocus(dialog: FocusTarget, doc: { activeElement: unknown }): void {
  if (dialog.contains(doc.activeElement)) return
  if (!dialog.hasAttribute('tabindex')) dialog.setAttribute('tabindex', '-1')
  dialog.focus({ preventScroll: true })
  if (dialog.contains(doc.activeElement)) return
  const active = doc.activeElement as { blur?: () => void } | null
  active?.blur?.()
}

export function isTopDialog(id: number): boolean {
  return stack.length > 0 && stack[stack.length - 1].id === id
}
