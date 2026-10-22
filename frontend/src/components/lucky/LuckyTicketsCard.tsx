// 首页提示：轮盘可玩且本期还有未用券时出现，点了进 /lucky。
// Dashboard nudge when tickets are waiting; links to /lucky.
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { useAuth } from '../../store/auth'

export default function LuckyTicketsCard() {
  const { t } = useTranslation()
  const { user } = useAuth()
  const n = user?.luckyTickets ?? 0
  if (!user?.luckyWheelVisible || n <= 0) return null
  return (
    <Link to="/lucky" className="card mb-4 flex items-center justify-between gap-3 px-4 py-3 hover:bg-white/5">
      <span className="min-w-0 text-sm text-neutral-100">{t('lucky.cardTitle', { n })}</span>
      <span className="shrink-0 text-xs text-prism-200">{t('lucky.cardCta')} →</span>
    </Link>
  )
}
