// 参赛准备清单（设计 §4「站内比赛页详情：报名制且本人未报名」）：
// 验证邮箱 →（有开户链接时）开户 → 直连绑定 → 资金核对（列出可参赛账户的当前余额）→ 报名。
// 每步的完成判定在 utils/compPrep.prepState；本组件只负责展示与跳转。
// Entry checklist (spec §4): verify email → (with a link) open account → connect directly →
// funds check (current balance of each eligible account) → enter. Completion is decided by
// utils/compPrep.prepState; this component only renders and links.
import { Link } from 'react-router-dom'
import type { TFunction } from 'i18next'
import { fmtUsd } from '../../api/utils'
import { EmailVerifyInline } from '../EmailVerifyNotice'
import { fundsOk, fundsRule, type BindHint, type CompGates, type PrepKey, type PrepState } from '../../utils/compPrep'

const LABEL: Record<PrepKey, string> = {
  email: 'competition.prep.stepEmail',
  openAccount: 'competition.prep.stepOpen',
  bind: 'competition.prep.stepBind',
  funds: 'competition.prep.stepFunds',
  register: 'competition.prep.stepRegister',
}

const HINT: Record<Exclude<BindHint, null>, string> = {
  noAccounts: 'competition.noAccounts',
  gatewayOnly: 'competition.prep.gatewayOnly',
  pendingType: 'competition.pendingAccountType',
  wrongTrack: 'competition.prep.noEligible',
}

export default function PrepChecklist({ prep, gates, openAccountUrl, hint, canRegister, onRegister, t }: {
  prep: PrepState
  gates: CompGates
  openAccountUrl: string
  hint: BindHint
  canRegister: boolean
  onRegister: () => void
  t: TFunction
}) {
  const rule = fundsRule(gates)
  const fundsText = rule.kind === 'exact'
    ? t('competition.prep.fundsExact', { usd: fmtUsd(rule.usd) })
    : rule.kind === 'range'
      ? t('competition.prep.fundsRange', { min: fmtUsd(rule.min), max: fmtUsd(rule.max) })
      : t('competition.prep.fundsMin', { min: fmtUsd(rule.min) })

  const body = (key: PrepKey, done: boolean) => {
    switch (key) {
      case 'email':
        return done ? null : <EmailVerifyInline reason="bind" className="mt-2" />
      case 'openAccount':
        return done || !openAccountUrl ? null : (
          <a href={openAccountUrl} target="_blank" rel="noopener noreferrer" className="cmp-prep-act">
            {t('competition.prep.stepOpenBtn')} ↗
          </a>
        )
      case 'bind':
        return done ? null : (
          <>
            {hint && <span className="cmp-prep-sub">{t(HINT[hint])}</span>}
            <Link to="/bind" className="cmp-prep-act">{t('competition.prep.stepBindBtn')} →</Link>
          </>
        )
      case 'funds':
        return (
          <>
            <span className="cmp-prep-sub">{fundsText}</span>
            {prep.eligible.length === 0 ? (
              <span className="cmp-prep-sub">{t('competition.prep.noEligible')}</span>
            ) : (
              prep.eligible.map((a) => {
                const ok = fundsOk(a, gates)
                return (
                  <span key={a.login} className={`cmp-prep-sub num ${ok === true ? 'text-up' : ok === false ? 'text-down' : ''}`}>
                    {a.balance == null
                      ? t('competition.prep.balanceUnknown', { login: a.login })
                      : t('competition.prep.balanceOf', { login: a.login, balance: fmtUsd(a.balance) })}
                  </span>
                )
              })
            )}
          </>
        )
      case 'register':
        return canRegister ? (
          <button type="button" onClick={onRegister} className="cmp-btn mt-2">{t('competition.register')}</button>
        ) : null
    }
  }

  return (
    <div className="cmp-prep">
      <h4>{t('competition.prep.title')}</h4>
      <ol>
        {prep.steps.map((s, i) => (
          <li key={s.key} className={s.done ? 'is-done' : ''}>
            <span className="cmp-prep-mark" role="img" aria-label={t(s.done ? 'competition.prep.done' : 'competition.prep.todo')}>
              {s.done ? '✓' : i + 1}
            </span>
            <div className="min-w-0">
              <span className="cmp-prep-label">{t(LABEL[s.key])}</span>
              {body(s.key, s.done)}
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}
