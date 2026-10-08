// 语言下拉的纯 UI（原 LanguageToggle 的外观与交互，原注释见 LanguageToggle.tsx 头部）。
// 选了什么由调用方决定怎么处理：站内（LanguageToggle）写偏好并上云；公开比赛页只改 URL 的
// ?lang= 并 syncLanguage，不写任何偏好。
// The language dropdown's pure UI (look and behaviour of the former LanguageToggle).
// The caller decides what a choice does: in-app (LanguageToggle) saves the preference and
// syncs it to the cloud; the public competition page only updates ?lang= and syncs.
import { useEffect, useRef, useState } from 'react'
import { APP_LANGS, type AppLang } from '../i18n'

export default function LanguageMenu({ value, onChoose, placement = 'down' }: {
  value: AppLang
  onChoose: (lang: AppLang) => void
  placement?: 'down' | 'up'
}) {
  const cur = APP_LANGS.find((l) => l.code === value) ?? APP_LANGS[0]
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('touchstart', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('touchstart', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const choose = (next: AppLang) => {
    setOpen(false)
    if (next !== value) onChoose(next)
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Language / 语言: ${cur.label}`}
        className="rounded-inner border border-white/10 px-2.5 py-1.5 text-sm font-medium text-neutral-300 transition-colors hover:border-white/20 hover:text-neutral-100"
      >
        {cur.short}
      </button>
      {open && (
        <ul
          role="listbox"
          aria-label="Language / 语言"
          className={`absolute right-0 z-50 w-40 rounded-xl border border-white/10 bg-ink-900/95 p-1.5 shadow-prism backdrop-blur-xl ${placement === 'up' ? 'bottom-full mb-2' : 'top-full mt-2'}`}
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
