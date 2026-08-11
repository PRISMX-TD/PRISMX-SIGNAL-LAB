// 公开页专用语言切换：切换 = 跳到对应语言的 URL（公开页语言由 URL 决定），
// 同时经 setLanguage 写入 localStorage，让登录后的应用延续这个偏好。
// 不复用 LanguageToggle：那个依赖 PrefsProvider（预渲染入口刻意不挂载它，
// 见 seo/entry-server.tsx），而且只改状态不改 URL——公开页上语言和 URL 必须
// 一起动。登录后的应用继续用原 LanguageToggle，行为不变。
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate } from 'react-router-dom'
import { setLanguage } from '../i18n'
import { counterpartPath } from '../seo/meta'

export default function PublicLanguageToggle() {
  const { i18n } = useTranslation()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const lang = i18n.language === 'en' ? 'en' : 'zh'
  const next = lang === 'zh' ? 'en' : 'zh'

  const handleToggle = () => {
    setLanguage(next)
    navigate(counterpartPath(pathname, next), { replace: true })
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
