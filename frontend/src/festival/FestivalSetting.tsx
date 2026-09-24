// 账户页「节日装饰」开关 / the festival switch on the account page
//
// 与账户页其他分区同一套结构（acct-row / acct-setting / Switch）。关掉就是所有
// 节日都不出现，存在本机——和界面语言一样是设备偏好，登出也保留。
// Same structure as the other account sections. Off means no festival ever
// appears; it is stored on the device like the UI language and survives logout.
import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import Switch from '../components/Switch'
import { useFestival } from './FestivalProvider'

export default function FestivalSetting({ index }: { index: number }) {
  const { t } = useTranslation()
  const f = useFestival()
  const location = useLocation()
  const ref = useRef<HTMLElement>(null)

  // 问候卡里的「账户」链接会带 #festival 跳过来。/ the greeting links here with #festival
  useEffect(() => {
    if (location.hash === '#festival' && ref.current) ref.current.scrollIntoView({ block: 'start' })
  }, [location.hash])

  return (
    <section id="festival" ref={ref} className="acct-row scroll-mt-20" style={{ ['--i' as string]: index }}>
      <div>
        <h2 className="font-display acct-row-h">{t('festival.settings.title')}</h2>
        <p className="acct-row-p">{t('festival.settings.desc')}</p>
      </div>
      <div className="acct-row-body">
        <div className="acct-settings">
          <div className="acct-setting">
            <label htmlFor="festival-enabled" className="acct-setting-l">
              <div className="acct-setting-t">{t('festival.settings.toggle')}</div>
              <div className="acct-setting-d">{t('festival.settings.toggleDesc')}</div>
            </label>
            <Switch id="festival-enabled" checked={f.enabled} onChange={f.setEnabled} />
          </div>
        </div>
      </div>
    </section>
  )
}
