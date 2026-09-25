// Google 登录按钮 / Google Sign-In button
// 使用 Google Identity Services 渲染官方按钮拿到 credential（ID Token）。
// 但 GSI/FedCM 的个性化按钮（“以 XX 的身份继续”）会跟随系统色彩模式渲染成白底，
// 无法通过 theme 或页面 color-scheme 强制变暗。为保持深色风格一致，这里把官方按钮
// 透明覆盖在自定义深色按钮之上——视觉完全由我们控制，点击仍走官方流程。
// Renders the official GIS button (returns the ID token) but overlays it transparently
// on top of our own dark-styled button, since the personalized FedCM button ignores
// the theme/color-scheme and renders white. Visuals are ours; clicks hit the real button.
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

// GSI 全局对象的最小类型声明 / minimal typing for the GSI global
interface GoogleCredentialResponse {
  credential: string
}
declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: {
            client_id: string
            callback: (resp: GoogleCredentialResponse) => void
          }) => void
          renderButton: (parent: HTMLElement, options: Record<string, unknown>) => void
        }
      }
    }
  }
}

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? ''

// GIS 脚本改为按钮挂载时才插入（原来写死在 index.html 的 <head> 里，每一页都去连
// accounts.google.com，而它在大陆连不通，会把 window load 拖到超时）。
// 只插一次：模块级标记 + DOM 里已有同 src 的 script 就不再插（登录页 ↔ 注册切换、
// StrictMode 双挂载都会让 effect 跑不止一次）。
// **已经有 window.google.accounts.id 时绝不插**：安卓 App（APP Pack）在 <head> 里同步
// 装了一个原生 Credential Manager 桥占住这个全局，真 GIS 晚到会把桥覆盖掉——APP Pack
// 原来靠在构建时摘掉 index.html 里那条 <script> 防这件事（stripGsiScript），现在脚本
// 是动态插的，摘不到，所以这里必须自己让开。
// 返回 false = 脚本加载失败（onerror），调用方可以不等 10 秒超时直接给出提示。
// The GIS script is now injected when the button mounts (it used to sit in
// index.html's <head>, hitting accounts.google.com on every page and holding up
// window load where that host is unreachable). Injected once: module flag plus a
// DOM check. Never injected when window.google.accounts.id already exists: the
// Android app (APP Pack) installs a native Credential Manager bridge there
// synchronously in <head>, and a late real GIS would overwrite it — APP Pack used
// to prevent that by stripping the static <script> at build time, which it cannot
// do for a dynamic one. Resolves false when the script fails to load.
const GSI_SRC = 'https://accounts.google.com/gsi/client'
let gsiLoad: Promise<boolean> | null = null
function loadGsiScript(): Promise<boolean> {
  if (window.google?.accounts?.id) return Promise.resolve(true)
  if (gsiLoad) return gsiLoad
  gsiLoad = new Promise<boolean>((resolve) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GSI_SRC}"]`)
    const el = existing ?? document.createElement('script')
    el.addEventListener('load', () => resolve(true), { once: true })
    el.addEventListener('error', () => {
      // 失败后允许下次挂载重试（换个网络、再进一次登录页）/ allow a retry on a later mount
      gsiLoad = null
      el.remove()
      resolve(false)
    }, { once: true })
    if (!existing) {
      el.src = GSI_SRC
      el.async = true
      el.defer = true
      document.head.appendChild(el)
    }
  })
  return gsiLoad
}

interface Props {
  onCredential: (credential: string) => void
  onError?: (msg: string) => void
}

// 官方 Google G 图标 / official multi-color Google "G" mark
function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden focusable="false">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z" />
      <path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.46 3.44 1.35l2.58-2.58C13.47.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z" />
    </svg>
  )
}

