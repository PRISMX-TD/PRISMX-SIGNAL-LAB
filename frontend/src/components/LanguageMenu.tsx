// 语言下拉的纯 UI（原 LanguageToggle 的外观与交互，原注释见 LanguageToggle.tsx 头部）。
// 选了什么由调用方决定怎么处理：站内（LanguageToggle）写偏好并上云；公开比赛页只改 URL 的
// ?lang= 并 syncLanguage，不写任何偏好。
// The language dropdown's pure UI (look and behaviour of the former LanguageToggle).
// The caller decides what a choice does: in-app (LanguageToggle) saves the preference and
// syncs it to the cloud; the public competition page only updates ?lang= and syncs.
import { useEffect, useRef, useState } from 'react'
import { APP_LANGS, type AppLang } from '../i18n'
import { usePopoverEscape } from '../utils/usePopoverEscape'

export default function LanguageMenu({ value, onChoose, placement = 'down' }: {
  value: AppLang
  onChoose: (lang: AppLang) => void
  placement?: 'down' | 'up'
}) {
  const cur = APP_LANGS.find((l) => l.code === value) ?? APP_LANGS[0]
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  // Esc 走捕获阶段并截住：这个下拉放在手机「更多」抽屉里，抽屉的 Esc 不该跟着触发。
  // Escape is handled in the capture phase and stopped: this list sits inside the mobile
  // "More" sheet, whose own Escape must not fire too.
  usePopoverEscape(open, () => setOpen(false), btnRef, rootRef)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('touchstart', onDown)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('touchstart', onDown)
    }
  }, [open])

  const choose = (next: AppLang) => {
    setOpen(false)
    btnRef.current?.focus({ preventScroll: true })
    if (next !== value) onChoose(next)
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Language / 语言: ${cur.label}`}
        className="rounded-lg border border-white/10 px-2.5 py-1.5 text-sm font-medium text-neutral-300 transition-colors hover:border-white/20 hover:text-neutral-100"
      >
        {cur.short}
      </button>
      {open && (
        <ul
          role="listbox"
          aria-label="Language / 语言"
          className={`absolute right-0 z-menu w-40 rounded-panel float-panel p-1.5 ${placement === 'up' ? 'bottom-full mb-2' : 'top-full mt-2'}`}
        >
          {APP_LANGS.map((l) => {
            const active = l.code === value
            return (
              <li key={l.code} role="option" aria-selected={active}>
                <button
                  type="button"
                  lang={l.code}
                  onClick={() => choose(l.code)}
                  className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition hover:bg-white/5 ${active ? 'text-prism-200' : 'text-neutral-300 hover:text-neutral-100'}`}
                >
                  <span>{l.label}</span>
                  {active && <span aria-hidden="true">✓</span>}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
