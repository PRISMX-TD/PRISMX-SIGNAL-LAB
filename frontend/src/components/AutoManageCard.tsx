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
import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import Switch from './Switch'
import NumberInput from './NumberInput'
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
  // 服务器最后确认的那一份（读取成功或保存成功时更新），用来判断有没有没保存的改动。
  // The last config the server confirmed (on read or save), to tell whether edits are unsaved.
  const [savedCfg, setSavedCfg] = useState<AutoManageSettings | null>(null)

  // 读取失败要进错误态并给「重试」：以前 catch 吞掉之后 autoCfg 永远是 null，
  // 这块就永远是骨架屏——看起来像「还在加载」，其实早就失败了。
  // A failed read gets an error state with Retry: the old catch swallowed it,
  // leaving autoCfg null and the skeleton spinning forever — "still loading"
  // when it had long since failed.
  const [loadFailed, setLoadFailed] = useState(false)
  const load = useCallback(() => {
    setLoadFailed(false)
    automationApi.getSettings().then((s) => { setAutoCfg(s); setSavedCfg(s) }).catch(() => setLoadFailed(true))
  }, [])
  // 非 PRO 也读一次：PRO 到期 / 试用结束的用户总开关可能还存着「开」，后端却已不再
  // 执行，只给一句通用的「升级解锁」会让他以为止损还在被自动管理。读失败就退回通用提示。
  // Non-PRO reads too: a user whose PRO lapsed may still have the switch saved on
  // while the backend no longer acts on it; the generic upsell would leave them
  // believing their stops are still managed. A failed read falls back to the upsell.
  useEffect(() => {
    if (isPro) load()
    else automationApi.getSettings().then((s) => { setAutoCfg(s); setSavedCfg(s) }).catch(() => {})
  }, [isPro, load])

  async function saveAutoCfg() {
    if (!autoCfg) return
    setAutoSaving(true)
    setAutoMsg(null)
    try {
      const updated = await automationApi.putSettings(autoCfg)
      setAutoCfg(updated)
      setSavedCfg(updated)
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

  // 任何改动都清掉上一句「已保存 / 保存失败」：那句话说的是上一个版本。以前它一直挂着，
  // 用户改完以为已经生效，直接离开。
  // Any edit clears the last "saved / failed" line: it described the previous version. It used
  // to linger, so users edited, read "saved", and left with nothing applied.
  const edit = (patch: Partial<AutoManageSettings>) => {
    setAutoCfg((c) => (c ? { ...c, ...patch } : c))
    setAutoMsg(null)
  }
  // 逐字段与服务器那份比较（全是布尔和数字）；改回原值就不算改动。
  // Field-by-field against the server copy (all booleans and numbers); reverting counts as clean.
  const dirty = autoCfg != null && savedCfg != null
    && (Object.keys(autoCfg) as (keyof AutoManageSettings)[]).some((k) => autoCfg[k] !== savedCfg[k])

  // 文本缓冲在 NumberInput 里：以前直接绑数字，手机上删空的那一拍就变成 0，删不掉。
  // NumberInput keeps the text buffer; binding the number made the field un-clearable.
  // 句中嵌的数字框没有可见标签（前后文字就是标签），读屏只会念「编辑框」，所以每个框带一个
  // 完整的 aria-label，说清楚是哪条规则的哪个数、单位是什么。
  // The inline fields have no visible label (the sentence around them is the label), so a screen
  // reader would only say "edit"; each gets a full aria-label naming the rule, the value and its unit.
  const num = (label: string, value: number, onChange: (n: number) => void, min: number, max: number, integer = false) => (
    <NumberInput
      className="input ord-rule-in"
      aria-label={label}
      value={value}
      onChange={onChange}
      min={min}
      max={max}
      integer={integer}
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
          <p className="ord-rule-up" role={autoCfg?.enabled ? 'status' : undefined}>
            {autoCfg?.enabled ? (
              <span className="text-warn">{t('account.autoPausedNotPro')}</span>
            ) : (
              t('account.autoUpgradeRequired')
            )}{' '}
            <Link to="/upgrade" className="text-prism-400 underline hover:text-prism-300">
              {t('nav.upgrade')}
            </Link>
          </p>
        ) : !autoCfg && loadFailed ? (
          <div className="ord-rule-up" role="alert">
            <span className="text-down">{t('admin.loadError')}</span>{' '}
            <button type="button" onClick={load} className="text-prism-400 underline hover:text-prism-300">
              {t('connStatus.retry')}
            </button>
          </div>
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
              onToggle={(v) => edit({ enabled: v })}
            />
            <div className="ord-rules" data-off={!autoCfg.enabled || undefined}>
              <Rule
                name={t('account.autoBe')}
                on={autoCfg.beEnabled}
                onToggle={(v) => edit({ beEnabled: v })}
                desc={
                  <>
                    {t('orders.am.be.pre')}
                    {num(t('orders.am.be.trigger'), autoCfg.beTriggerR,(n) => edit({ beTriggerR: n }), 0.1, 10)}
                    {t('orders.am.be.post')}
                  </>
                }
              />
              <Rule
                name={t('account.autoTrail')}
                on={autoCfg.trailEnabled}
                onToggle={(v) => edit({ trailEnabled: v })}
                desc={
                  <>
                    {t('orders.am.trail.pre')}
                    {num(t('orders.am.trail.trigger'), autoCfg.trailTriggerR,(n) => edit({ trailTriggerR: n }), 0.1, 10)}
                    {t('orders.am.trail.mid')}
                    {num(t('orders.am.trail.distance'), autoCfg.trailDistanceR,(n) => edit({ trailDistanceR: n }), 0.1, 10)}
                    {t('orders.am.trail.post')}
                  </>
                }
              />
              <Rule
                name={t('account.autoPtp')}
                on={autoCfg.ptpEnabled}
                onToggle={(v) => edit({ ptpEnabled: v })}
                desc={
                  <>
                    {t('orders.am.ptp.pre')}
                    {num(t('orders.am.ptp.trigger'), autoCfg.ptpTriggerR,(n) => edit({ ptpTriggerR: n }), 0.1, 10)}
                    {t('orders.am.ptp.mid')}
                    {num(t('orders.am.ptp.fraction'), Math.round(autoCfg.ptpFraction * 100),(n) => edit({ ptpFraction: n / 100 }), 10, 90, true)}
                    {t('orders.am.ptp.post')}
                  </>
                }
              />
            </div>
            <div className="ord-rule-foot">
              <button
                onClick={saveAutoCfg}
                disabled={autoSaving || !dirty}
                data-fd-plain
                className="btn-primary px-5 py-2 text-sm disabled:opacity-40"
              >
                {autoSaving ? t('account.autoSaving') : t('account.autoSaveChanges')}
              </button>
              {autoMsg ? (
                <p
                  className={`ord-rule-msg ${autoMsg.kind === 'err' ? 'text-down' : 'text-up'}`}
                  role={autoMsg.kind === 'err' ? 'alert' : 'status'}
                >
                  {autoMsg.text}
                </p>
              ) : dirty ? (
                // 有没保存的改动：占用同一个消息位，替代以前一直挂着的「已保存」。
                // Unsaved edits take the same message slot the stale "saved" line used to hold.
                <p className="ord-rule-msg text-mid">{t('account.autoUnsaved')}</p>
              ) : null}
            </div>
          </>
        )}
      </div>
    </section>
  )
}
