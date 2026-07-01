// 语言切换 / Language toggle
import { useTranslation } from 'react-i18next'
import { setLanguage } from '../i18n'
import { usePrefs } from '../store/prefs'

export default function LanguageToggle() {
  const { i18n } = useTranslation()
  const { setPref } = usePrefs()
  const lang = i18n.language

  const handleSwitch = (l: 'zh' | 'en') => {
    setLanguage(l)
    setPref('lang', 'lang', l)
  }

  return (
    <div className="inline-flex items-center rounded-lg border border-white/10 bg-white/[0.04] p-0.5 text-sm backdrop-blur-md">
      <button
        onClick={() => handleSwitch('zh')}
        className={`rounded-md px-2.5 py-1 transition ${
          lang === 'zh' ? 'bg-prism-600 text-white shadow-prism' : 'text-slate-400 hover:text-slate-200'
        }`}
      >
        中
      </button>
      <button
        onClick={() => handleSwitch('en')}
        className={`rounded-md px-2.5 py-1 transition ${
          lang === 'en' ? 'bg-prism-600 text-white shadow-prism' : 'text-slate-400 hover:text-slate-200'
        }`}
      >
        EN
      </button>
    </div>
  )
}
