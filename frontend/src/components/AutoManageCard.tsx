// 自动仓位管理设置卡（保本 / 追踪止损 / 分批止盈）。
// 住在订单页"持仓与账户"Tab 的持仓列表下方——管理对象就是上面那些仓位，挨着
// 看最直观，放进设置页则没人找得到。
// ⚠️ 这是每用户一条的全局配置（后端 AutoManageSettings 在 user_id 上有 unique
// 约束），对绑定的全部 MT5 账号生效，**不随订单页页头的账号选择器变化**，而那个
// Tab 里其余内容都随之变化。所以调用点必须保留分隔线与 orders.autoManageScopeHint
// 那句作用范围说明，否则用户在账号 A 下调完、切到 B 看见同样的值会以为串号或没存上。
// 自己拉取、自己保存，调用方只需传 isPro。
// Auto position-management settings (break-even / trailing stop / partial TP).
// Lives below the positions list in the Orders page's "positions & account"
// tab — it acts on exactly those positions, so adjacency is the most intuitive
// placement; buried in settings, nobody finds it.
// ⚠️ This is a single per-user config (unique constraint on the backend's
// AutoManageSettings.user_id) applying to every linked MT5 account, and it does
// NOT follow the Orders page-head account selector even though everything else
// in that tab does. Call sites must therefore keep the divider and the
// orders.autoManageScopeHint scope note, or a user who tunes it under account A
// and switches to B will read the identical values as cross-account leakage or
// a failed save.
// Self-fetching and self-saving; callers pass only isPro.
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { automationApi } from '../api/client'
import { localizeApiError } from '../api/utils'
import type { AutoManageSettings } from '../api/types'

