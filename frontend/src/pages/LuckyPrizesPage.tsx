// 「我的奖品」子页（/lucky/prizes，2026-10-22）：跨所有期的中奖记录与领奖进度。
// 套订单回执页的设计语言：页头带返回，一排状态芯片（带计数），按日分组，一个奖品一张回执单
// （左边时间票根 + 打孔虚线，右边状态印章）。待领取的单上有领奖按钮，表单方式就地展开在单子下面。
// 轮盘页侧栏只留一张入口卡（PrizesEntry），发放 / 取消的站内通知与推送都落到这里。
// The "My prizes" sub-page (/lucky/prizes): wins across every round and their claim progress, in the
// orders page's receipt language: a head with a back link, status chips with counts, day groups and one
// receipt slip per prize (time stub with a perforation on the left, status stamp on the right). Pending
// slips carry the claim button; the claim form unfolds under its slip. The wheel page keeps only an
// entry card, and delivery / cancellation notifications and pushes land here.
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { luckyApi } from '../api/client'
import type { LuckyDraw, LuckyFulfillment } from '../api/luckyTypes'
import { localizeApiError, parseTime } from '../api/utils'
import { LOCALE_TAG, currentLang } from '../i18n'
import PageHead from '../components/PageHead'
import PrizeSlip from '../components/lucky/PrizeSlip'
import { wonDraws } from '../utils/luckyView'
import '../components/lucky/luckyPrizes.css'

type Filter = 'all' | 'pending' | 'submitted' | 'done' | 'cancelled'
const FILTERS: Filter[] = ['all', 'pending', 'submitted', 'done', 'cancelled']

const inFilter = (f: Filter, s: LuckyFulfillment) =>
  f === 'all' || (f === 'done' ? s === 'delivered' || s === 'auto_done' : s === f)

const TZ = 'Asia/Shanghai'
const dayKeyOf = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: TZ }) // YYYY-MM-DD

export default function LuckyPrizesPage() {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const [draws, setDraws] = useState<LuckyDraw[] | null>(null)
  const [err, setErr] = useState('')
  const [filter, setFilter] = useState<Filter>('all')

  useEffect(() => {
    let alive = true
    luckyApi.draws()
      .then((d) => { if (alive) setDraws(d.draws) })
      .catch((e) => { if (alive) setErr(e instanceof Error ? localizeApiError(e.message) : t('common.error')) })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const won = useMemo(() => (draws ? wonDraws(draws) : []), [draws])
  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: 0, pending: 0, submitted: 0, done: 0, cancelled: 0 }
    for (const d of won) for (const f of FILTERS) if (inFilter(f, d.fulfillmentStatus)) c[f] += 1
    return c
  }, [won])
  const shown = won.filter((d) => inFilter(filter, d.fulfillmentStatus))

  // 按北京时间的日期分组：今天 / 昨天 / 月-日 + 星期，与订单回执一致。
  // Day groups in Beijing time: today / yesterday / MM-DD + weekday, as on the orders page.
  const groups = useMemo(() => {
    const now = new Date()
    const today = dayKeyOf(now)
    const yesterday = dayKeyOf(new Date(now.getTime() - 86_400_000))
    const locale = LOCALE_TAG[currentLang()]
    const out: { key: string; label: string; sub: string; items: LuckyDraw[] }[] = []
    for (const d of shown) {
      const at = parseTime(d.createdAt) ?? new Date(NaN)
      const key = Number.isNaN(at.getTime()) ? '' : dayKeyOf(at)
      let g = out[out.length - 1]
      if (!g || g.key !== key) {
        const md = key.slice(5)
        const wd = key ? at.toLocaleDateString(locale, { timeZone: TZ, weekday: 'short' }) : ''
        g = key === today ? { key, label: t('orders.day.today'), sub: `${md} ${wd}`, items: [] }
          : key === yesterday ? { key, label: t('orders.day.yesterday'), sub: `${md} ${wd}`, items: [] }
            : { key, label: md || '—', sub: wd, items: [] }
        out.push(g)
      }
      g.items.push(d)
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown.map((d) => d.id).join(), i18n.language])

  const change = (nd: LuckyDraw) => setDraws((xs) => xs && xs.map((x) => (x.id === nd.id ? nd : x)))

  return (
    <div className="lkp">
      <PageHead
        title={t('lucky.myPrizes')}
        count={draws ? won.length : null}
        subtitle={t('lucky.prizesSub')}
        back={{ to: '/lucky', label: t('lucky.title') }}
      />

      {err ? <p className="lkp-err" role="alert">{err}</p> : !draws ? (
        <div className="lkp-slips mt-5" aria-busy="true">
          {[0, 1, 2].map((i) => <div key={i} className="lkp-slip is-skel" aria-hidden><div className="lkp-stub" /><div className="lkp-body" /></div>)}
        </div>
      ) : (
        <>
          <div className="lkp-chips" role="tablist" aria-label={t('lucky.myPrizes')}>
            {FILTERS.map((f) => (
              <button key={f} type="button" role="tab" aria-selected={filter === f} onClick={() => setFilter(f)}
                className={`lkp-chip ${filter === f ? 'on' : ''}`}>
                {f === 'all' ? t('signals.all') : f === 'done' ? t('lucky.filterDone') : t(`lucky.status.${f}`)}
                <b>{counts[f]}</b>
              </button>
            ))}
          </div>

          {shown.length === 0 ? (
            <div className="lkp-ghost">
              <div className="lkp-ghost-t">--:--:--</div>
              <div className="lkp-ghost-b">
                <b>{t('lucky.noPrizes')}</b>
                <p>{t('lucky.noPrizesHint')}</p>
              </div>
            </div>
          ) : groups.map((g, gi) => (
            <div key={`${g.key}-${gi}`}>
              <div className="lkp-day">
                <div className="lkp-day-d">{g.label}<span>{g.sub}</span></div>
                <div className="lkp-day-n">{t('lucky.dayCount', { n: g.items.length })}</div>
              </div>
              <div className="lkp-slips">
                {g.items.map((d, i) => <PrizeSlip key={d.id} draw={d} index={i} onChange={change} navigate={navigate} />)}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  )
}
