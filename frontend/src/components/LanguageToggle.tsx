// 语言切换 / Language toggle
import { useTranslation } from 'react-i18next'
import { setLanguage } from '../i18n'
import { usePrefs } from '../store/prefs'

export default function LanguageToggle() {
  const { i18n } = useTranslation()
  const { setPref } = usePrefs()
  const lang = i18n.language === 'en' ? 'en' : 'zh'
  const next = lang === 'zh' ? 'en' : 'zh'

  const handleToggle = () => {
    setLanguage(next)
    setPref('lang', 'lang', next)
  }

  return (
    <button
      onClick={handleToggle}
      aria-label={`Switch to ${next === 'zh' ? '中文' : 'English'}`}
      className="rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-sm font-medium text-slate-300 backdrop-blur-md transition hover:text-slate-100"
    >
      {lang === 'zh' ? '中' : 'EN'}
    </button>
  )
}
