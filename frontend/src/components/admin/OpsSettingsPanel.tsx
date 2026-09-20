// 管理后台「运营设置」页签：合作券商锁 / 订阅定价 / 免费试用 / 注册邮箱闸门 / 官方社交主页。
//
// 这五张设置卡原先内联在 AdminPage 里（另外 10 个页签早已各自成 Panel），带着 5 组彼此
// 无关的 `xxx / savingXxx` 状态对，48 个 useState 挤在一个 1288 行的组件里：任何一个
// 变化都重渲染整棵树，券商锁草稿和用户表草稿住在同一个作用域——AdminPage 里
// savedTrialEnabled 那段注释就是这种共居咬过人的证据。2026-09-21 拆出来，读写与表单
// 都在这里；唯一要回传给 AdminPage 的是「试用已保存值」（邀请页签要用），走 onTrialSaved。
//
// 页签间的分界（ops 改商业条款、system 改后台怎么算）见 AdminPage 里 AdminTab 的说明。
//
// The admin "ops" tab: broker lock / pricing / free trial / signup email gate /
// official social links. These five cards used to be inlined in AdminPage (the other
// ten tabs were already Panels), contributing five unrelated `xxx / savingXxx` state
// pairs to a 1288-line component with 48 useStates. Split out on 2026-09-21; the only
// thing reported back is the persisted trial flag (the invites tab needs it).
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { adminApi } from '../../api/client'
import { localizeApiError } from '../../api/utils'
import Switch from '../Switch'
import { SkeletonLine } from '../Skeleton'
import { useToast } from '../../utils/useToast'
import type {
  AdminBrokerSettings,
  AdminEmailGateSettings,
  AdminPricingSettings,
  AdminSocialSettings,
  AdminTrialSettings,
} from '../../api/types'

// 社交平台字段表：数组顺序就是后台表单顺序。平台名是品牌名，不进 i18n；
// placeholder 给出该平台「官方主页」的典型形状，省得填的人去猜要放个人页、
// 分享短链还是 App 内跳转链接——这五个平台的链接形态差别不小。
// Social field table; array order is the form order. Platform names are brands
// and stay out of i18n. Each placeholder shows what that platform's official
// page URL normally looks like, so nobody has to guess between a profile page,
// a share shortlink and an in-app deep link — the five differ a fair amount.
const SOCIAL_FIELDS: { key: keyof AdminSocialSettings; label: string; placeholder: string }[] = [
  { key: 'facebookUrl', label: 'Facebook', placeholder: 'https://www.facebook.com/yourpage' },
  { key: 'instagramUrl', label: 'Instagram', placeholder: 'https://www.instagram.com/youraccount' },
  { key: 'xUrl', label: 'X', placeholder: 'https://x.com/youraccount' },
  { key: 'discordUrl', label: 'Discord', placeholder: 'https://discord.gg/xxxxxxx' },
  { key: 'telegramUrl', label: 'Telegram', placeholder: 'https://t.me/yourchannel' },
]

interface Props {
  /** 试用设置保存成功后回传"全局试用是否开着"的已保存值（见 AdminPage 的 savedTrialEnabled）。
   *  Reports the persisted trial flag after a successful save (see AdminPage's savedTrialEnabled). */
  onTrialSaved?: (enabled: boolean) => void
}

