// 「收益率怎么算」的渲染冒烟：周期榜一档先讲本金门槛（只认入金、不够门槛的单不计入、之前
// 没计入的盈利并进分母），例子里的金额跟着门槛走（100 → 90 / 10 / 11 / 20）；比赛一档不显示
// （比赛分母固定为报名本金）。
// Render smoke test for the explainer: the board variant leads with the capital floor
// (deposits only, sub-floor trades skipped, skipped profit joins the denominator) with
// amounts derived from the floor; the competition variant doesn't show it.
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
  it('board variant explains the floor with derived amounts', () => {
    const html = render('zh', 'board')
    expect(html).toContain('本金门槛 100 USD')
    expect(html).toContain('本金 90，做单赚到余额 100')
    expect(html).toContain('再入金 10，本金 100，之后一笔赚 11')
    expect(html).toContain('11 ÷ (100 + 10)')
    expect(html).toContain('入金到 100 后平仓，赚 20')
    expect(html).toContain('上周开仓，本周平仓')
    expect(html).not.toContain('{{')
  })

  it('follows the configured floor', () => {
    const html = render('en', 'board', 500)
    expect(html).toContain('Capital floor: 500 USD')
    expect(html).toContain('Deposit 50 more (capital 500), then one trade earns 55')
    expect(html).toContain('close +100')
    expect(html).not.toContain('{{')
  })

  it('competition variant has no floor examples', () => {
    expect(render('zh', 'competition')).not.toContain('本金门槛')
  })
})
