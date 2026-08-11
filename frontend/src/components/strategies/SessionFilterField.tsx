// 交易时段过滤编辑器：只在指定小时区间内允许入场。
//
// 口径与后端 services/strategy/live.py 的 session_allows 完全一致，前端不另立
// 一套判断：UTC+8（SESSION_TZ）、按 K 线开盘时间、左闭右开 [start, end)、
// startHour > endHour 表示跨零点（22-02 = 22,23,0,1 这四个小时）。时区跟随全站
// 时间显示，用户看到的「几点」就是策略判断的「几点」。
//
// start == end 被后端当作非法配置放行全部（等于没设过滤），所以两个下拉互相
// 剔除对方的当前值——这个歧义组合在界面上根本选不出来，而不是选出来之后悄悄
// 失效。
//
// Session-filter editor: entries are only allowed inside an hour range.
//
// Semantics match services/strategy/live.py's session_allows exactly; the
// frontend defines nothing of its own: UTC+8 (SESSION_TZ), keyed off the bar's
// open time, half-open [start, end), and startHour > endHour spans midnight
// (22-02 means the four hours 22, 23, 0, 1). The timezone follows the app-wide
// time display, so the hour a user reads is the hour the strategy tests.
//
// The backend treats start == end as a malformed config and allows everything
// (i.e. no filter at all), so each dropdown excludes the other's current value:
// that ambiguous pair simply can't be selected, rather than being selectable
// and then silently doing nothing.
import { useTranslation } from 'react-i18next'
import Select from '../Select'
import type { StrategySessionFilter } from '../../api/types'

export interface SessionFilterFieldProps {
  // null = 不限制（后端存 NULL，session_allows 直接放行）
  // null means no restriction (stored as NULL; session_allows returns true)
  value: StrategySessionFilter | null
  onChange: (next: StrategySessionFilter | null) => void
}

// 开关打开时的默认区间：伦敦盘到纽约盘收（UTC+8 15:00-次日 04:00），一个真实
// 存在且必然跨零点的区间——默认值本身就在验证跨零点这条路径。
// Default range when switched on: London open through the New York close
// (15:00-04:00 UTC+8), a real session that necessarily spans midnight — so the
// default itself exercises the wrap-around path.
const DEFAULT_FILTER: StrategySessionFilter = { startHour: 15, endHour: 4 }

const HOURS = Array.from({ length: 24 }, (_, h) => h)

// "9" -> "09:00"，与全站时间显示的两位小时一致。
// "9" -> "09:00", matching the two-digit hours used app-wide.
function hourLabel(h: number): string {
  return `${String(h).padStart(2, '0')}:00`
}

export default function SessionFilterField({ value, onChange }: SessionFilterFieldProps) {
  const { t } = useTranslation()
  const on = value != null
  const start = value?.startHour ?? DEFAULT_FILTER.startHour
  const end = value?.endHour ?? DEFAULT_FILTER.endHour
  const wraps = on && start > end
  // 覆盖小时数：跨零点时是 24 - start + end。用它显示「共 N 小时」，让用户对
  // 「22:00-02:00 是 4 小时」这件事有确认，而不是自己数。
  // Hours covered; with a wrap it's 24 - start + end. Shown as "N hours" so the
  // user gets confirmation that 22:00-02:00 is four hours, instead of counting.
  const hours = wraps ? 24 - start + end : end - start

  const setOn = (next: boolean) => onChange(next ? DEFAULT_FILTER : null)

  const segBtn = (active: boolean) =>
    `rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
      active
        ? 'border-prism-500/50 bg-prism-600/20 text-prism-200'
        : 'border-white/10 bg-white/5 text-neutral-400 hover:text-neutral-100'
    }`

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] uppercase tracking-wide text-neutral-500">{t('strategy.sessionFilter')}</span>
      <div className="flex flex-wrap gap-2">
        <button type="button" aria-pressed={!on} onClick={() => setOn(false)} className={segBtn(!on)}>
          {t('strategy.sessionFilterOff')}
        </button>
        <button type="button" aria-pressed={on} onClick={() => setOn(true)} className={segBtn(on)}>
          {t('strategy.sessionFilterOn')}
        </button>
      </div>

      {on && (
        <div className="mt-1.5 rounded-lg border border-white/10 bg-white/[0.02] p-3">
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-wide text-neutral-500">{t('strategy.sessionFrom')}</span>
              <Select
                value={String(start)}
                // 剔除 end：start == end 会被后端当成"没设过滤"，不能让它被选出来。
                // Exclude `end`: start == end reads as "no filter" server-side.
                options={HOURS.filter((h) => h !== end).map((h) => ({ value: String(h), label: hourLabel(h) }))}
                onChange={(v) => onChange({ startHour: Number(v), endHour: end })}
                className="w-28"
              />
            </label>
            <span className="pb-2 text-xs text-neutral-500">—</span>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-wide text-neutral-500">{t('strategy.sessionTo')}</span>
              <Select
                value={String(end)}
                options={HOURS.filter((h) => h !== start).map((h) => ({ value: String(h), label: hourLabel(h) }))}
                onChange={(v) => onChange({ startHour: start, endHour: Number(v) })}
                className="w-28"
              />
            </label>
            <span className="pb-2 text-xs text-neutral-400">{t('strategy.sessionHours', { count: hours })}</span>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-neutral-500">
            {wraps ? t('strategy.sessionWrapHint') : t('strategy.sessionHint')}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-neutral-500">{t('strategy.sessionTzNote')}</p>
        </div>
      )}
    </div>
  )
}
