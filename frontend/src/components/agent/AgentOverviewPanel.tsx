// 代理看板：当前选中的那条链接带来的人，头部五张指标卡 + 活跃/新注册趋势。
//
// 时间范围控件、折线图和「比上一期」小字都直接复用管理看板那几个组件
// （components/admin/overview/*）。它们摆在 admin 目录下只是因为先给管理页写的，
// 本身不含任何管理员逻辑，也不自己取数——props 进、SVG 出。**共用是有意的**：
// 时间范围的预设与校验、图表的空态与峰值标注，两处各写一份迟早会长歪，而这两页
// 摆在一起看时最容易看出来。改这几个组件时记得两边都会受影响。
//
// 数字也与管理看板同源：后端 /agent/links/{id}/overview 调的就是 admin_overview 的
// headline / activity_daily，只多传一个「限定这条链接」的条件。
//
// The agent dashboard for the selected link: five headline tiles plus the
// activity/signup trend. The range picker, line chart and delta caption are the
// admin dashboard's components — they live under admin/ only because that page
// came first; they hold no admin logic and fetch nothing. Sharing is deliberate:
// two copies of the preset/validation rules or of the chart's empty and peak
// states would drift, and these two pages are read side by side. The numbers are
// shared too — the endpoint calls admin_overview's own functions with one extra
// scope filter.
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { agentApi } from '../../api/client'
import { localizeApiError } from '../../api/utils'
import { SkeletonLine } from '../Skeleton'
import { DeltaBadge } from '../admin/overview/HeadlineCards'
import LineChart, { SERIES_COLORS } from '../admin/overview/LineChart'
import RangePicker from '../admin/overview/RangePicker'
import { DEFAULT_RANGE, rangeKey, toQuery, type RangeState } from '../admin/overview/rangeUtils'
import type { AgentOverview } from '../../api/types'
import { SectionHead } from './customerCells'

// 一格指标。五格拼成一块发丝线格（styles/agent.css 的 .agt-kpis），不再是五张各自浮着的卡。
// One figure; five of them form a single hairline grid (.agt-kpis) instead of five floating cards.
function Tile({ label, value, accent, footer }: {
  label: string
  value: number
  accent?: string
  footer?: React.ReactNode
}) {
  return (
    <div className="agt-kpi">
      <div className="agt-kpi-label">{label}</div>
      <div className={`agt-kpi-value num ${accent ?? 'text-neutral-50'}`}>{value.toLocaleString('en-US')}</div>
      {footer && <div className="mt-1">{footer}</div>}
    </div>
  )
}

// 分区标题「链接数据」，副标题是实际统计区间（名下有几条链接时前面再带上是哪一条），
// 时间范围放在标题右边；styles/agent.css 的 .agt-range 把胶囊收成一条分段条。
// Headed "Link performance" with the actual range as the subtitle (prefixed with the link's
// name when there are several) and the range picker on the right, drawn as a segmented
// strip by .agt-range in styles/agent.css.
export default function AgentOverviewPanel({ linkId, linkLabel }: { linkId: string; linkLabel: string | null }) {
  const { t } = useTranslation()
  // 范围只存在组件里，不写 URL：代理页没有深链需求，而写 URL 要把 link 选择也
  // 一起搬进去才自洽（管理页那边是整页一个范围，情况不同）。
  // Range lives in component state, not the URL: this page has no deep-link
  // need, and putting it in the URL would only be coherent if the selected link
  // went there too (the admin page has one range for the whole page).
  const [range, setRange] = useState<RangeState>(DEFAULT_RANGE)
  const [data, setData] = useState<AgentOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const key = rangeKey(range)

  useEffect(() => {
    let alive = true
    setData(null)
    setError(null)
    agentApi
      .overview(linkId, toQuery(range))
      .then((res) => {
        if (alive) setData(res)
      })
      .catch((err: unknown) => {
        if (alive) setError(localizeApiError(err instanceof Error ? err.message : String(err)))
      })
    return () => {
      alive = false
    }
    // range 对象每次渲染都是新引用，依赖它会无限重拉；key 才是它的稳定身份。
    // range is a fresh object on every render; key is its stable identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkId, key])

  const dates = useMemo(() => (data?.activity ?? []).map((d) => d.date), [data])
  const series = useMemo(
    () => [
      {
        key: 'active',
        label: t('admin.overview.activity.active'),
        color: SERIES_COLORS[0],
        values: (data?.activity ?? []).map((d) => d.active),
      },
      {
        key: 'signups',
        label: t('admin.overview.activity.signups'),
        color: SERIES_COLORS[2],
        values: (data?.activity ?? []).map((d) => d.signups),
      },
    ],
    [data, t],
  )

  return (
    <section className="agt-sec">
      <SectionHead
        title={t('agent.overview.title')}
        sub={
          data
            ? `${linkLabel ? `${linkLabel} · ` : ''}${t('admin.overview.range.shown', { ...data.range })}`
            : linkLabel
        }
        tools={
          <div className="agt-range">
            <RangePicker value={range} onChange={setRange} />
          </div>
        }
      />

      {error ? (
        <div className="agt-sheet mb-5 p-5 text-sm text-down" role="alert">
          {error}
        </div>
      ) : !data ? (
        <div className="agt-sheet mb-5 p-5" aria-busy="true">
          <SkeletonLine height={96} />
        </div>
      ) : (
        <>
          <div className="agt-kpis">
            <Tile label={t('agent.overview.customers')} value={data.headline.totalUsers} />
            <Tile label={t('admin.overview.headline.activeToday')} value={data.headline.activeToday} accent="text-up" />
            <Tile label={t('admin.overview.headline.activeWeek')} value={data.headline.activeWeek} accent="text-prism-300" />
            <Tile label={t('admin.overview.headline.activeMonth')} value={data.headline.activeMonth} accent="text-prism-300" />
            <Tile
              label={t('admin.overview.headline.signups')}
              value={data.headline.signups.current}
              footer={<DeltaBadge {...data.headline.signups} />}
            />
          </div>
          <div className="agt-sheet agt-chart">
            <h3>{t('admin.overview.activity.title')}</h3>
            <p>{t('agent.overview.activityHint')}</p>
            <LineChart
              dates={dates}
              series={series}
              format={String}
              ariaLabel={t('admin.overview.activity.title')}
              peakLabel={(v) => t('admin.pageStats.peak', { value: v })}
            />
          </div>
        </>
      )}
    </section>
  )
}