export default function GoogleLoginButton({ onCredential, onError }: Props) {
  const { t } = useTranslation()
  const wrapperRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const onCredentialRef = useRef(onCredential)
  onCredentialRef.current = onCredential
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError
  const tRef = useRef(t)
  tRef.current = t
  const [ready, setReady] = useState(false)
  // GSI 脚本没能加载（等到超时仍拿不到 window.google）。大陆访问时
  // accounts.google.com 不可达，这是**常态**而不是边缘情况。
  // The GSI script never arrived (window.google still absent at the deadline).
  // accounts.google.com is unreachable from mainland China, so this is the
  // normal case there, not an edge case.
  const [unavailable, setUnavailable] = useState(false)

  // 只在挂载时初始化一次；回调/翻译通过 ref 读取最新值，避免依赖变化导致
  // 重复 initialize() 或在 initialize() 之前就 renderButton()。
  // Init once on mount; read latest callback/t via refs so dep changes don't
  // re-initialize GSI or render the button before initialize() has run.
  useEffect(() => {
    if (!CLIENT_ID) return
    const container = containerRef.current
    const wrapper = wrapperRef.current
    if (!container || !wrapper) return

    let cancelled = false
    let initialized = false

    // 挂载时才去拉 GIS（见 loadGsiScript）。加载失败不必等满下面 10 秒的轮询。
    // Fetch GIS on mount (see loadGsiScript); a load error needn't wait out the 10s poll.
    void loadGsiScript().then((ok) => {
      if (!ok && !cancelled && !window.google?.accounts?.id) {
        window.clearInterval(timer)
        setUnavailable(true)
      }
    })

    const render = () => {
      const gsi = window.google?.accounts?.id
      // 必须先 initialize() 再 renderButton() / must initialize before rendering
      if (!gsi || cancelled || !initialized) return
      // 覆盖层的实际宽度用于官方按钮，保证透明点击区与可见按钮对齐
      // measure wrapper so the (transparent) official button covers our visible one
      const width = Math.min(400, Math.max(200, Math.round(wrapper.clientWidth)))
      container.innerHTML = ''
      gsi.renderButton(container, {
        theme: 'filled_black',
        size: 'large',
        shape: 'pill',
        text: 'continue_with',
        width,
      })
      setReady(true)
    }

    // GSI 脚本可能尚未加载完成，轮询等待——但必须有上限。
    //
    // 原来这个 100ms 定时器拿不到 window.google 就一直空转，没有次数也没有时间上限。
    // accounts.google.com 在大陆不可达，`window.google` 永远不会出现，于是登录页以
    // 10Hz 空跑到用户离开为止：纯耗电与主线程噪音，恰好落在"大陆访问慢 + 老机器"
    // 这条既定痛点上。更糟的是按钮永远停在 opacity-0（ready 恒为 false），那层透明
    // 覆盖层挡着下面那个装饰按钮，用户点上去毫无反应、也没有任何说明。
    // 10 秒 / 100 次：GSI 脚本是挂载时插入的 async 外链，正常网络下几百毫秒内到位；
    // 等满 10 秒还没有，就不是"慢"，是根本到不了。
    //
    // Poll for the async GSI script — but with a deadline. This 100ms timer used
    // to spin forever when window.google never appeared, with no attempt or time
    // limit. accounts.google.com is unreachable from mainland China, so the login
    // page ran at 10Hz until the user left: pure battery and main-thread noise,
    // landing squarely on the known "mainland is slow, phones are old" pain
    // point. Worse, the button stayed at opacity-0 (ready never became true)
    // while its transparent overlay still covered the decorative button beneath,
    // so taps did nothing and nothing explained why. 10s / 100 attempts: the GSI
    // script is an async defer external and lands within a few hundred
    // milliseconds on a healthy network; ten seconds of silence is not "slow",
    // it is "cannot be reached".
    let attempts = 0
    const MAX_ATTEMPTS = 100 // × 100ms = 10s
    const timer = window.setInterval(() => {
      if (cancelled) return
      const gsi = window.google?.accounts?.id
      if (!gsi) {
        if (++attempts >= MAX_ATTEMPTS) {
          window.clearInterval(timer)
          setUnavailable(true)
        }
        return
      }
      window.clearInterval(timer)
      gsi.initialize({
        client_id: CLIENT_ID,
        callback: (resp) => {
          if (resp.credential) onCredentialRef.current(resp.credential)
          else onErrorRef.current?.(tRef.current('auth.googleError'))
        },
      })
      initialized = true
      render()
    }, 100)

    // 宽度变化（如旋转屏幕）时重新渲染官方按钮以保持覆盖对齐
    // re-render on resize so the transparent overlay keeps covering the visible button
    const ro = new ResizeObserver(() => {
      if (initialized) render()
    })
    ro.observe(wrapper)

    return () => {
      cancelled = true
      window.clearInterval(timer)
      ro.disconnect()
    }
  }, [])

  // 未配置 Client ID 时不渲染（如本地未设环境变量）/ render nothing if not configured
  if (!CLIENT_ID) return null

  return (
    <div ref={wrapperRef} className="relative w-full">
      {/* 可见的深色按钮（视觉层，不接收点击）/ visible dark button (decorative)
          GSI 不可用时把它整体压暗：它永远不会真的可点（官方按钮根本没渲染出来），
          继续保持 hover 高亮就是在骗人。下面那句说明才是用户真正需要的信息。
          Dimmed when GSI is unavailable: it can never actually be clicked (the
          real button was never rendered), and keeping the hover highlight would
          be a lie. The line below is the information the user actually needs. */}
      <div
        aria-hidden
        className={`flex h-11 w-full items-center justify-center gap-2.5 rounded-full border border-white/15 bg-white/[0.06] px-4 text-sm font-medium text-neutral-100 transition ${
          unavailable ? 'opacity-40' : 'hover:border-white/25 hover:bg-white/[0.1]'
        }`}
      >
        <GoogleIcon />
        <span>{t('auth.googleContinue')}</span>
      </div>
      {/* 官方 Google 按钮（透明覆盖在上层，负责实际点击）/ real GSI button, transparent on top */}
      <div
        ref={containerRef}
        className={`absolute inset-0 flex items-center justify-center overflow-hidden ${ready ? 'opacity-[0.001]' : 'opacity-0'}`}
      />
      {/* role="status"：这条是异步到达的状态说明（等了 10 秒才出现），不是页面
          原有内容，屏幕阅读器应当被动播报一次。
          role="status": this arrives asynchronously (ten seconds in) rather than
          being part of the original page, so a screen reader should announce it. */}
      {unavailable && (
        <p role="status" className="mt-2 text-center text-xs leading-relaxed text-neutral-500">
          {t('auth.googleUnavailable')}
        </p>
      )}
    </div>
  )
}
