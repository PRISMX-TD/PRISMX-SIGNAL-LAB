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
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (!CLIENT_ID) return
    const container = containerRef.current
    const wrapper = wrapperRef.current
    if (!container || !wrapper) return

    let cancelled = false

    const render = () => {
      const gsi = window.google?.accounts?.id
      if (!gsi || cancelled) return
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

    // GSI 脚本可能尚未加载完成，轮询等待 / poll until the async GSI script is ready
    const timer = window.setInterval(() => {
      if (cancelled) return
      const gsi = window.google?.accounts?.id
      if (!gsi) return
      window.clearInterval(timer)
      gsi.initialize({
        client_id: CLIENT_ID,
        callback: (resp) => {
          if (resp.credential) onCredentialRef.current(resp.credential)
          else onError?.(t('auth.googleError'))
        },
      })
      render()
    }, 100)

    // 宽度变化（如旋转屏幕）时重新渲染官方按钮以保持覆盖对齐
    // re-render on resize so the transparent overlay keeps covering the visible button
    const ro = new ResizeObserver(() => {
      if (window.google?.accounts?.id) render()
    })
    ro.observe(wrapper)

    return () => {
      cancelled = true
      window.clearInterval(timer)
      ro.disconnect()
    }
  }, [t, onError])

  // 未配置 Client ID 时不渲染（如本地未设环境变量）/ render nothing if not configured
  if (!CLIENT_ID) return null

  return (
    <div ref={wrapperRef} className="relative w-full">
      {/* 可见的深色按钮（视觉层，不接收点击）/ visible dark button (decorative) */}
      <div
        aria-hidden
        className="flex h-11 w-full items-center justify-center gap-2.5 rounded-full border border-white/15 bg-white/[0.06] px-4 text-sm font-medium text-slate-100 transition hover:border-white/25 hover:bg-white/[0.1]"
      >
        <GoogleIcon />
        <span>{t('auth.googleContinue')}</span>
      </div>
      {/* 官方 Google 按钮（透明覆盖在上层，负责实际点击）/ real GSI button, transparent on top */}
      <div
        ref={containerRef}
        className={`absolute inset-0 flex items-center justify-center overflow-hidden ${ready ? 'opacity-[0.001]' : 'opacity-0'}`}
      />
    </div>
  )
}
