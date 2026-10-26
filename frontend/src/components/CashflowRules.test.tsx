// 本金门槛那一段的渲染冒烟：周期榜一档显示「只剔除不够门槛的那几笔」的规则和例子，
// 例子里的金额跟着门槛走（100 → 90 / 亏 10）；比赛一档不显示（比赛分母固定为报名本金）。
// Render smoke test for the capital-floor block: the board variant shows the rule and
// examples with amounts derived from the floor (100 → 90 / lose 10); the competition
// variant doesn't (competitions use a fixed signup-capital denominator).
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import CashflowRules from './CashflowRules'
import { makeI18n } from './admin/activity/testT'

const render = (lang: 'zh' | 'en', variant: 'board' | 'competition', usd = 100) =>
  renderToStaticMarkup(
    <I18nextProvider i18n={makeI18n(lang)}>
      <CashflowRules minBaselineUsd={usd} variant={variant} />
    </I18nextProvider>,
  )

describe('CashflowRules capital floor', () => {
  it('board variant explains the per-trade floor with derived amounts', () => {
    const html = render('zh', 'board')
    expect(html).toContain('每笔单子交易时本金 ≥ 100 USD 才计入收益榜')
    expect(html).toContain('周一本金 90，做了 10 笔')
    expect(html).toContain('本金 100，亏了 10，余额剩 90')
    expect(html).toContain('月榜也一样')
    expect(html).not.toContain('{{')
  })

  it('follows the configured floor', () => {
    const html = render('en', 'board', 500)
    expect(html).toContain('at least 500 USD')
    expect(html).toContain('Monday, capital 450: 10 trades')
    expect(html).not.toContain('{{')
  })

  it('competition variant has no floor examples', () => {
    expect(render('zh', 'competition')).not.toContain('月榜也一样')
  })
})
