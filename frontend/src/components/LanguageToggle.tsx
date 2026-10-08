// 语言切换 / Language picker
import { useTranslation } from 'react-i18next'
import { currentLang, setLanguage, type AppLang } from '../i18n'
import { usePrefs } from '../store/prefs'
import LanguageMenu from './LanguageMenu'

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
  const choose = (next: AppLang) => {
    // 时间戳与语言一起进云端：别的设备 / 下次冷启动据此判断谁更新
    // The timestamp goes up with the language so other devices / the next cold start can tell which is newer
    const at = Date.now()
    setLanguage(next, at)
    setPref('lang', 'lang', next)
    setPref('lang', 'at', at)
  }
  return <LanguageMenu value={lang} onChoose={choose} placement={placement} />
}
