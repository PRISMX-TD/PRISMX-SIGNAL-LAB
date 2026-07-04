// 移动端吸底 CTA：滚动超过阈值后出现，仅在小屏显示
// mobile sticky bottom CTA: appears past a scroll threshold, mobile only
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'

export default function MobileStickyCta() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const onScroll = () => setVisible(window.scrollY > 560)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  if (!visible) return null

  return (
    <div className="fixed inset-x-0 bottom-0 z-40 p-3 pb-[env(safe-area-inset-bottom)] sm:hidden">
      <div className="glass animate-fade-in-up p-2">
        <button onClick={() => navigate('/login?mode=register')} className="btn-primary w-full py-3 text-sm">
          {t('landing.ctaButton')}
        </button>
      </div>
    </div>
  )
}
