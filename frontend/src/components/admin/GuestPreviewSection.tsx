// 运营设置里的「游客预览」：一个开关 + 两种首页模式的漏斗对比。
//
// 开关即时生效，不走页面下方的「保存」：它只有一个布尔值，而且关掉的意图通常很急（发现问题
// 想立刻回到落地页）。对比表把两种模式并排放——这个功能本来就是一次试验，只有放在一起看
// 「访问 → 注册」的转化率，才知道该不该一直开着。
// The "guest preview" block in Ops settings: one switch plus a side-by-side funnel for both
// home modes. The switch applies immediately rather than via a save button — it is a single
// boolean, and turning it off is usually urgent. The table sits both modes next to each other
// because this feature is an experiment; only the visit → sign-up rates side by side say
// whether it should stay on.
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { adminApi } from '../../api/client'
import { localizeApiError } from '../../api/utils'
import type { AdminGuestPreview } from '../../api/types'
import Switch from '../Switch'
import { segBtn } from '../../utils/segBtn'

type Range = 7 | 30
type Mode = 'preview' | 'landing'
type Step = 'view' | 'gate' | 'cta' | 'signup'
const STEPS: Step[] = ['view', 'gate', 'cta', 'signup']

function sinceDay(days: number): string {
  return new Date(Date.now() - (days - 1) * 86400_000).toISOString().slice(0, 10)
}

export default function GuestPreviewSection({ onError }: { onError: (msg: string) => void }) {
  const { t } = useTranslation()
  const [data, setData] = useState<AdminGuestPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [range, setRange] = useState<Range>(7)

  useEffect(() => {
    let alive = true
    adminApi.getGuestPreview().then((r) => { if (alive) setData(r) }).catch((e) => {
      if (alive) onError(e instanceof Error ? localizeApiError(e.message) : String(e))
    })
    return () => { alive = false }
  }, [onError])

  const totals = useMemo(() => {
    const out: Record<Mode, Record<Step, number>> = {
      preview: { view: 0, gate: 0, cta: 0, signup: 0 },
      landing: { view: 0, gate: 0, cta: 0, signup: 0 },
    }
    if (!data) return out
    const from = sinceDay(range)
    for (const r of data.funnel) {
      if (r.day >= from && out[r.mode] && r.step in out[r.mode]) out[r.mode][r.step] += r.count
    }
    return out
  }, [data, range])

  const toggle = async (v: boolean) => {
    if (!data) return
    setBusy(true)
    try {
      setData(await adminApi.setGuestPreview(v))
    } catch (e) {
      onError(e instanceof Error ? localizeApiError(e.message) : String(e))
    } finally {
      setBusy(false)
    }
  }

  const rate = (m: Mode) => {
    const v = totals[m].view
    return v > 0 ? `${((totals[m].signup / v) * 100).toFixed(1)}%` : '—'
  }
  // 落地页模式不统计弹窗与点注册（落地页没有那道门）/ landing mode has no gate, so no gate / cta counts
  const cell = (m: Mode, s: Step) => (m === 'landing' && (s === 'gate' || s === 'cta') ? '—' : totals[m][s].toLocaleString())

  return (
    <div className="glass mb-5 p-5">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-display text-lg font-semibold text-neutral-100">{t('admin.guestPreview.title')}</h3>
        {data && (
          <label className="flex cursor-pointer items-center gap-2 text-sm text-neutral-300">
            <Switch checked={data.enabled} busy={busy} disabled={busy} onChange={toggle} />
            {data.enabled ? t('admin.guestPreview.on') : t('admin.guestPreview.off')}
          </label>
        )}
      </div>
      <p className="text-sm leading-relaxed text-neutral-400">{t('admin.guestPreview.desc')}</p>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <h4 className="text-sm font-semibold text-neutral-200">{t('admin.guestPreview.funnelTitle')}</h4>
        <div className="flex gap-2">
          {([7, 30] as Range[]).map((d) => (
            <button key={d} type="button" className={segBtn(range === d)} aria-pressed={range === d} onClick={() => setRange(d)}>
              {t('admin.guestPreview.days', { n: d })}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[420px] text-sm">
          <thead>
            <tr className="text-left text-xs text-neutral-500">
              <th className="py-2 pr-4 font-medium" />
              <th className="py-2 pr-4 text-right font-medium">{t('admin.guestPreview.modePreview')}</th>
              <th className="py-2 text-right font-medium">{t('admin.guestPreview.modeLanding')}</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {STEPS.map((s) => (
              <tr key={s} className="border-t border-white/[0.06]">
                <td className="py-2 pr-4 text-neutral-300">{t(`admin.guestPreview.step.${s}`)}</td>
                <td className="py-2 pr-4 text-right text-neutral-100">{cell('preview', s)}</td>
                <td className="py-2 text-right text-neutral-100">{cell('landing', s)}</td>
              </tr>
            ))}
            <tr className="border-t border-white/[0.12]">
              <td className="py-2 pr-4 font-semibold text-neutral-200">{t('admin.guestPreview.rate')}</td>
              <td className="py-2 pr-4 text-right font-semibold text-up">{rate('preview')}</td>
              <td className="py-2 text-right font-semibold text-up">{rate('landing')}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs leading-relaxed text-neutral-500">{t('admin.guestPreview.note')}</p>
    </div>
  )
}
