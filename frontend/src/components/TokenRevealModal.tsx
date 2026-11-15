// Token 生成后的强提醒弹窗：大字展示 + 一键复制，关闭前必须确认已保存
// Strong reveal modal shown right after generating a token: large text +
// one-click copy; the user must confirm they've saved it before closing.
import { useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useDialogA11y } from '../utils/useDialogA11y'
import { copyToClipboard } from './Copyable'

interface Props {
  token: string
  onClose: () => void
}

export default function TokenRevealModal({ token, onClose }: Props) {
  const { t } = useTranslation()
  const [copyState, setCopyState] = useState<'idle' | 'ok' | 'err'>('idle')
  // 只补 role / 焦点陷阱，**不**让 Esc 关：唯一的关闭按钮语义是"我已保存 token"，Esc
  // 一键跳过这个确认就违背了弹窗存在的目的。
  // role + focus trap only; Escape deliberately does NOT close — the sole close
  // button means "I have saved the token", and Escape would skip that acknowledgement.
  const sheetRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  useDialogA11y(sheetRef, onClose, { closeOnEscape: false })

  // 复制失败必须说出来：安卓 WebView 会拒绝剪贴板，而这个 Token 关掉弹窗后就再也看不到
  // 了。按钮字换成「复制失败，请手动选中」，与 AgentPage 的复制按钮同一做法。
  // A failed copy must say so: Android WebViews can refuse the clipboard and this token
  // is never shown again after closing. Same pattern as AgentPage's copy buttons.
  const copy = async () => {
    const ok = await copyToClipboard(token)
    setCopyState(ok ? 'ok' : 'err')
    setTimeout(() => setCopyState('idle'), ok ? 2000 : 2500)
  }

  // portal 到 body：调用点在 .glass 卡片里，backdrop-filter / transform 会劫持
  // fixed 的包含块。宽度用 sm: 前缀而不是内联 style——内联会覆盖 .slide-sheet 的
  // 手机端媒体查询，把贴底抽屉挤成一个窄条（ConfirmModal 里记过同一课）。
  // Portal to body (the caller sits inside a .glass card whose backdrop-filter
  // hijacks fixed positioning). Width via sm: prefix, never inline style, which
  // would override .slide-sheet's mobile media query.
  return createPortal(
    <div className="slide-overlay">
      <div ref={sheetRef} className="slide-sheet sm:w-[420px]" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <div className="flex flex-col items-center text-center">
          <div className="mb-3 grid h-12 w-12 place-items-center rounded-card bg-prism-600/15 text-prism-300">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="11" width="18" height="10" rx="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
          </div>
          <h3 id={titleId} className="text-lg font-bold text-white">{t('bind.tokenTitle')}</h3>
          <p className="mt-1 text-sm text-warn/90">{t('bind.tokenJustOnce')}</p>
        </div>

        <div className="mt-4 break-all rounded-panel border border-prism-600/40 bg-prism-600/10 p-4 text-center font-mono text-base font-semibold text-prism-200 select-all">
          {token}
        </div>

        <div className="mt-4 flex gap-3">
          <button onClick={copy} className="btn-primary flex-1 py-2.5 text-sm">
            {copyState === 'ok' ? t('common.copied') : copyState === 'err' ? t('bind.tokenCopyFailed') : t('common.copy')}
          </button>
        </div>
        <span className="sr-only" role="status">{copyState === 'err' ? t('bind.tokenCopyFailed') : ''}</span>
        <button onClick={onClose} className="btn-ghost mt-3 w-full py-2 text-sm">
          {t('bind.tokenSavedClose')}
        </button>
      </div>
    </div>,
    document.body,
  )
}
