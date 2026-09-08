// 自动仓位管理设置（保本 / 追踪止损 / 分批止盈）。
// 住在订单页"持仓与账户"Tab 的持仓列表下方——管理对象就是上面那些仓位，挨着
// 看最直观，放进设置页则没人找得到。2026-09-08 起随订单页重做改成发丝线账本
// 分区（.ord-am-*）：区块标题 + 说明 + 作用范围一行 + 三条规则行，不再套卡片。
// ⚠️ 这是每用户一条的全局配置（后端 AutoManageSettings 在 user_id 上有 unique
// 约束），对绑定的全部 MT5 账号生效，**不随订单页页头的账号选择器变化**，而那个
// Tab 里其余内容都随之变化。所以调用点必须用 .ord-block 划一条分隔线，并把
// orders.autoManageScopeHint 那句作用范围说明通过 scopeHint 传进来，否则用户在
// 账号 A 下调完、切到 B 看见同样的值会以为串号或没存上。
// 自己拉取、自己保存，调用方只需传 isPro 与 scopeHint。
// Auto position-management settings (break-even / trailing stop / partial TP).
// Lives below the positions list in the Orders page's "positions & account"
// tab — it acts on exactly those positions, so adjacency is the most intuitive
// placement; buried in settings, nobody finds it. Since the 2026-09-08 orders
// redesign it renders as a hairline ledger section (.ord-am-*): block heading,
// hint, scope line and three rule rows — no card shell.
// ⚠️ This is a single per-user config (unique constraint on the backend's
// AutoManageSettings.user_id) applying to every linked MT5 account, and it does
// NOT follow the Orders page-head account selector even though everything else
// in that tab does. Call sites must therefore wrap it in .ord-block (divider)
// and pass orders.autoManageScopeHint as scopeHint, or a user who tunes it under
// account A and switches to B will read the identical values as cross-account
// leakage or a failed save.
// Self-fetching and self-saving; callers pass only isPro and scopeHint.
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import Switch from './Switch'
import { SkeletonLine } from './Skeleton'
import { automationApi } from '../api/client'
import { localizeApiError } from '../api/utils'
import type { AutoManageSettings } from '../api/types'

interface Props {
  isPro: boolean
  /** 作用范围说明（对全部绑定账号生效）/ scope note: applies to every linked account */
  scopeHint: string
}

export default function AutoManageCard({ isPro, scopeHint }: Props) {
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

  const numInput = (value: number, onChange: (n: number) => void, step: number, min: number, max: number) => (
    <input
      type="number"
      step={step}
      min={min}
      max={max}
      className="input"
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  )

  return (
    <section className="ord-am">
      <div className="ord-h">
        <h4>{t('account.autoTitle')}</h4>
        <span>{isPro ? 'PRO' : t('orders.proExclusive')}</span>
      </div>
      <p className="ord-p">{t('account.autoHint')}</p>
      <p className="ord-am-scope">{scopeHint}</p>

      {!isPro ? (
        <p className="ord-am-upgrade">
          {t('account.autoUpgradeRequired')}{' '}
          <Link to="/upgrade" className="text-prism-400 underline hover:text-prism-300">
            {t('nav.upgrade')}
          </Link>
        </p>
      ) : !autoCfg ? (
        <div className="ord-am-body">
          <SkeletonLine width={200} height={24} />
          <SkeletonLine height={48} className="mt-4" />
        </div>
      ) : (
        <div className="ord-am-body">
          <label className="ord-am-master">
            <Switch checked={autoCfg.enabled} onChange={(v) => setAutoCfg({ ...autoCfg, enabled: v })} />
            <span>{t('account.autoEnable')}</span>
          </label>

          {autoCfg.enabled && (
            <>
              <div className="ord-am-rules">
                {/* 保本 / break-even */}
                <div className="ord-am-rule" data-off={!autoCfg.beEnabled || undefined}>
                  <label className="ord-am-rule-n">
                    <Switch checked={autoCfg.beEnabled} onChange={(v) => setAutoCfg({ ...autoCfg, beEnabled: v })} />
                    <span>{t('account.autoBe')}</span>
                  </label>
                  <div className="ord-am-rule-p">
                    <span className="ord-am-lbl">{t('account.autoTriggerAt')}</span>
                    {numInput(autoCfg.beTriggerR, (n) => setAutoCfg({ ...autoCfg, beTriggerR: n }), 0.1, 0.1, 10)}
                    <span className="ord-am-u">R</span>
                  </div>
                </div>

                {/* 追踪止损 / trailing stop */}
                <div className="ord-am-rule" data-off={!autoCfg.trailEnabled || undefined}>
                  <label className="ord-am-rule-n">
                    <Switch checked={autoCfg.trailEnabled} onChange={(v) => setAutoCfg({ ...autoCfg, trailEnabled: v })} />
                    <span>{t('account.autoTrail')}</span>
                  </label>
                  <div className="ord-am-rule-p">
                    <span className="ord-am-lbl">{t('account.autoTriggerAt')}</span>
                    {numInput(autoCfg.trailTriggerR, (n) => setAutoCfg({ ...autoCfg, trailTriggerR: n }), 0.1, 0.1, 10)}
                    <span className="ord-am-u">R</span>
                    <span className="ord-am-lbl ord-am-lbl-2">{t('account.autoTrailDistance')}</span>
                    {numInput(autoCfg.trailDistanceR, (n) => setAutoCfg({ ...autoCfg, trailDistanceR: n }), 0.1, 0.1, 10)}
                    <span className="ord-am-u">R</span>
                  </div>
                </div>

                {/* 分批止盈 / partial take-profit */}
                <div className="ord-am-rule" data-off={!autoCfg.ptpEnabled || undefined}>
                  <label className="ord-am-rule-n">
                    <Switch checked={autoCfg.ptpEnabled} onChange={(v) => setAutoCfg({ ...autoCfg, ptpEnabled: v })} />
                    <span>{t('account.autoPtp')}</span>
                  </label>
                  <div className="ord-am-rule-p">
                    <span className="ord-am-lbl">{t('account.autoTriggerAt')}</span>
                    {numInput(autoCfg.ptpTriggerR, (n) => setAutoCfg({ ...autoCfg, ptpTriggerR: n }), 0.1, 0.1, 10)}
                    <span className="ord-am-u">R</span>
                    <span className="ord-am-lbl ord-am-lbl-2">{t('account.autoPtpFraction')}</span>
                    {numInput(Math.round(autoCfg.ptpFraction * 100), (n) => setAutoCfg({ ...autoCfg, ptpFraction: n / 100 }), 5, 10, 90)}
                    <span className="ord-am-u">%</span>
                  </div>
                </div>
              </div>
              <p className="ord-am-note">{t('account.autoScopeNote')}</p>
            </>
          )}

          <div className="ord-am-foot">
            <button
              onClick={saveAutoCfg}
              disabled={autoSaving}
              className="btn-primary px-5 py-2 text-sm disabled:opacity-40"
            >
              {autoSaving ? t('common.loading') : t('common.save')}
            </button>
            {autoMsg && (
              <p className={`ord-am-msg ${autoMsg.kind === 'err' ? 'text-down' : 'text-up'}`}>{autoMsg.text}</p>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
