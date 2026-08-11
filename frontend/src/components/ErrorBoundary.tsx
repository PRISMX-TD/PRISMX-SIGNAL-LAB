// 全局渲染错误兜底。
//
// 在此之前，任何一处渲染期抛错（图表页的一个 undefined、持仓浮层的一次越界
// 读取）都会让 React 卸载整棵树 —— 用户看到的是纯黑白屏，只能自己想到刷新，
// 而我们这边毫无察觉。兜底之后同样的错误只换成一张卡片，用户点一下就能回来。
//
// 刻意放在 Suspense 外层：这样懒加载模块本身加载失败（网络抖动导致 chunk
// 404，发版后旧页面尤其容易遇到）也会被接住，而不是变成一个无人处理的
// promise rejection。
//
// Global render-error fallback. Before this, any throw during render (an
// undefined in the charts page, an out-of-range read in the position overlay)
// unmounted the whole tree: the user got a blank screen with no hint beyond
// "try refreshing", and we never heard about it. Now the same error renders a
// card they can recover from in one click.
// Deliberately outside Suspense so a lazy chunk that fails to load (a 404 on
// an old page after a deploy, a network blip) is caught here too, instead of
// becoming an unhandled rejection.
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

type Props = {
  children: ReactNode
  // 变化时清除已捕获的错误。上层传当前路径：用户从崩掉的页面导航走，就该
  // 自动恢复，而不是逼他刷新整页。
  //
  // 注意这里用的是 componentDidUpdate 比对，而不是给本组件挂 key —— 挂 key
  // 会让每次路由切换都重建整棵子树，连带把 Layout 里的 LiveProvider 一起拆
  // 掉重连 WebSocket。只在"确实处于错误态"时清状态，无错误时零影响。
  //
  // Changing this clears a captured error. The caller passes the current path:
  // navigating away from a broken page should recover on its own rather than
  // forcing a full reload. This is a componentDidUpdate comparison rather than
  // a key on this component on purpose — keying would rebuild the whole subtree
  // on every navigation, tearing down LiveProvider in Layout and reconnecting
  // the WebSocket each time. State is only cleared when actually in an error
  // state; there is zero effect on the normal path.
  resetKey?: string
}

type State = { hasError: boolean }

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 接入错误监控后在这里上报（见优化清单 [8]）。在那之前至少留一份控制台
    // 记录 —— 白屏时用户描述不清，控制台堆栈是唯一能问出来的线索。
    // Report to error monitoring here once it's wired up (plan item [8]).
    // Until then keep a console record: users can't describe a blank screen,
    // and this stack is the only thing we can ask them for.
    console.error('[ErrorBoundary]', error, info.componentStack)
  }

  componentDidUpdate(prev: Props) {
    if (this.state.hasError && prev.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false })
    }
  }

  render() {
    if (this.state.hasError) return <ErrorFallback />
    return this.props.children
  }
}

// 单独抽成函数组件，好用 useTranslation —— class 组件里用不了 hook。
// Split out as a function component so useTranslation works; hooks can't run
// inside a class component.
function ErrorFallback() {
  const { t } = useTranslation()
  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4">
      <div className="glass w-full max-w-md p-8 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-down/10 text-2xl text-down">
          !
        </div>
        <h2 className="font-display text-lg font-semibold text-neutral-100">
          {t('common.errorBoundary.title')}
        </h2>
        <p className="mt-2 text-sm text-neutral-400">{t('common.errorBoundary.desc')}</p>
        <button
          onClick={() => location.reload()}
          className="btn-primary mt-6 h-11 w-full text-sm font-semibold"
        >
          {t('common.errorBoundary.reload')}
        </button>
      </div>
    </div>
  )
}
