// 管理后台「系统」页签：K 线历史保留策略 / 自定义策略平台参数。
// 与 OpsSettingsPanel 同一次（2026-09-21）从 AdminPage 拆出，理由见那边的文件头。
// 这两组改的是后台怎么算、怎么存，不改用户看到什么、付多少钱——这条界线在 AdminPage
// 的 AdminTab 说明里。
// The admin "system" tab: candle-history retention / custom-strategy platform limits.
// Split out of AdminPage together with OpsSettingsPanel (2026-09-21); see its header.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { adminApi } from '../../api/client'
import { localizeApiError } from '../../api/utils'
import Switch from '../Switch'
import { SkeletonLine } from '../Skeleton'
import { useToast } from '../../utils/useToast'
import type { AdminCandleSettings, AdminStrategySettings } from '../../api/types'

export default function SystemSettingsPanel() {
  const { t } = useTranslation()
  const { toast, showToast } = useToast()
  const [loading, setLoading] = useState(true)

  // K 线历史保留策略设置 / candle-history retention settings
  const [candleSettings, setCandleSettings] = useState<AdminCandleSettings | null>(null)
  const [savingCandle, setSavingCandle] = useState(false)

  // 自定义策略平台设置 / custom-strategy platform settings
  const [strategySettings, setStrategySettings] = useState<AdminStrategySettings | null>(null)
  const [savingStrategy, setSavingStrategy] = useState(false)

  useEffect(() => {
    let alive = true
    ;(async () => {
      const results = await Promise.allSettled([adminApi.getCandleHistory(), adminApi.getStrategySettings()])
      if (!alive) return
      const [candleRes, strategyRes] = results
      if (candleRes.status === 'fulfilled') setCandleSettings(candleRes.value)
      if (strategyRes.status === 'fulfilled') setStrategySettings(strategyRes.value)
      const firstErr = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined
      if (firstErr) {
        const failed = results.filter((r) => r.status === 'rejected').length
        const reason = firstErr.reason
        const detail = reason instanceof Error ? localizeApiError(reason.message) : ''
        showToast('err', t('admin.loadPartialError', { n: failed, total: results.length }) + (detail ? ` — ${detail}` : ''))
      }
      setLoading(false)
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const saveCandleSettings = async () => {
    if (!candleSettings) return
    setSavingCandle(true)
    try {
      const updated = await adminApi.updateCandleHistory(candleSettings)
      setCandleSettings(updated)
      showToast('ok', t('admin.saved'))
    } catch (err) {
      showToast('err', err instanceof Error ? localizeApiError(err.message) : t('admin.saveError'))
    } finally {
      setSavingCandle(false)
    }
  }

  const saveStrategySettings = async () => {
    if (!strategySettings) return
    setSavingStrategy(true)
    try {
      const updated = await adminApi.updateStrategySettings(strategySettings)
      setStrategySettings(updated)
      showToast('ok', t('admin.saved'))
    } catch (err) {
      showToast('err', err instanceof Error ? localizeApiError(err.message) : t('admin.saveError'))
    } finally {
      setSavingStrategy(false)
    }
  }

  return (
    <div>
      {toast && (
        <div
          className={`mb-4 rounded-lg border px-4 py-2.5 text-sm ${
            toast.kind === 'err' ? 'border-down/40 bg-down/15 text-down' : 'border-up/40 bg-up/15 text-up'
          }`}
        >
          {toast.text}
        </div>
      )}
      {loading && (
        <div className="glass mb-5 flex flex-col gap-3 p-5">
          <SkeletonLine width="40%" height={14} />
          <SkeletonLine />
          <SkeletonLine width="70%" />
        </div>
      )}
      {/* K 线历史保留策略设置 / candle-history retention settings */}
      {candleSettings && (
        <div className="glass mb-5 p-5">
          <h3 className="mb-4 font-display text-lg font-semibold text-neutral-100">{t('admin.candleHistoryTitle')}</h3>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
            <div>
              <label className="label">{t('admin.candleM1Retention')}</label>
              <input
                type="number"
                className="input"
                min="1"
                max="365"
                value={candleSettings.m1RetentionDays}
                onChange={(e) => setCandleSettings({ m1RetentionDays: Math.min(365, Math.max(1, parseInt(e.target.value) || 1)) })}
              />
            </div>
          </div>
          <button
            className="btn-primary mt-4 px-5 py-2 text-sm disabled:opacity-40"
            disabled={savingCandle}
            onClick={saveCandleSettings}
          >
            {savingCandle ? t('common.loading') : t('common.save')}
          </button>
        </div>
      )}

      {/* 自定义策略平台设置 / custom-strategy platform settings */}
      {strategySettings && (
        <div className="glass mb-5 p-5">
          <h3 className="mb-4 font-display text-lg font-semibold text-neutral-100">{t('admin.strategyPlatformTitle')}</h3>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
            <div>
              <label className="label">{t('admin.strategyMaxPerUser')}</label>
              <input
                type="number"
                className="input"
                min="1"
                max="50"
                value={strategySettings.maxStrategiesPerUser}
                onChange={(e) => setStrategySettings({ ...strategySettings, maxStrategiesPerUser: Math.min(50, Math.max(1, parseInt(e.target.value) || 1)) })}
              />
            </div>
            <div className="flex items-end pb-2">
              <label className="flex cursor-pointer items-center gap-2 text-sm text-neutral-300">
                <Switch checked={strategySettings.proOnly} onChange={(v) => setStrategySettings({ ...strategySettings, proOnly: v })} />
                {t('admin.strategyProOnly')}
              </label>
            </div>
          </div>
          <button
            className="btn-primary mt-4 px-5 py-2 text-sm disabled:opacity-40"
            disabled={savingStrategy}
            onClick={saveStrategySettings}
          >
            {savingStrategy ? t('common.loading') : t('common.save')}
          </button>
        </div>
      )}

    </div>
  )
}
