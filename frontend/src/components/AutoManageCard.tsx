// 自动仓位管理设置（保本 / 追踪止损 / 分批止盈）。
// 住在订单页"持仓与账户"Tab 的持仓列表下方——管理对象就是上面那些仓位，挨着
// 看最直观，放进设置页则没人找得到。2026-09-08 起随订单页重做改成「账本行」
// （.ord-lrow，与样例稿一致）：左栏标题 + 作用范围 + 说明，右栏一行一条规则——
// 规则名、一句带内嵌数字框的说明、开关在右；总开关是第一行。没有卡片外壳。
// ⚠️ 这是每用户一条的全局配置（后端 AutoManageSettings 在 user_id 上有 unique
// 约束），对绑定的全部 MT5 账号生效，**不随订单页页头的账号选择器变化**，而那个
// Tab 里其余内容都随之变化。所以本组件自带上方发丝线分隔，并要求调用点把
// orders.autoManageScopeHint 那句作用范围说明通过 scopeHint 传进来放在左栏首行，
// 否则用户在账号 A 下调完、切到 B 看见同样的值会以为串号或没存上。
// 自己拉取、自己保存，调用方只需传 isPro 与 scopeHint。
// Auto position-management settings (break-even / trailing stop / partial TP).
// Lives below the positions list in the Orders page's "positions & account"
// tab — it acts on exactly those positions, so adjacency is the most intuitive
// placement; buried in settings, nobody finds it. Since the 2026-09-08 orders
// redesign it renders as a "ledger row" (.ord-lrow, matching the mock): title,
// scope and hint on the left; one rule per row on the right — name, a sentence
// with inline number fields, switch at the right edge; the master switch is the
// first row. No card shell.
// ⚠️ This is a single per-user config (unique constraint on the backend's
// AutoManageSettings.user_id) applying to every linked MT5 account, and it does
// NOT follow the Orders page-head account selector even though everything else
// in that tab does. The component therefore draws its own hairline divider and
// requires orders.autoManageScopeHint as scopeHint for the first line of the
// left column, or a user who tunes it under account A and switches to B will
// read the identical values as cross-account leakage or a failed save.
// Self-fetching and self-saving; callers pass only isPro and scopeHint.
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
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

function Rule({
  name,
  desc,
  on,
  onToggle,
  master = false,
}: {
  name: string
  desc: ReactNode
  on: boolean
  onToggle: (v: boolean) => void
  master?: boolean
}) {
  return (
    <div className={`ord-rule ${master ? 'ord-rule-master' : ''}`} data-off={!on || undefined}>
      <div>
        <div className="ord-rule-k">{name}</div>
        <div className="ord-rule-d">{desc}</div>
      </div>
      <Switch checked={on} onChange={onToggle} aria-label={name} />
    </div>
  )
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

  const num = (value: number, onChange: (n: number) => void, step: number, min: number, max: number) => (
    <input
      type="number"
      step={step}
      min={min}
      max={max}
      className="input ord-rule-in"
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  )

  return (
    <section className="ord-lrow">
      <div>
        <h4>
          {t('account.autoTitle')}
          <span className={`ord-pro ${isPro ? '' : 'off'}`}>{isPro ? 'PRO' : t('orders.proExclusive')}</span>
        </h4>
        <p className="ord-lrow-scope">{scopeHint}</p>
        <p>{t('account.autoHint')}</p>
      </div>

      <div className="ord-lrow-bd">
        {!isPro ? (
          <p className="ord-rule-up">
            {t('account.autoUpgradeRequired')}{' '}
            <Link to="/upgrade" className="text-prism-400 underline hover:text-prism-300">
              {t('nav.upgrade')}
            </Link>
          </p>
        ) : !autoCfg ? (
          <>
            <SkeletonLine height={44} />
            <SkeletonLine height={44} className="mt-3" />
            <SkeletonLine height={44} className="mt-3" />
          </>
        ) : (
          <>
            <Rule
              master
              name={t('account.autoEnable')}
              desc={t('account.autoScopeNote')}
              on={autoCfg.enabled}
              onToggle={(v) => setAutoCfg({ ...autoCfg, enabled: v })}
            />
            <div className="ord-rules" data-off={!autoCfg.enabled || undefined}>
              <Rule
                name={t('account.autoBe')}
                on={autoCfg.beEnabled}
                onToggle={(v) => setAutoCfg({ ...autoCfg, beEnabled: v })}
                desc={
                  <>
                    {t('orders.am.be.pre')}
                    {num(autoCfg.beTriggerR, (n) => setAutoCfg({ ...autoCfg, beTriggerR: n }), 0.1, 0.1, 10)}
                    {t('orders.am.be.post')}
                  </>
                }
              />
              <Rule
                name={t('account.autoTrail')}
                on={autoCfg.trailEnabled}
                onToggle={(v) => setAutoCfg({ ...autoCfg, trailEnabled: v })}
                desc={
                  <>
                    {t('orders.am.trail.pre')}
                    {num(autoCfg.trailTriggerR, (n) => setAutoCfg({ ...autoCfg, trailTriggerR: n }), 0.1, 0.1, 10)}
                    {t('orders.am.trail.mid')}
                    {num(autoCfg.trailDistanceR, (n) => setAutoCfg({ ...autoCfg, trailDistanceR: n }), 0.1, 0.1, 10)}
                    {t('orders.am.trail.post')}
                  </>
                }
              />
              <Rule
                name={t('account.autoPtp')}
                on={autoCfg.ptpEnabled}
                onToggle={(v) => setAutoCfg({ ...autoCfg, ptpEnabled: v })}
                desc={
                  <>
                    {t('orders.am.ptp.pre')}
                    {num(autoCfg.ptpTriggerR, (n) => setAutoCfg({ ...autoCfg, ptpTriggerR: n }), 0.1, 0.1, 10)}
                    {t('orders.am.ptp.mid')}
                    {num(Math.round(autoCfg.ptpFraction * 100), (n) => setAutoCfg({ ...autoCfg, ptpFraction: n / 100 }), 5, 10, 90)}
                    {t('orders.am.ptp.post')}
                  </>
                }
              />
            </div>
            <div className="ord-rule-foot">
              <button
                onClick={saveAutoCfg}
                disabled={autoSaving}
                className="btn-primary px-5 py-2 text-sm disabled:opacity-40"
              >
                {autoSaving ? t('common.loading') : t('common.save')}
              </button>
              {autoMsg && (
                <p className={`ord-rule-msg ${autoMsg.kind === 'err' ? 'text-down' : 'text-up'}`}>{autoMsg.text}</p>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  )
}
