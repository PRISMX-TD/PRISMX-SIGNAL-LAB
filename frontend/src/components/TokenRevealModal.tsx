// Token 生成后的强提醒弹窗：大字展示 + 一键复制，关闭前必须确认已保存
// Strong reveal modal shown right after generating a token: large text +
// one-click copy; the user must confirm they've saved it before closing.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

interface Props {
  token: string
  onClose: () => void
}

export default function TokenRevealModal({ token, onClose }: Props) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    await navigator.clipboard.writeText(token)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="slide-overlay">
      <div className="slide-sheet" style={{ width: 420 }}>
        <div className="flex flex-col items-center text-center">
          <div className="mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-prism-600/15 text-prism-300">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="11" width="18" height="10" rx="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
          </div>
          <h3 className="text-lg font-bold text-white">{t('bind.tokenTitle')}</h3>
          <p className="mt-1 text-sm text-amber-400/90">{t('bind.tokenJustOnce')}</p>
        </div>

        <div className="mt-4 break-all rounded-xl border border-prism-600/40 bg-prism-600/10 p-4 text-center font-mono text-base font-semibold text-prism-200">
          {token}
        </div>

        <div className="mt-4 flex gap-3">
          <button onClick={copy} className="btn-primary flex-1 py-2.5 text-sm">
            {copied ? t('common.copied') : t('common.copy')}
          </button>
        </div>
        <button onClick={onClose} className="btn-ghost mt-3 w-full py-2 text-sm">
          {t('bind.tokenSavedClose')}
        </button>
      </div>
    </div>
  )
}
