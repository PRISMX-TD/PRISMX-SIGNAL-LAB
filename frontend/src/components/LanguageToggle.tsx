// 语言切换 / Language picker
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { APP_LANGS, currentLang, setLanguage, type AppLang } from '../i18n'
import { usePrefs } from '../store/prefs'

// 语言从两种变成五种，来回切的按钮不够用，换成下拉。自绘菜单而不是原生 <select>：
// 原生下拉的弹层由系统绘制，Windows / 部分 Android 上是白底浅灰字，和深色界面格格不入。
// 菜单与 UserMenu 同一套外观（ink-900 半透明底 + 描边 + 模糊）。placement="up" 给手机
// 「更多」抽屉用——按钮在抽屉底部，向下展开会被屏幕截掉。
// Five languages no longer fit a two-way toggle. A self-drawn menu rather than a native
// <select>: the OS draws that popup (white on Windows / some Android) and it clashes with
// the dark UI. Same look as UserMenu. placement="up" is for the mobile "more" sheet, where
// the button sits at the bottom and a downward menu would be cut off.
export default function LanguageToggle({ placement = 'down' }: { placement?: 'down' | 'up' }) {
  useTranslation() // 语言变了重新渲染 / re-render on language change
  const { setPref } = usePrefs()
  const lang = currentLang()
  const cur = APP_LANGS.find((l) => l.code === lang) ?? APP_LANGS[0]
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
    if (next === lang) return
    // 时间戳与语言一起进云端：别的设备 / 下次冷启动据此判断谁更新
    // The timestamp goes up with the language so other devices / the next cold start can tell which is newer
    const at = Date.now()
    setLanguage(next, at)
    setPref('lang', 'lang', next)
    setPref('lang', 'at', at)
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
            const active = l.code === lang
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
