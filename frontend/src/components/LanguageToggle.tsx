// 语言切换 / Language picker
import { useTranslation } from 'react-i18next'
import { APP_LANGS, currentLang, isAppLang, setLanguage } from '../i18n'
import { usePrefs } from '../store/prefs'

export default function LanguageToggle() {
  // 订阅 i18n，语言变了按钮上的缩写跟着变 / subscribe so the short code re-renders
  useTranslation()
  const { setPref } = usePrefs()
  const lang = currentLang()
  const cur = APP_LANGS.find((l) => l.code === lang) ?? APP_LANGS[0]

  // 语言从两种变成五种，来回切的按钮不够用了，换成下拉。外观仍是原来那颗描边小按钮
  // （只显示缩写），上面盖一层透明的原生 <select>：点开是系统自带的选择器——手机上是
  // 原生滚轮/底部菜单，桌面是下拉，键盘和读屏都现成可用，也不用自己处理弹层定位
  // （这颗按钮既在顶栏又在手机「更多」抽屉里）。
  // Five languages no longer fit a two-way toggle, so this is a picker. It still looks like
  // the old hairline button (short code only) with a transparent native <select> laid over
  // it: the OS picker handles mobile/desktop, keyboard and screen readers, and no popover
  // positioning is needed (the button lives in both the header and the mobile "more" sheet).
  return (
    <span className="relative inline-flex rounded-inner border border-white/10 px-2.5 py-1.5 text-sm font-medium text-neutral-300 transition-colors focus-within:border-white/20 hover:border-white/20 hover:text-neutral-100">
      <span aria-hidden="true">{cur.short}</span>
      <select
        value={lang}
        onChange={(e) => {
          const next = e.target.value
          if (!isAppLang(next) || next === lang) return
          setLanguage(next)
          setPref('lang', 'lang', next)
        }}
        aria-label="Language / 语言"
        className="absolute inset-0 cursor-pointer opacity-0 [color-scheme:dark]"
      >
        {APP_LANGS.map((l) => (
          <option key={l.code} value={l.code} lang={l.code}>
            {l.label}
          </option>
        ))}
      </select>
    </span>
  )
}