export default function AutoManageCard({ isPro }: { isPro: boolean }) {
  const { t } = useTranslation()
  const [autoCfg, setAutoCfg] = useState<AutoManageSettings | null>(null)
  const [autoSaving, setAutoSaving] = useState(false)
  const [autoMsg, setAutoMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  useEffect(() => {
    automationApi.getSettings().then(setAutoCfg).catch(() => {})
  }, [])

  async function saveAutoCfg() {
    if (!autoCfg) return
    setAutoSaving(true)
    setAutoMsg(null)
    try {
      const updated = await automationApi.putSettings(autoCfg)
      setAutoCfg(updated)
      setAutoMsg({ kind: 'ok', text: t('account.autoSaved') })
    } catch (err: unknown) {
      setAutoMsg({
        kind: 'err',
        text: err instanceof Error ? localizeApiError(err.message) : t('account.autoSaveError'),
      })
    } finally {
      setAutoSaving(false)
    }
  }

  if (!autoCfg) return null

  return (
    <div className={`glass p-5 ${!isPro ? 'opacity-60' : ''}`}>
      <div className="flex items-center justify-between">
        <h3 className="font-display text-sm font-semibold uppercase tracking-wider text-slate-300">
          {t('account.autoTitle')}
        </h3>
        {!isPro && <span className="tag bg-white/10 text-slate-500">{t('orders.proExclusive')}</span>}
        {isPro && <span className="tag bg-prism-600/20 text-prism-300">PRO</span>}
      </div>
      <p className="mt-2 text-xs leading-relaxed text-slate-500">{t('account.autoHint')}</p>

      {!isPro ? (
        <p className="mt-3 text-xs text-slate-500">
          {t('account.autoUpgradeRequired')}{' '}
          <Link to="/upgrade" className="text-prism-400 underline hover:text-prism-300">
            {t('nav.upgrade')}
          </Link>
        </p>
      ) : (
        <div className="mt-4 space-y-4">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-100">
            <input
              type="checkbox"
              checked={autoCfg.enabled}
              onChange={(e) => setAutoCfg({ ...autoCfg, enabled: e.target.checked })}
              className="h-4 w-4 rounded border-white/20 bg-white/5 accent-prism-500"
            />
            {t('account.autoEnable')}
          </label>

          {autoCfg.enabled && (
            <div className="space-y-4 rounded-lg border border-white/5 bg-white/[0.03] p-4">
              {/* 保本 / break-even */}
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex w-40 cursor-pointer items-center gap-2 text-sm text-slate-200">
                  <input
                    type="checkbox"
                    checked={autoCfg.beEnabled}
                    onChange={(e) => setAutoCfg({ ...autoCfg, beEnabled: e.target.checked })}
                    className="h-4 w-4 rounded border-white/20 bg-white/5 accent-prism-500"
                  />
                  {t('account.autoBe')}
                </label>
                <span className="text-xs text-slate-500">{t('account.autoTriggerAt')}</span>
                <input
                  type="number" step={0.1} min={0.1} max={10}
                  className="input h-8 w-20 text-xs"
                  value={autoCfg.beTriggerR}
                  onChange={(e) => setAutoCfg({ ...autoCfg, beTriggerR: Number(e.target.value) })}
                />
                <span className="text-xs text-slate-500">R</span>
              </div>

              {/* 追踪止损 / trailing stop */}
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex w-40 cursor-pointer items-center gap-2 text-sm text-slate-200">
                  <input
                    type="checkbox"
                    checked={autoCfg.trailEnabled}
                    onChange={(e) => setAutoCfg({ ...autoCfg, trailEnabled: e.target.checked })}
                    className="h-4 w-4 rounded border-white/20 bg-white/5 accent-prism-500"
                  />
                  {t('account.autoTrail')}
                </label>
                <span className="text-xs text-slate-500">{t('account.autoTriggerAt')}</span>
                <input
                  type="number" step={0.1} min={0.1} max={10}
                  className="input h-8 w-20 text-xs"
                  value={autoCfg.trailTriggerR}
                  onChange={(e) => setAutoCfg({ ...autoCfg, trailTriggerR: Number(e.target.value) })}
                />
                <span className="text-xs text-slate-500">R · {t('account.autoTrailDistance')}</span>
                <input
                  type="number" step={0.1} min={0.1} max={10}
                  className="input h-8 w-20 text-xs"
                  value={autoCfg.trailDistanceR}
                  onChange={(e) => setAutoCfg({ ...autoCfg, trailDistanceR: Number(e.target.value) })}
                />
                <span className="text-xs text-slate-500">R</span>
              </div>

              {/* 分批止盈 / partial take-profit */}
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex w-40 cursor-pointer items-center gap-2 text-sm text-slate-200">
                  <input
                    type="checkbox"
                    checked={autoCfg.ptpEnabled}
                    onChange={(e) => setAutoCfg({ ...autoCfg, ptpEnabled: e.target.checked })}
                    className="h-4 w-4 rounded border-white/20 bg-white/5 accent-prism-500"
                  />
                  {t('account.autoPtp')}
                </label>
                <span className="text-xs text-slate-500">{t('account.autoTriggerAt')}</span>
                <input
                  type="number" step={0.1} min={0.1} max={10}
                  className="input h-8 w-20 text-xs"
                  value={autoCfg.ptpTriggerR}
                  onChange={(e) => setAutoCfg({ ...autoCfg, ptpTriggerR: Number(e.target.value) })}
                />
                <span className="text-xs text-slate-500">R · {t('account.autoPtpFraction')}</span>
                <input
                  type="number" step={5} min={10} max={90}
                  className="input h-8 w-20 text-xs"
                  value={Math.round(autoCfg.ptpFraction * 100)}
                  onChange={(e) => setAutoCfg({ ...autoCfg, ptpFraction: Number(e.target.value) / 100 })}
                />
                <span className="text-xs text-slate-500">%</span>
              </div>

              <p className="text-[11px] leading-relaxed text-slate-600">{t('account.autoScopeNote')}</p>
            </div>
          )}

          <button
            onClick={saveAutoCfg}
            disabled={autoSaving}
            className="btn-primary px-5 py-2 text-sm disabled:opacity-40"
          >
            {autoSaving ? t('common.loading') : t('common.save')}
          </button>
          {autoMsg && (
            <p className={`text-sm ${autoMsg.kind === 'err' ? 'text-down' : 'text-up'}`}>
              {autoMsg.text}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
