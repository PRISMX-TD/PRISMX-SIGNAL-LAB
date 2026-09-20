// 出入金计分说明（排行榜 / 比赛详情共用，默认收起）。
//
// 两个榜的口径是同一份代码（backend gamification/boards.py 的 return_score，
// 比赛走 competitions.py:137 复用它），所以说明也只能有一份——分成两段各写各的，
// 迟早会漂成两套说法。
//
// 为什么要有这块：收益率的分母不是"期初余额"而是**每笔仓位各自的当时本金**
// （取开仓、平仓两个时刻里钱多的那个）。这条规则从榜规芯片那一行文案里读不出来，
// 而它恰好是用户最容易误解、也最容易怀疑平台不公的地方（"我提了款是不是就白干
// 了"）。四个例子比任何抽象表述都省事。
//
// 默认收起：绝大多数用户不出入金，对他们这块是噪音；展开的成本是一次点击。
// 用原生 <details> 而不是 useState，理由同 BindPage 的桥接折叠块——键盘可达性和
// "点标题展开"的语义浏览器已经给全了。
//
// Deposit / withdrawal scoring explainer, shared by the leaderboard and the
// competition detail page, collapsed by default.
//
// Both boards score through one implementation (return_score in the backend's
// gamification/boards.py, reused by competitions.py), so the copy is shared too:
// two separately-worded copies would drift apart.
//
// Why it exists: the denominator is not "balance at period start" but each
// position's own capital-at-time (the larger of its open and close moments).
// That rule is not readable from the one-line gate chip, and it is exactly where
// users suspect unfairness ("does withdrawing wipe out what I earned?"). Four
// worked examples beat any abstract phrasing.
//
// Native <details> rather than useState, same reasoning as BindPage's bridge
// disclosure: the browser already gives the keyboard affordance and the
// click-the-heading-to-expand semantics.
import { useTranslation } from 'react-i18next'
import { fmtUsd } from '../api/utils'

const CASES = [1, 2, 3, 4] as const

export default function CashflowRules({
  minBaselineUsd,
  variant,
}: {
  minBaselineUsd: number
  // variant 管两件事：
  //  ① 封存那一条的说法——周期榜是"周期结束即封存"，比赛是"以终审结果为准"；
  //  ② 外观档位。排行榜上下都是卡片，这里也做成卡片才不突兀；比赛详情的右栏是
  //     发丝线 + 11.5px 灰字的规则清单，一张实色卡加 32px 圆钮压在它下面像掉进去
  //     的另一个组件，所以那边降成"规则清单的第四条可展开项"：无面、无边框，
  //     只有一条上边线和一个小箭头，字号也跟着那份清单走。
  // variant drives two things: the wording of the sealing note (a period seals
  // itself, a competition settles), and the visual register. The leaderboard is
  // surrounded by cards, so a card belongs there; the competition detail's right
  // column is a hairline list of 11.5px muted rules, where a filled card with a
  // 32px round button reads as a foreign object — there it degrades to a fourth,
  // expandable item of that same list.
  variant: 'board' | 'competition'
}) {
  const { t } = useTranslation()
  const plain = variant === 'competition'

  return (
    <details className={plain ? 'cf-rules is-plain' : 'card glass cf-rules'}>
      <summary>
        <span className="min-w-0">
          <span className="t">{t('cashflowRules.title')}</span>
          <span className="h">{t('cashflowRules.hint')}</span>
        </span>
        <span className="chev" aria-hidden="true">
          <svg width={plain ? 14 : 16} height={plain ? 14 : 16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </span>
      </summary>

      <div className="cf-body">
        <p className="cf-lead">{t('cashflowRules.lead')}</p>
        <p className="cf-formula">{t('cashflowRules.formula')}</p>

        <ol className="cf-cases">
          {CASES.map((n) => (
            <li key={n}>
              <span className="cf-case-head">
                <span className="cf-case-t">{t(`cashflowRules.case${n}.t`)}</span>
                {/* 结果百分比用等宽数字：四行的百分号要对齐才看得出这是同一把尺。
                    Tabular figures so the four percentages align into one scale. */}
                <span className="cf-case-r num">{t(`cashflowRules.case${n}.r`)}</span>
              </span>
              <span className="cf-case-s">{t(`cashflowRules.case${n}.s`)}</span>
              <span className="cf-case-w">{t(`cashflowRules.case${n}.w`)}</span>
            </li>
          ))}
        </ol>

        <ul className="cf-notes">
          <li>{t('cashflowRules.noteSmall')}</li>
          <li>{t('cashflowRules.noteFloor', { usd: fmtUsd(minBaselineUsd) })}</li>
          <li>{t('cashflowRules.noteWinRate')}</li>
          <li>{t(variant === 'competition' ? 'cashflowRules.noteSealedComp' : 'cashflowRules.noteSealedBoard')}</li>
          <li>{t('cashflowRules.noteNoFlow')}</li>
        </ul>
      </div>
    </details>
  )
}
