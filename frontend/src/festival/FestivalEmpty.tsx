// 空状态插画 / empty-state illustration
//
// 没有信号时本来就是用户在等的时刻，最适合放一点节日的东西。原本的那句
// 「暂无可执行信号」保留在下面，信息一个字没少。
// With no signals the user is already waiting, which is the right moment for a
// little festival art. The original "no executable signals" line stays below,
// so no information is lost.
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useFestivalOptional } from './FestivalProvider'
import { empty } from './art'
import SvgArt from './SvgArt'
import './festival.css'

export default function FestivalEmpty({ fallback }: { fallback: string }) {
  const { t } = useTranslation()
  const f = useFestivalOptional()
  const key = f ? f.festival : null
  const html = useMemo(() => (key ? empty(key) : ''), [key])
  if (!f || !key) return <>{fallback}</>
  return (
    <div className="fa-empty-wrap">
      <SvgArt html={html} surface="empty" artKey={key} reduced={f.reducedMotion} replay={f.replay} />
      <div className="fa-empty-line">{t(`festival.empty.${key}`)}</div>
      <div className="fa-empty-sub">{fallback}</div>
    </div>
  )
}
