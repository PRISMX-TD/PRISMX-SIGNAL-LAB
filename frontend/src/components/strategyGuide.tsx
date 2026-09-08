// 平台策略介绍的共享渲染件：列表牌面与详情页都用这里的取值与块渲染逻辑。
// Shared rendering pieces for platform strategy write-ups, used by both the list
// cards and the detail page.
import type { CSSProperties } from 'react'
import type { PlatformStrategy, PlatformStrategyBlock } from '../api/types'
import { safeHttpUrl } from '../utils/safeUrl'
import { symbolMeta } from '../utils/symbolMeta'
import { displaySymbol } from '../api/utils'

// 按当前界面语言取字段，缺失时回落到另一种语言——管理员可能只填了一种，
// 空白比串语言更糟。/ Pick the field for the current UI language, falling back to
// the other one: an admin may have filled in only one, and a blank reads worse
// than the wrong language.
export function pick(zh: string, en: string, isZh: boolean): string {
  const primary = isZh ? zh : en
  const fallback = isZh ? en : zh
  return (primary || '').trim() || (fallback || '').trim()
}

// ── 风险回报比 / risk:reward ──
// 管理员填的是自由文本（「1 : 2」「1:1.5」「1：2」）。能解析出两个数就按信号牌
// 同一种写法显示「1:2.00」，并画出同一条风险｜回报尺——这是策略的**设计参数**
// （下单时止损:止盈之比），不是业绩，所以画它不违背「介绍页不放业绩数字」的
// 决定。解析不出就原样显示文字，不画尺。
// Admins type free text ("1 : 2", "1:1.5", full-width colon). When two numbers
// parse out, render it the way the signal card does ("1:2.00") and draw the same
// risk|reward rule. It is a *design parameter* (the SL:TP ratio at order time),
// not performance, so drawing it keeps the "no performance figures here" rule.
// Otherwise show the raw text with no rule.
export interface RiskReward { label: string; riskFrac: number }
export function parseRiskReward(raw: string): RiskReward | null {
  const m = /(\d+(?:\.\d+)?)\s*[:：]\s*(\d+(?:\.\d+)?)/.exec(raw || '')
  if (!m) return null
  const risk = Number(m[1])
  const reward = Number(m[2])
  if (!(risk > 0) || !(reward > 0)) return null
  const ratio = reward / risk
  return {
    label: `1:${ratio.toFixed(2)}`,
    riskFrac: Math.min(0.92, Math.max(0.08, risk / (risk + reward))),
  }
}

/** 风险回报比读数：等宽数字 + 风险｜回报尺（复用信号牌的 .sig-ladder-bar）。
 *  The R:R figure: tabular numeral over the risk|reward rule (reusing the signal
 *  card's .sig-ladder-bar). */
export function RiskRewardFigure({ raw, caption }: { raw: string; caption: string }) {
  const rr = parseRiskReward(raw)
  if (!rr && !raw) return null
  return (
    <div className="guide-spec rr">
      <span className="cap">{caption}</span>
      <b className={rr ? 'num' : ''}>{rr ? rr.label : raw}</b>
      {rr && (
        <div className="sig-ladder-bar" style={{ '--risk': `${(rr.riskFrac * 100).toFixed(1)}%` } as CSSProperties} aria-hidden="true">
          <i className="risk" />
          <i className="reward" />
          <i className="mark" />
        </div>
      )}
    </div>
  )
}

/** 单项设计参数：说明性小字 + 值。/ One design fact: caption over value. */
export function SpecFact({ caption, value }: { caption: string; value: string }) {
  if (!value) return null
  return (
    <div className="guide-spec">
      <span className="cap">{caption}</span>
      <b>{value}</b>
    </div>
  )
}

/** 品种：沿用全站的三字母身份芯片（symbolMeta），与信号牌、持仓卡同一套；
 *  展示名放进 title / aria-label。
 *  Symbols as the site-wide three-letter identity chips (symbolMeta), the same
 *  ones on signal cards and positions; the display name goes into title/aria. */
