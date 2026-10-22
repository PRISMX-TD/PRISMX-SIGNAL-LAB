// 后台「增长 → 幸运轮盘」：轮盘设置 / 发券 / 抽奖记录 / 待发奖。顶部指标带读 config + batches + 待发奖数。
// Admin "Growth → Lucky wheel": settings / issue / draws / pending. The KPI strip reads config,
// batches and the open-draw count.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { adminApi } from '../../../api/client'
import type { LuckyAdminConfig, LuckyBatch } from '../../../api/luckyTypes'
import { fmtTime, localizeApiError } from '../../../api/utils'
import LuckyDrawsTab from './LuckyDrawsTab'
import LuckyIssueTab from './LuckyIssueTab'
import LuckySettingsTab from './LuckySettingsTab'

type Tab = 'settings' | 'issue' | 'draws' | 'pending'

export default function LuckyWheelPanel() {
  const { t } = useTranslation()
  const [tab, setTab] = useState<Tab>('settings')
  const [cfg, setCfg] = useState<LuckyAdminConfig | null>(null)
  const [batches, setBatches] = useState<LuckyBatch[]>([])
  const [pending, setPending] = useState(0)
  const [err, setErr] = useState('')
  const [dirty, setDirty] = useState(false)
  const reload = () => {
    const fail = (e: unknown) => setErr(e instanceof Error ? localizeApiError(e.message) : t('common.error'))
    void adminApi.luckyConfig().then(setCfg).catch(fail)
    void adminApi.luckyBatches().then((r) => setBatches(r.batches)).catch(fail)
    void adminApi.luckyDraws({ status: 'open', limit: 1, offset: 0 }).then((r) => setPending(r.total)).catch(fail)
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(reload, [])
  const issued = batches.reduce((a, b) => a + b.ticketCount, 0)
  const used = batches.reduce((a, b) => a + b.used, 0)
  return (
    <div className="space-y-4">
      <div className="adm-kpis is-quad">
        <div className="adm-kpi"><div className="adm-kpi-label">{t('admin.lucky.kpi.issued')}</div><div className="adm-kpi-value">{issued}</div></div>
        <div className="adm-kpi"><div className="adm-kpi-label">{t('admin.lucky.kpi.used')}</div><div className="adm-kpi-value">{used}</div></div>
        <div className="adm-kpi"><div className="adm-kpi-label">{t('admin.lucky.kpi.pending')}</div><div className="adm-kpi-value">{pending}</div></div>
        <div className="adm-kpi"><div className="adm-kpi-label">{t('admin.lucky.kpi.ends')}</div>
          <div className="adm-kpi-value text-base">{cfg?.round ? fmtTime(cfg.round.endsAt) : '—'}</div></div>
      </div>
      {err && <p className="text-xs text-down">{err}</p>}
      <div className="seg-tabs w-full sm:w-fit" role="tablist">
        {(['settings', 'issue', 'draws', 'pending'] as Tab[]).map((k) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''}
            onClick={() => {
              // 设置页有未保存的奖项改动时，离开前确认（切走会卸载设置页，改动就丢了）。
              // Unsaved prize edits are lost when the settings tab unmounts, so confirm first.
              if (k === tab) return
              if (tab === 'settings' && dirty && !window.confirm(t('admin.lucky.confirmLeave'))) return
              setTab(k)
            }}>{t(`admin.lucky.tab.${k}`)}</button>
        ))}
      </div>
      {tab === 'settings' && cfg && <LuckySettingsTab cfg={cfg} onDirty={setDirty} onChange={(c) => { setCfg(c); reload() }} />}
      {tab === 'issue' && <LuckyIssueTab cfg={cfg} batches={batches} onIssued={reload} />}
      {tab === 'draws' && <LuckyDrawsTab mode="all" onChange={reload} />}
      {tab === 'pending' && <LuckyDrawsTab mode="pending" onChange={reload} />}
    </div>
  )
}
