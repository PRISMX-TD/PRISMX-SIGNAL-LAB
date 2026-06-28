// 语言切换 / Language toggle
import { useTranslation } from 'react-i18next'
import { setLanguage } from '../i18n'

export default function LanguageToggle() {
  const { i18n } = useTranslation()
  const lang = i18n.language

  return (
    <div className="inline-flex items-center rounded-lg border border-ink-700 bg-ink-900/60 p-0.5 text-sm">
      <button
        onClick={() => setLanguage('zh')}
        className={`rounded-md px-2.5 py-1 transition ${
          lang === 'zh' ? 'bg-prism-600 text-white shadow-prism' : 'text-slate-400 hover:text-slate-200'
        }`}
      >
        中
      </button>
      <button
        onClick={() => setLanguage('en')}
        className={`rounded-md px-2.5 py-1 transition ${
          lang === 'en' ? 'bg-prism-600 text-white shadow-prism' : 'text-slate-400 hover:text-slate-200'
        }`}
      >
        EN
      </button>
    </div>
  )
}
