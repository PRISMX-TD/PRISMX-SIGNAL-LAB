// 交易人格分享卡（360×450，与其它分享卡同尺寸、同一条导出路径）。只放人格本身：插画、代号、称号、
// 一句点评、四个主轴的小条、昵称和扫码加入——不放金额、不放胜率（分享出去的是「我是哪种交易者」）。
// 插画要先转成 data URL：卡片放进 SVG foreignObject 导出时取不到外部图片。
//
// The persona share card (360x450, same size and export path as the other cards). Persona only:
// art, code, title, one roast line, four mini axis bars, nickname and the scan-to-join CTA — no
// money, no win rate. The art is inlined as a data URL because the foreignObject export can't
// fetch external images.
import type { TFunction } from 'i18next'
import type { Persona } from '../../api/personaTypes'
import { esc } from '../share/cardData'
import { AXES, FAMILY_COLOR, artUrl, familyOf, type ArtStyle } from './personaMeta'

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
.sl-card.pc{position:relative;width:360px;height:450px;overflow:hidden;border-radius:22px;color:#F4F2ED;
  font-family:Archivo,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans SC","Noto Sans Thai","Noto Sans JP",system-ui,sans-serif}
.pc-bg{position:absolute;inset:0}
.pc-brand{position:absolute;left:20px;top:18px;display:flex;align-items:center;gap:8px}
.pc-brand img{width:22px;height:22px;border-radius:6px;display:block}
.pc-brand b{font-size:12px;font-weight:700;letter-spacing:.02em}
.pc-brand i{font-style:normal;font-size:9px;letter-spacing:.18em;opacity:.6;display:block;margin-top:1px}
.pc-fam{position:absolute;right:20px;top:22px;font-size:11px;font-weight:700;letter-spacing:.04em;padding:3px 9px;border-radius:999px}
.pc-art{position:absolute;left:50%;top:54px;width:174px;height:200px;transform:translateX(-50%)}
.pc-art img{width:100%;height:100%;object-fit:contain;display:block;border-radius:12px}
.pc-demo{position:absolute;left:50%;top:232px;transform:translateX(-50%);font-size:10.5px;font-weight:700;padding:3px 10px;border-radius:999px;
  background:rgba(11,12,16,.82);border:1px solid rgba(255,255,255,.28);white-space:nowrap}
.pc-code{position:absolute;left:0;right:0;top:256px;text-align:center;font-size:12px;font-weight:800;letter-spacing:.32em;opacity:.75}
.pc-title{position:absolute;left:0;right:0;top:272px;text-align:center;font-size:28px;font-weight:800;letter-spacing:.02em}
.pc-say{position:absolute;left:30px;right:30px;top:314px;text-align:center;font-size:12px;line-height:1.55;opacity:.86;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.pc-axes{position:absolute;left:24px;right:24px;top:356px;display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
.pc-ax{font-size:9.5px;opacity:.9}
.pc-ax span{display:block;margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pc-ax i{display:block;height:4px;border-radius:2px;background:rgba(255,255,255,.14);position:relative;overflow:hidden}
.pc-ax i u{position:absolute;top:0;bottom:0;border-radius:2px}
.pc-foot{position:absolute;left:20px;right:20px;bottom:16px;display:flex;align-items:center;gap:10px}
.pc-qr{width:44px;height:44px;padding:3px;border-radius:6px;background:#F4F2ED;flex:none}
.pc-qr svg{display:block;width:38px;height:38px}
.pc-who{flex:1;min-width:0}
.pc-who b{display:block;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pc-who span{display:block;font-size:10px;opacity:.65;margin-top:2px}
`

export interface PersonaCardText {
  family: string
  title: string
  say: string
  axisWords: string[]   // 四个主轴当前字母对应的词 / the word for each axis' current letter
  cta: string
  label: string         // 「我的交易人格」/ "My trading persona"
}

// tag：卡片上多一条标记（模拟盘预览的人格必须标明，免得被当成实盘人格）。
// tag: an extra mark on the card (a demo-preview persona must say so).
export async function buildPersonaCard(t: TFunction, persona: Persona, style: ArtStyle, tag?: string) {
  const [{ px, SHARE_LINK }, art] = await Promise.all([
    import('../share/cardEnv'),
    toDataUrl(artUrl(persona.code, style)),
  ])
  const fam = familyOf(persona.code)
  const c = FAMILY_COLOR[fam]
  const text: PersonaCardText = {
    family: t(`persona.family.${fam}`),
    title: t(`persona.types.${persona.code}.title`),
    say: t(`persona.types.${persona.code}.say`),
    axisWords: AXES.map((a) => t(`persona.pole.${persona.axes[a.key]?.letter ?? a.poles[0]}`)),
    cta: t('share.card.ctaJoin'),
    label: t('persona.share.label'),
  }
  const qr = px.qr(SHARE_LINK, 38, '#0E1016', '#F4F2ED')
  return (nickname: string) => {
    const bars = AXES.map((a, i) => {
      const v = Math.max(0, Math.min(100, persona.axes[a.key]?.value ?? 50))
      // 从中线往字母那一侧画：≥50 向右，<50 向左。/ Fill from the centre toward the letter's side.
      const left = v >= 50 ? 50 : v
      const width = Math.abs(v - 50)
      return `<div class="pc-ax"><span>${esc(text.axisWords[i])}</span><i><u style="left:${left}%;width:${Math.max(width, 3)}%;background:${c.main}"></u></i></div>`
    }).join('')
    const html =
      `<article class="sl-card pc"><div class="pc-bg" style="background:radial-gradient(120% 80% at 50% 28%, ${c.dark} 0%, ${c.deep} 55%, #0B0C10 100%)"></div>` +
      `<div class="pc-brand"><img src="/logo-256.png" alt=""><div><b>信号实验室</b><i>SIGNAL LAB</i></div></div>` +
      `<div class="pc-fam" style="background:${c.main}26;color:${c.main}">${esc(text.family)}</div>` +
      `<div class="pc-art"><img src="${art}" alt=""></div>` +
      (tag ? `<div class="pc-demo">${esc(tag)}</div>` : '') +
      `<div class="pc-code">${esc(persona.code)}</div>` +
      `<div class="pc-title">${esc(text.title)}</div>` +
      `<div class="pc-say">${esc(text.say)}</div>` +
      `<div class="pc-axes">${bars}</div>` +
      `<div class="pc-foot"><div class="pc-qr">${qr}</div><div class="pc-who"><b>${esc(nickname || text.label)}</b><span>${esc(text.cta)}</span></div></div>` +
      `</article>`
    return { css: CSS, html }
  }
}
