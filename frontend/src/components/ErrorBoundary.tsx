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
import { isChunkLoadError, isOldEngineError, reportClientError } from '../utils/clientErrorReport'
import { clearChunkReloadFlags } from '../utils/lazyRetry'

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

// 错误分三类，卡片说三种话。原来只有一句「页面渲染时遇到错误…重新加载」，而三类里
// 有两类重载根本没用：chunk 拉不下来要换网络，引擎太老要更新浏览器。说错话的代价是
// 用户反复点重载、然后报「一直渲染失败」，我们再从头猜一遍。
// Three kinds, three messages. The single old line told everyone to reload, yet
// for two of the three kinds reloading is useless: a failed chunk needs a better
// network, an old engine needs a browser update. The wrong message costs the user
// a loop of reloads and us another round of guessing from "it always fails".
type ErrorKind = 'render' | 'chunk' | 'oldBrowser'

function classify(error: unknown): ErrorKind {
  if (isChunkLoadError(error)) return 'chunk'
  if (isOldEngineError(error)) return 'oldBrowser'
  return 'render'
}

type State = { error: unknown | null }

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: unknown): State {
    return { error: error ?? new Error('unknown render error') }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack)
    // 上报到 /api/telemetry/client-error（后端只写日志）。以前这里只有上面那行
    // console.error——线上一条数据都没有，用户说"渲染失败"时分不清是大陆拉不到
    // chunk、是代码 bug、还是 App 特有。kind 区分开：chunk 是网络/发版陈旧，
    // render 才是代码。lazyRetry 已在自己那边上报过的 chunk 失败这里不会重复——
    // 它抛给我们的错只有一次，就是重试耗尽那一次。
    // Reported to the log-only telemetry endpoint. `chunk` = network / stale
    // deploy, `render` = an actual code bug; that split is the whole point.
    // 引擎太老也归到 render：telemetry 的 kind 白名单只有三种，而它的 name 字段会写
    // SyntaxError，日志里一眼能分出来，不必为它多开一种。
    // Old-engine errors report as 'render': the telemetry kind whitelist has three
    // values, and the name field carries SyntaxError, which is enough to tell apart.
    reportClientError(isChunkLoadError(error) ? 'chunk' : 'render', error, {
      componentStack: (info.componentStack ?? '').slice(0, 1500),
    })
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error != null && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null })
    }
  }

  render() {
    if (this.state.error != null) return <ErrorFallback kind={classify(this.state.error)} />
    return this.props.children
  }
}

// 单独抽成函数组件，好用 useTranslation —— class 组件里用不了 hook。
// Split out as a function component so useTranslation works; hooks can't run
// inside a class component.
function ErrorFallback({ kind }: { kind: ErrorKind }) {
  const { t } = useTranslation()
  const title = kind === 'oldBrowser' ? t('common.errorBoundary.oldBrowserTitle') : t('common.errorBoundary.title')
  const desc =
    kind === 'chunk'
      ? t('common.errorBoundary.chunkDesc')
      : kind === 'oldBrowser'
        ? t('common.errorBoundary.oldBrowserDesc')
        : t('common.errorBoundary.desc')
  // 用户主动要求重载：把 lazyRetry 的「五分钟内已自动重载过」标记清掉，让这次重载
  // 之后的 chunk 失败重新走完整的重试 → 自动重载梯子。/ A deliberate reload from the
  // user clears lazyRetry's auto-reload marks so the next failure gets the full ladder.
  const reload = () => {
    clearChunkReloadFlags()
    location.reload()
  }
  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4">
      <div className="glass w-full max-w-md p-8 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-down/10 text-2xl text-down">
          !
        </div>
        <h2 className="font-display text-lg font-semibold text-neutral-100">
          {title}
        </h2>
        <p className="mt-2 text-sm text-neutral-400">{desc}</p>
        <button
          onClick={reload}
          className="btn-primary mt-6 h-11 w-full text-sm font-semibold"
        >
          {t('common.errorBoundary.reload')}
        </button>
      </div>
    </div>
  )
}
