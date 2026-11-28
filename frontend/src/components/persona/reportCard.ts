// 月报 / 年度报告分享卡（2026-11-28）。和人格卡同尺寸（360×450）、同一条导出路径、同一套深色底。
// 放：综合评分（大字）、净盈亏、胜率、盈亏比、笔数、盈利日、当月人格（小插画 + 称号）、最多三个徽章、
// 昵称和扫码加入。金额可以隐藏（分享弹窗里的「隐藏金额」），隐藏后净盈亏那一格显示圆点。
// 插画先转成 data URL：卡片放进 SVG foreignObject 导出时取不到外部图片。
//
// Share card for the monthly and the annual report: same size, export path and dark base as the persona
// card. Score (large), net P&L, win rate, payoff, trades, green days, the persona (thumbnail + title),
// up to three badges, nickname and the scan-to-join CTA. Money can be hidden from the share sheet.
import type { TFunction } from 'i18next'
import type { PersonaBadge, PersonaSummary } from '../../api/personaTypes'
import { esc } from '../share/cardData'
import { money, num, pct } from './fmt'
import { FAMILY_COLOR, artUrl, familyOf, type ArtStyle } from './personaMeta'

async function toDataUrl(url: string): Promise<string> {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`${url} ${r.status}`)
  const b = await r.blob()
  return await new Promise<string>((res, rej) => {
    const fr = new FileReader()
    fr.onload = () => res(String(fr.result))
    fr.onerror = () => rej(fr.error)
    fr.readAsDataURL(b)
  })
}

const CSS = `
.sl-card.rc{position:relative;width:360px;height:450px;overflow:hidden;border-radius:22px;color:#F4F2ED;
  font-family:Archivo,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans SC","Noto Sans Thai","Noto Sans JP",system-ui,sans-serif}
.rc-bg{position:absolute;inset:0}
.rc-brand{position:absolute;left:20px;top:18px;display:flex;align-items:center;gap:8px}
.rc-brand img{width:22px;height:22px;border-radius:6px;display:block}
.rc-brand b{font-size:12px;font-weight:700;letter-spacing:.02em}
.rc-brand i{font-style:normal;font-size:9px;letter-spacing:.18em;opacity:.6;display:block;margin-top:1px}
.rc-when{position:absolute;right:20px;top:22px;font-size:11px;font-weight:700;padding:3px 9px;border-radius:999px}
.rc-kind{position:absolute;left:24px;right:24px;top:58px;font-size:12px;opacity:.7}
.rc-score{position:absolute;left:24px;top:76px;display:flex;align-items:baseline;gap:8px}
.rc-score b{font-size:66px;line-height:1;font-weight:800;letter-spacing:-.03em}
.rc-score span{font-size:13px;opacity:.65}
.rc-grid{position:absolute;left:24px;right:24px;top:156px;display:grid;grid-template-columns:repeat(3,1fr);gap:1px;
  background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.1);border-radius:12px;overflow:hidden}
.rc-grid div{padding:10px 10px 9px;background:rgba(14,16,22,.82);min-width:0}
.rc-grid span{display:block;font-size:9.5px;opacity:.62;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rc-grid b{display:block;margin-top:4px;font-size:15px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rc-up{color:#3DD68C}.rc-down{color:#F2686C}
.rc-persona{position:absolute;left:24px;right:24px;top:290px;display:flex;align-items:center;gap:12px}
.rc-persona img{width:46px;height:53px;object-fit:contain;border-radius:8px;display:block;flex:none}
.rc-persona b{display:block;font-size:16px;font-weight:800}
.rc-persona span{display:block;margin-top:2px;font-size:10.5px;letter-spacing:.22em;opacity:.65}
.rc-badges{position:absolute;left:24px;right:24px;top:352px;display:flex;gap:6px;overflow:hidden;white-space:nowrap}
.rc-badges i{font-style:normal;font-size:10.5px;padding:3px 9px;border-radius:999px;background:rgba(255,255,255,.09)}
.rc-foot{position:absolute;left:20px;right:20px;bottom:16px;display:flex;align-items:center;gap:10px}
.rc-qr{width:44px;height:44px;padding:3px;border-radius:6px;background:#F4F2ED;flex:none}
.rc-qr svg{display:block;width:38px;height:38px}
.rc-who{flex:1;min-width:0}
.rc-who b{display:block;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rc-who span{display:block;font-size:10px;opacity:.65;margin-top:2px}
`