export function SymbolChips({ symbols }: { symbols: string[] }) {
  if (!symbols || symbols.length === 0) return null
  return (
    <div className="guide-syms" role="list">
      {symbols.map((sym) => {
        const meta = symbolMeta(sym)
        const name = displaySymbol(sym)
        return (
          <span
            key={sym}
            role="listitem"
            className="sym-ava"
            title={name}
            aria-label={name}
            style={{ background: meta.color + '33', color: meta.ink }}
          >
            {meta.letter}
          </span>
        )
      })}
    </div>
  )
}

/** 周期：一条分段轨道，与仪表盘多周期趋势的 .tf-row 同形（这里没有方向箭头）。
 *  Timeframes as one segmented track, shaped like the dashboard's .tf-row but
 *  without direction arrows. */
export function TimeframeTrack({ timeframes }: { timeframes: string[] }) {
  if (!timeframes || timeframes.length === 0) return null
  return (
    <div className="guide-tfs" role="list">
      {timeframes.map((tf) => (
        <span key={tf} role="listitem" className="guide-tf num">{tf}</span>
      ))}
    </div>
  )
}

/** 指标：文字列表，项与项之间用发丝线分隔而不是圆点。
 *  Indicators as text, separated by hairlines rather than dots. */
export function IndicatorList({ indicators }: { indicators: string[] }) {
  if (!indicators || indicators.length === 0) return null
  return (
    <div className="guide-inds" role="list">
      {indicators.map((v) => (
        <span key={v} role="listitem">{v}</span>
      ))}
    </div>
  )
}

// 内容块渲染。全部走纯文本节点，不解析 HTML 或 Markdown——管理员输入不应该能
// 变成可执行标记。列表块按换行切分成条目。
// Renders the content blocks. Everything goes through plain text nodes; no HTML
// or Markdown is parsed, so admin input can never become executable markup. List
// blocks split on newlines.
export function StrategyBlocks({ blocks, isZh }: { blocks: PlatformStrategyBlock[]; isZh: boolean }) {
  return (
    <>
      {blocks.map((b, i) => {
        const text = pick(b.textZh, b.textEn, isZh)
        // 图片块允许没有图注，其余类型没文字就等于空块，跳过不占版面
        // Image blocks may have no caption; other kinds with no text are empty
        // blocks and are skipped rather than leaving a gap
        if (!text && !(b.kind === 'image' && b.imageUrl)) return null

        if (b.kind === 'heading') {
          return (
            <h2 key={i} className="guide-h font-display">
              {text}
            </h2>
          )
        }

        if (b.kind === 'list') {
          const rows = text
            .split('\n')
            .map((r) => r.trim())
            .filter(Boolean)
          return (
            <ul key={i} className="guide-ul">
              {rows.map((r, j) => (
                <li key={j}>{r}</li>
              ))}
            </ul>
          )
        }

        if (b.kind === 'image') {
          return (
            <figure key={i} className="guide-fig">
              {safeHttpUrl(b.imageUrl) && (
                <img
                  src={safeHttpUrl(b.imageUrl)}
                  alt={text}
                  loading="lazy"
                />
              )}
              {text && <figcaption>{text}</figcaption>}
            </figure>
          )
        }

        return (
          <p key={i} className="guide-p">
            {text}
          </p>
        )
      })}
    </>
  )
}

// 详细说明的渲染入口。blocks 为空时回落到第一版的单段纯文本字段，避免早先录入的
// 内容在升级后凭空消失。/ Entry point for the long description. Falls back to the
// first version's single-blob fields when blocks is empty, so copy entered before
// the upgrade doesn't silently vanish.
export function StrategyDetail({ strategy, isZh }: { strategy: PlatformStrategy; isZh: boolean }) {
  const blocks = strategy.blocks ?? []
  if (blocks.length > 0) return <StrategyBlocks blocks={blocks} isZh={isZh} />

  const legacy = pick(strategy.detailZh, strategy.detailEn, isZh)
  if (!legacy) return null
  return (
    <p className="guide-p guide-legacy">{legacy}</p>
  )
}
