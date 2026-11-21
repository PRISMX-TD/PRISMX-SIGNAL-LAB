// 财经日历（用户端，2026-11-21 对登录用户开放）：和管理台同一张日历，只读。入口在仪表盘的
// 「今日财经」卡片、手机「其他」面板和电脑的用户菜单。
// The economic calendar for users: the same calendar as the admin console, read-only. Reached from
// the dashboard today card, the mobile More sheet and the desktop user menu.
import { useTranslation } from 'react-i18next'
import EconCalendarPanel from '../components/admin/econ/EconCalendarPanel'

export default function CalendarPage() {
  const { t } = useTranslation()
  return (
    <div className="max-w-[1520px] mx-auto">
      <h1 className="sr-only">{t('nav.calendar')}</h1>
      <EconCalendarPanel mode="user" />
    </div>
  )
}