export default function OpsSettingsPanel({ onTrialSaved }: Props) {
  const { t } = useTranslation()
  const { toast, showToast } = useToast()
  const [loading, setLoading] = useState(true)

  // 合作券商锁设置（patterns 在输入框里以逗号分隔编辑）
  // partner-broker lock settings (patterns edited as a comma-separated string)
  const [brokerSettings, setBrokerSettings] = useState<AdminBrokerSettings | null>(null)
  const [brokerPatternsText, setBrokerPatternsText] = useState('')
  const [savingBroker, setSavingBroker] = useState(false)

  // 订阅定价设置 / subscription pricing settings
  const [pricing, setPricing] = useState<AdminPricingSettings | null>(null)
  const [savingPricing, setSavingPricing] = useState(false)

  // 免费试用设置 / free-trial settings
  const [trial, setTrial] = useState<AdminTrialSettings | null>(null)
  const [savingTrial, setSavingTrial] = useState(false)


  // 注册邮箱限制（一次性邮箱闸门）/ signup email gate
  //
  // 两个名单在界面上是多行文本框，state 里也就存文本而不是数组：管理员正在
  // 敲的中间状态（空行、还没打完的域名）如果每次 onChange 都往数组里塞，光标
  // 会因为重新渲染跳走，空行也会被吃掉。保存时才切成数组，和券商锁那个
  // brokerPatternsText 是同一个先例。
  //
  // The two lists are textareas, so the draft lives as text rather than an
  // array: parsing on every keystroke eats the blank line the admin is typing
  // through and moves the caret. Split on save — same precedent as
  // brokerPatternsText above.
  const [emailGate, setEmailGate] = useState<AdminEmailGateSettings | null>(null)
  const [emailBlockedText, setEmailBlockedText] = useState('')
  const [emailAllowedText, setEmailAllowedText] = useState('')
  const [savingEmailGate, setSavingEmailGate] = useState(false)

  // 官方社交主页 / official social links
  const [social, setSocial] = useState<AdminSocialSettings | null>(null)
  const [savingSocial, setSavingSocial] = useState(false)

  useEffect(() => {
    let alive = true
    ;(async () => {
      // 五个接口各自 settle：一个失败其余照常显示，只提示"N 项没加载出来"。
      // Five endpoints settle independently; one failure never hides the others.
      const results = await Promise.allSettled([
        adminApi.getSettings(),
        adminApi.getPricing(),
        adminApi.getTrial(),
        adminApi.getSocial(),
        adminApi.getEmailGate(),
      ])
      if (!alive) return
      const [settingsRes, pricingRes, trialRes, socialRes, emailGateRes] = results
      let failed = 0
      const ok = <T,>(r: PromiseSettledResult<T>): T | null => {
        if (r.status === 'fulfilled') return r.value
        failed += 1
        return null
      }
      const settings = ok(settingsRes)
      if (settings) {
        setBrokerSettings(settings)
        setBrokerPatternsText(settings.brokerPatterns.join(', '))
      }
      const pricingVal = ok(pricingRes)
      if (pricingVal) setPricing(pricingVal)
      const trialVal = ok(trialRes)
      if (trialVal) setTrial(trialVal)
      const socialVal = ok(socialRes)
      if (socialVal) setSocial(socialVal)
      const emailGateVal = ok(emailGateRes)
      if (emailGateVal) {
        setEmailGate(emailGateVal)
        setEmailBlockedText(emailGateVal.extraBlockedDomains.join('\n'))
        setEmailAllowedText(emailGateVal.extraAllowedDomains.join('\n'))
      }
      if (failed > 0) {
        const firstErr = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined
        const reason = firstErr?.reason
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

  const saveBrokerSettings = async () => {
    if (!brokerSettings) return
    setSavingBroker(true)
    try {
      const updated = await adminApi.updateSettings({
        ...brokerSettings,
        brokerPatterns: brokerPatternsText.split(',').map((p) => p.trim()).filter(Boolean),
      })
      setBrokerSettings(updated)
      setBrokerPatternsText(updated.brokerPatterns.join(', '))
      showToast('ok', t('admin.saved'))
    } catch (err) {
      showToast('err', err instanceof Error ? localizeApiError(err.message) : t('admin.saveError'))
    } finally {
      setSavingBroker(false)
    }
  }

  const savePricing = async () => {
    if (!pricing) return
    setSavingPricing(true)
    try {
      const updated = await adminApi.updatePricing(pricing)
      setPricing(updated)
      showToast('ok', t('admin.saved'))
    } catch (err) {
      showToast('err', err instanceof Error ? localizeApiError(err.message) : t('admin.saveError'))
    } finally {
      setSavingPricing(false)
    }
  }

  const saveTrial = async () => {
    if (!trial) return
    setSavingTrial(true)
    try {
      const updated = await adminApi.updateTrial(trial)
      setTrial(updated)
      onTrialSaved?.(updated.trialEnabled)
      showToast('ok', t('admin.saved'))
    } catch (err) {
      showToast('err', err instanceof Error ? localizeApiError(err.message) : t('admin.saveError'))
    } finally {
      setSavingTrial(false)
    }
  }

  const saveSocial = async () => {
    if (!social) return
    // 先在本地挡一道协议错误。后端也校验，但那是一条英文 422，管理员看到的是
    // 一串字段名而不是"Telegram 这一行填错了"——填五个框的表单必须说清是哪个。
    // Catch the scheme error locally first. The backend validates too, but its
    // 422 names the raw field, not "the Telegram row is wrong" — on a five-box
    // form the message has to say which box.
    const bad = SOCIAL_FIELDS.find((f) => {
      const v = (social[f.key] || '').trim()
      return v !== '' && !/^https?:\/\//i.test(v)
    })
    if (bad) {
      showToast('err', t('admin.socialInvalidUrl', { platform: bad.label }))
      return
    }
    setSavingSocial(true)
    try {
      const updated = await adminApi.updateSocial(social)
      setSocial(updated)
      showToast('ok', t('admin.saved'))
    } catch (err) {
      showToast('err', err instanceof Error ? localizeApiError(err.message) : t('admin.saveError'))
    } finally {
      setSavingSocial(false)
    }
  }

  const saveEmailGate = async () => {
    if (!emailGate) return
    setSavingEmailGate(true)
    try {
      const split = (text: string) =>
        text.split('\n').map((d) => d.trim()).filter(Boolean)
      const updated = await adminApi.updateEmailGate({
        ...emailGate,
        extraBlockedDomains: split(emailBlockedText),
        extraAllowedDomains: split(emailAllowedText),
      })
      setEmailGate(updated)
      // 回填后端规范化后的结果：后端会去掉粘贴时带的 @、结尾的点并去重，不回填
      // 的话框里留着的还是管理员刚敲的原样，下次保存又要被规范化一遍，看着像没存上。
      // Reflect the server's normalisation (stripped @ prefixes, trailing dots,
      // duplicates) — otherwise the box still shows the raw input and the next
      // save looks like it didn't take.
      setEmailBlockedText(updated.extraBlockedDomains.join('\n'))
      setEmailAllowedText(updated.extraAllowedDomains.join('\n'))
      showToast('ok', t('admin.saved'))
    } catch (err) {
      showToast('err', err instanceof Error ? localizeApiError(err.message) : t('admin.saveError'))
    } finally {
      setSavingEmailGate(false)
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
      {/* 合作券商锁设置 / partner-broker lock settings */}
      {brokerSettings && (
        <div className="glass mb-5 p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h3 className="font-display text-lg font-semibold text-neutral-100">{t('admin.brokerTitle')}</h3>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-neutral-300">
              <Switch checked={brokerSettings.brokerLockEnabled} onChange={(v) => setBrokerSettings({ ...brokerSettings, brokerLockEnabled: v })} />
              {t('admin.brokerLockEnabled')}
            </label>
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <div>
              <label className="label">{t('admin.brokerPatterns')}</label>
              <input
                className="input"
                value={brokerPatternsText}
                onChange={(e) => setBrokerPatternsText(e.target.value)}
                placeholder="MakeCapital"
              />
              <p className="mt-1.5 text-xs text-neutral-500">{t('admin.brokerPatternsHint')}</p>
            </div>
            <div>
              <label className="label">{t('admin.brokerDisplayName')}</label>
              <input
                className="input"
                value={brokerSettings.brokerDisplayName}
                onChange={(e) => setBrokerSettings({ ...brokerSettings, brokerDisplayName: e.target.value })}
                placeholder="MakeCapital"
              />
            </div>
            <div>
              <label className="label">{t('admin.brokerReferralUrl')}</label>
              <input
                className="input"
                value={brokerSettings.brokerReferralUrl}
                onChange={(e) => setBrokerSettings({ ...brokerSettings, brokerReferralUrl: e.target.value })}
                placeholder="https://…"
              />
              {/* 这个字段以前填了没有任何效果（前端没人渲染它）。现在它同时决定
                  三处推广位是否出现，所以把作用范围写在旁边。
                  This field used to have no effect at all (nothing rendered it).
                  It now gates three promo placements, so say so next to it. */}
              <p className="mt-1.5 text-xs text-neutral-500">{t('admin.brokerReferralUrlHint')}</p>
            </div>
          </div>
          <button
            className="btn-primary mt-4 px-5 py-2 text-sm disabled:opacity-40"
            disabled={savingBroker}
            onClick={saveBrokerSettings}
          >
            {savingBroker ? t('common.loading') : t('common.save')}
          </button>
        </div>
      )}

      {/* 订阅定价设置 / subscription pricing settings */}
      {pricing && (
        <div className="glass mb-5 p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h3 className="font-display text-lg font-semibold text-neutral-100">{t('admin.pricingTitle')}</h3>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-neutral-300">
              <Switch checked={pricing.saleEnabled} onChange={(v) => setPricing({ ...pricing, saleEnabled: v })} />
              {t('admin.saleEnabled')}
            </label>
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
            <div>
              <label className="label">{t('admin.proMonthlyPrice')}</label>
              <div className="flex items-center gap-1">
                <span className="text-neutral-400">$</span>
                <input
                  type="number"
                  className="input"
                  step="0.01"
                  min="0"
                  value={pricing.proMonthlyPrice}
                  onChange={(e) => setPricing({ ...pricing, proMonthlyPrice: parseFloat(e.target.value) || 0 })}
                />
              </div>
              <p className="mt-1 text-[11px] text-neutral-500">{t('admin.proMonthlyPriceHint')}</p>
            </div>
            <div>
              <label className="label">{t('admin.proYearlyPrice')}</label>
              <div className="flex items-center gap-1">
                <span className="text-neutral-400">$</span>
                <input
                  type="number"
                  className="input"
                  step="0.01"
                  min="0"
                  value={pricing.proYearlyPrice}
                  onChange={(e) => setPricing({ ...pricing, proYearlyPrice: parseFloat(e.target.value) || 0 })}
                />
              </div>
              <p className="mt-1 text-[11px] text-neutral-500">{t('admin.proYearlyPriceHint')}</p>
            </div>
            <div>
              <label className="label">{t('admin.salePercent')}</label>
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  className="input"
                  min="0"
                  max="100"
                  value={pricing.salePercent}
                  onChange={(e) => setPricing({ ...pricing, salePercent: Math.min(100, Math.max(0, parseInt(e.target.value) || 0)) })}
                  disabled={!pricing.saleEnabled}
                />
                <span className="text-neutral-400">%</span>
              </div>
              <p className="mt-1 text-[11px] text-neutral-500">{t('admin.salePercentHint')}</p>
            </div>
            <div>
              <label className="label">{t('admin.saleBadge')}</label>
              <input
                className="input"
                value={pricing.saleBadge}
                onChange={(e) => setPricing({ ...pricing, saleBadge: e.target.value })}
                disabled={!pricing.saleEnabled}
                placeholder="SUMMER"
                maxLength={32}
              />
              <p className="mt-1 text-[11px] text-neutral-500">{t('admin.saleBadgeHint')}</p>
            </div>
          </div>
          {pricing.saleEnabled && (
            <div className="mt-4 rounded-lg border border-prism-400/20 bg-prism-500/10 px-4 py-3 text-sm text-prism-300">
              {/* toFixed(2)：29.9 × 0.85 的浮点结果是 25.414999999999996，而这正是
                  管理员用来判断"这个折扣要不要保存"的那个数字。
                  toFixed(2): 29.9 × 0.85 renders as 25.414999999999996 in binary
                  floating point, and this is the number the admin reads to decide
                  whether to save the discount. */}
              {t('admin.salePreview')}:{" "}
              <strong>${(pricing.proMonthlyPrice * (1 - pricing.salePercent / 100)).toFixed(2)}</strong> /{t('upgrade.monthly')}{" "}
              &middot;{" "}
              <strong>${(pricing.proYearlyPrice * (1 - pricing.salePercent / 100)).toFixed(2)}</strong> /{t('upgrade.yearly')}
            </div>
          )}
          <button
            className="btn-primary mt-4 px-5 py-2 text-sm disabled:opacity-40"
            disabled={savingPricing}
            onClick={savePricing}
          >
            {savingPricing ? t('common.loading') : t('common.save')}
          </button>
        </div>
      )}

      {/* 免费试用设置 / free-trial settings */}
      {trial && (
        <div className="glass mb-5 p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h3 className="font-display text-lg font-semibold text-neutral-100">{t('admin.trialTitle')}</h3>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-neutral-300">
              <Switch checked={trial.trialEnabled} onChange={(v) => setTrial({ ...trial, trialEnabled: v })} />
              {t('admin.trialEnabled')}
            </label>
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
            <div>
              <label className="label">{t('admin.trialDays')}</label>
              <input
                type="number"
                className="input"
                min="1"
                max="90"
                value={trial.trialDays}
                onChange={(e) => setTrial({ ...trial, trialDays: Math.min(90, Math.max(1, parseInt(e.target.value) || 1)) })}
                disabled={!trial.trialEnabled}
              />
            </div>
          </div>
          <button
            className="btn-primary mt-4 px-5 py-2 text-sm disabled:opacity-40"
            disabled={savingTrial}
            onClick={saveTrial}
          >
            {savingTrial ? t('common.loading') : t('common.save')}
          </button>
        </div>
      )}

      {/* 注册邮箱限制 / signup email gate */}
      {emailGate && (
        <div className="glass mb-5 p-5">
          <div className="mb-1.5 flex flex-wrap items-center justify-between gap-3">
            <h3 className="font-display text-lg font-semibold text-neutral-100">{t('admin.emailGateTitle')}</h3>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-neutral-300">
              <Switch
                checked={emailGate.disposableBlockEnabled}
                onChange={(v) => setEmailGate({ ...emailGate, disposableBlockEnabled: v })}
              />
              {t('admin.emailGateEnabled')}
            </label>
          </div>
          <p className="mb-4 text-xs text-neutral-500">{t('admin.emailGateHint')}</p>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <label className="label">{t('admin.emailGateExtraBlocked')}</label>
              <textarea
                className="input min-h-28 font-mono text-xs"
                spellCheck={false}
                value={emailBlockedText}
                onChange={(e) => setEmailBlockedText(e.target.value)}
                placeholder={'mailinator.com\n10minutemail.com'}
              />
              <p className="mt-1.5 text-xs text-neutral-500">{t('admin.emailGateListHint')}</p>
            </div>
            <div>
              <label className="label">{t('admin.emailGateExtraAllowed')}</label>
              <textarea
                className="input min-h-28 font-mono text-xs"
                spellCheck={false}
                value={emailAllowedText}
                onChange={(e) => setEmailAllowedText(e.target.value)}
                placeholder={'mycompany.com\nuniversity.edu.cn'}
              />
              <p className="mt-1.5 text-xs text-neutral-500">{t('admin.emailGateAllowedHint')}</p>
            </div>
          </div>
          <button
            className="btn-primary mt-4 px-5 py-2 text-sm disabled:opacity-40"
            disabled={savingEmailGate}
            onClick={saveEmailGate}
          >
            {savingEmailGate ? t('common.loading') : t('common.save')}
          </button>
        </div>
      )}

      {/* 官方社交主页 / official social links */}
      {social && (
        <div className="glass mb-5 p-5">
          <h3 className="mb-1.5 font-display text-lg font-semibold text-neutral-100">{t('admin.socialTitle')}</h3>
          <p className="mb-4 text-xs text-neutral-500">{t('admin.socialHint')}</p>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {SOCIAL_FIELDS.map((f) => (
              <div key={f.key}>
                <label className="label">{f.label}</label>
                <input
                  className="input"
                  type="url"
                  inputMode="url"
                  spellCheck={false}
                  maxLength={512}
                  value={social[f.key]}
                  onChange={(e) => setSocial({ ...social, [f.key]: e.target.value })}
                  placeholder={f.placeholder}
                />
              </div>
            ))}
          </div>
          <button
            className="btn-primary mt-4 px-5 py-2 text-sm disabled:opacity-40"
            disabled={savingSocial}
            onClick={saveSocial}
          >
            {savingSocial ? t('common.loading') : t('common.save')}
          </button>
        </div>
      )}

    </div>
  )
}
