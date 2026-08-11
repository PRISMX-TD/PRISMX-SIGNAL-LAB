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

  // 静态按钮坐在已带背景模糊的 header 里，再叠一层 backdrop-blur 不产生视觉差异，
  // 只多一层合成。同时把半透明白底换成描边 + 透明底，与 .btn-ghost 同一种语汇。
  // A static button inside an already-blurred header: another backdrop-blur changes
  // nothing visually and only adds a compositing layer. The translucent white fill also
  // became a hairline border over a transparent ground, matching the .btn-ghost vocabulary.
  return (
    <button
      onClick={handleToggle}
      aria-label={`Switch to ${next === 'zh' ? '中文' : 'English'}`}
      className="rounded-inner border border-white/10 px-2.5 py-1.5 text-sm font-medium text-neutral-300 transition-colors hover:border-white/20 hover:text-neutral-100"
    >
      {lang === 'zh' ? '中' : 'EN'}
    </button>
  )
}
