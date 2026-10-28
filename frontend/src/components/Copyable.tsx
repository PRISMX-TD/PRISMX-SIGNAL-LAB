// 点一下就复制的文字（2026-10-28）：管理后台、客服台里凡是客户信息（昵称、邮箱、手机号、MT5 账号、
// 转账地址……）都包一层，点它复制它自己。悬停出现虚线下划线和复制光标；复制成功在被点的位置上方
// 冒一个「已复制」小气泡，不依赖页面自己的提示条，所以放在哪个面板里都一样用。
// 很多地方它住在一个可点的整行按钮里（工单列表），所以点击不冒泡、不触发整行。
// Click-to-copy text (2026-10-28): every piece of customer info in the admin console and the
// support desk (nickname, email, phone, MT5 login, payout address…) is wrapped so clicking it
// copies it. Hover shows a dotted underline and the copy cursor; a successful copy pops a small
// "Copied" bubble above the spot, independent of each page's own toast, so it works in any
// panel. It often lives inside a clickable row button (ticket list), so the click never
// bubbles up to trigger the row.
import type { KeyboardEvent, MouseEvent, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import '../styles/copyable.css'

// 剪贴板：优先 Clipboard API；不可用时（非安全上下文、部分安卓 WebView）退回隐藏 textarea + execCommand。
// Clipboard API first; falls back to a hidden textarea + execCommand where it's missing (insecure
// contexts, some Android WebViews).
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // 落到下面的兜底 / fall through to the fallback
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    ta.style.top = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  } catch {
    return false
  }
}

// 在某个元素上方冒一个小气泡，1.2 秒后自己消失 / pop a small bubble above an element; gone after 1.2s
export function flashCopied(el: Element | null, text: string, failed = false) {
  if (!el || typeof document === 'undefined') return
  const r = el.getBoundingClientRect()
  const tip = document.createElement('div')
  tip.className = `cpy-tip${failed ? ' is-err' : ''}`
  tip.setAttribute('role', 'status')
  tip.textContent = text
  tip.style.left = `${Math.round(r.left + r.width / 2)}px`
  tip.style.top = `${Math.round(r.top)}px`
  document.body.appendChild(tip)
  window.setTimeout(() => tip.remove(), 1200)
}

export default function Copyable({
  text,
  children,
  className = '',
  label,
}: {
  // 要复制的内容；空就原样显示、不可点 / what gets copied; empty renders plain, not clickable
  text: string | null | undefined
  children?: ReactNode
  className?: string
  // 气泡里显示的名字（如「邮箱」），不给就只说「已复制」/ name shown in the bubble, e.g. "Email"
  label?: string
}) {
  const { t } = useTranslation()
  const value = (text ?? '').trim()
  if (!value || value === '-') return <span className={className}>{children ?? text}</span>

  const copy = async (e: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>) => {
    e.preventDefault()
    e.stopPropagation()
    const el = e.currentTarget
    const ok = await copyToClipboard(value)
    flashCopied(
      el,
      ok ? (label ? t('supportDesk.copy.copiedWhat', { what: label }) : t('supportDesk.copy.copied')) : t('supportDesk.copy.failed'),
      !ok,
    )
  }

  return (
    <span
      role="button"
      tabIndex={0}
      className={`cpy ${className}`}
      title={t('supportDesk.copy.hint', { text: value })}
      onClick={(e) => void copy(e)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') void copy(e)
      }}
    >
      {children ?? value}
    </span>
  )
}
