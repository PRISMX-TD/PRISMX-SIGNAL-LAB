// PWA 回退守卫：拦截 Android 回退手势/按钮，改为应用内导航而非退出程序
// PWA back guard: intercept Android back gesture to navigate in-app instead of closing

import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import type { ReactNode } from 'react'
import { isAnyModalOpen } from '../utils/useBackToClose'

export default function PwaBackGuard({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  const guardRef = useRef(false)

  useEffect(() => {
    // 注入一条守卫 history，确保回退不会直接退出 PWA
    // Inject a guard history entry so back never exits the PWA entirely
    if (!guardRef.current) {
      guardRef.current = true
      window.history.pushState({ __pwaGuard: true }, '', window.location.href)
    }

    const handlePopState = () => {
      // 如果这次返回是被某个弹窗（useBackToClose）接管的，就不要再抢着把它
      // 也解读成"用户想彻底退出"——真实场景：页面刚加载就立刻打开一个弹窗
      // （此时守卫条目正好是当前状态），关掉弹窗退的这一步会正好落回守卫
      // 条目本身，若不做这个判断，会被误判成"退到底了"而强制跳转到 /app，
      // 而用户其实只是想关掉弹窗、留在原页面（手测复现过这个问题）。
      // isAnyModalOpen() 在这个事件分发的这一刻仍然反映"关闭前"的状态——
      // useBackToClose 自己的 popstate 监听是在这个监听器之后才注册的
      // （本组件在应用根部一次性挂载，早于任何弹窗），所以两者处理同一个
      // popstate 事件时，这里读到的还是"是的，有弹窗正在被关闭"。
      // If this back navigation was already claimed by a modal
      // (useBackToClose), don't also interpret it as "the user wants to exit
      // entirely". Real scenario: a modal opens right after the page loads
      // (the guard entry happens to be the current state at that moment);
      // closing the modal pops back exactly onto the guard entry, and
      // without this check that gets misread as "hit rock bottom" and
      // force-navigates to /app — but the user only meant to close the modal
      // and stay on the current page (reproduced by hand). isAnyModalOpen()
      // still reflects the pre-close state at the moment this event
      // dispatches — useBackToClose's own popstate listener is registered
      // after this one (this component mounts once at the app root, before
      // any modal), so when both handle the same popstate event, this one
      // still sees "yes, a modal is currently being closed".
      if (isAnyModalOpen()) return
      // 如果用户回退到了守卫条目，回推守卫并导航到应用首页
      // If user reaches the guard entry, push it back and navigate to app home
      if (window.history.state?.__pwaGuard) {
        window.history.pushState({ __pwaGuard: true }, '', window.location.href)
        navigate('/app', { replace: true })
      }
    }

    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [navigate])

  return <>{children}</>
}
