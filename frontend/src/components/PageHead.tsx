// 全站统一页头 / the one page head used by every logged-in page.
//
// 2026-09-08 之前每一页各写一套：订单页是「等宽大写眉题 + 42px 标题 + 光谱线」，
// 成长页 26px 标题配页签，账户页只有一行 13px 灰字，绑定 / 策略 / 客服又是另外
// 三种 26px 变体。同一个产品的同一层级有六种写法，读起来像六个产品。
//
// 现在只有这一套（就是信号板先用起来的那套）：
//   标题 26px 展示字宽白字 ｜ 可选的紫色等宽计数 + 单位 ｜ 可选的小标签
//   副题 13px 说明灰，最长 64ch
//   右侧 actions 槽：筛选器 / 页签 / 主按钮 / 账号切换，底边对齐，窄屏折到下一行
//   可选的返回链接（详情页用）
// 样式在 styles/page-head.css。
//
// Before 2026-09-08 every page rolled its own head: the orders page had a
// mono-caps eyebrow, a 42px title and the spectral rule; growth used 26px with
// tabs; account had a single 13px grey line; bind / strategies / support were
// three more 26px variants. One product, one level of hierarchy, six voices.
// Now there is one recipe (the one the signal board adopted first): a 26px
// display-width title, an optional violet tabular count with unit, an optional
// small badge, a 13px subtitle capped at 64ch, a right-hand actions slot
// (filters / tabs / primary button / account switcher) aligned to the baseline
// and wrapping below on narrow screens, and an optional back link for detail
// pages. Styled by styles/page-head.css.
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'

interface Props {
  title: ReactNode
  subtitle?: ReactNode
  // 计数：与标题同高的紫色等宽数字，是页头里唯一的彩度。null / undefined 不渲染。
  // Count: a violet tabular numeral at title height, the head's only chroma.
  count?: number | null
  countUnit?: string
  // 标题后的小标签（如「管理员专用」）。/ A small tag after the title.
  badge?: ReactNode
  // 右侧槽。/ The right-hand slot.
  actions?: ReactNode
  back?: { to: string; label: string }
  // 语义层级：独立页面用 h1，页签内的看板用 h2（默认）。
  // Semantic level: h1 for a standalone page, h2 (default) for a board inside tabs.
  as?: 'h1' | 'h2'
  className?: string
}

export default function PageHead({ title, subtitle, count, countUnit, badge, actions, back, as = 'h2', className = '' }: Props) {
  const Tag = as
  return (
    <div className={`page-head${className ? ` ${className}` : ''}`}>
      <div className="page-head-title">
        {back && (
          <Link to={back.to} className="page-head-back">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
            {back.label}
          </Link>
        )}
        <Tag className="font-display">
          <span className="page-head-name">{title}</span>
          {count != null && (
            <span className="page-head-count">
              <b className="num">{count}</b>
              {countUnit && <span>{countUnit}</span>}
            </span>
          )}
          {badge}
        </Tag>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {actions && <div className="page-head-actions">{actions}</div>}
    </div>
  )
}