export interface ReportCardInput {
  /** 右上角的时间：「2026年11月」或「2026」/ the period shown top right */
  when: string
  /** 标题一行：「交易报告」或「年度交易报告」/ the kind line */
  kind: string
  summary: PersonaSummary
  code: string | null
  badges: PersonaBadge[]
  style: ArtStyle
}

/** 返回 (昵称, 版式) → 卡片；版式 'hide' 时不显示金额。
 *  Returns (nickname, variant) → card; variant 'hide' leaves the money out. */
export async function buildReportCard(t: TFunction, input: ReportCardInput) {
  const [{ px, SHARE_LINK }, art] = await Promise.all([
    import('../share/cardEnv'),
    input.code ? toDataUrl(artUrl(input.code, input.style)).catch(() => null) : Promise.resolve(null),
  ])
  const c = FAMILY_COLOR[input.code ? familyOf(input.code) : 'strategist']
  const s = input.summary
  const qr = px.qr(SHARE_LINK, 38, '#0E1016', '#F4F2ED')
  const L = (k: string, o?: Record<string, unknown>) => String(t(k, o))
  const cells = (hide: boolean): [string, string, string][] => [
    [L('persona.report.stat.profit'), hide ? '•••' : money(s.profit), hide ? '' : s.profit > 0 ? 'rc-up' : s.profit < 0 ? 'rc-down' : ''],
    [L('persona.report.stat.winRate'), pct(s.winRate), ''],
    [L('persona.report.stat.payoff'), num(s.payoff, 2), ''],
    [L('persona.report.stat.trades'), String(s.trades), ''],
    [L('persona.report.stat.days'), L('persona.report.daysValue', { g: s.greenDays, n: s.tradingDays }), ''],
    [L('persona.report.stat.drawdown'), hide ? '•••' : money(-s.maxDrawdown, false), ''],
  ]
  const badges = input.badges.slice(0, 3).map((b) => `<i>${esc(L(`persona.badges.${b}.name`))}</i>`).join('')
  const persona = input.code
    ? `<div class="rc-persona">${art ? `<img src="${art}" alt="">` : ''}<div><b>${esc(L(`persona.types.${input.code}.title`))}</b><span>${esc(input.code)}</span></div></div>`
    : ''
  return (nickname: string, variant?: string) => {
    const hide = variant === 'hide'
    const grid = cells(hide).map(([k, v, cls]) => `<div><span>${esc(k)}</span><b class="${cls}">${esc(v)}</b></div>`).join('')
    const html =
      `<article class="sl-card rc"><div class="rc-bg" style="background:radial-gradient(130% 70% at 20% 12%, ${c.dark} 0%, ${c.deep} 48%, #0B0C10 100%)"></div>` +
      `<div class="rc-brand"><img src="/logo-256.png" alt=""><div><b>信号实验室</b><i>SIGNAL LAB</i></div></div>` +
      `<div class="rc-when" style="background:${c.main}26;color:${c.main}">${esc(input.when)}</div>` +
      `<div class="rc-kind">${esc(input.kind)}</div>` +
      `<div class="rc-score"><b>${s.score ?? '—'}</b><span>/ 100 · ${esc(L('persona.report.stat.score'))}</span></div>` +
      `<div class="rc-grid">${grid}</div>` +
      persona +
      (badges ? `<div class="rc-badges">${badges}</div>` : '') +
      `<div class="rc-foot"><div class="rc-qr">${qr}</div><div class="rc-who"><b>${esc(nickname || L('persona.card.mine'))}</b><span>${esc(L('share.card.ctaJoin'))}</span></div></div>` +
      `</article>`
    return { css: CSS, html }
  }
}
