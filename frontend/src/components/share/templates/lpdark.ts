// @ts-nocheck
/* 分享卡模板「lpdark」：由设计稿 v4-lpdark/cards.js 移植，模板本身是纯字符串渲染。
   数据、文案（D().L）、勋章与二维码都由 env 注入，见 ../cardEnv.ts。
   Share-card template ported verbatim from the design mockup; data, copy, medal and QR come from env. */
import type { CardEnv, CardTemplate } from '../cardEnv'

export default function create(env: CardEnv): CardTemplate {
  // 设计稿通过 window.SLDATA / window.PX 取数据并注册到 window.SL；这里用同名局部变量接住，模板源码不用改。
  const window = { get SLDATA() { return env.data }, PX: env.px, SL: {} };
/* 信号实验室分享卡 v4 · 凸版 Letterpress（深色）
   乌木黑棉纸：大形状无色压凹（上沿一道深影、下沿一道纸面反光），关键处烫紫箔或冷银箔；亏损改用深墨玫瑰色，不烫箔。 */
(function () {
  const W = 360, H = 450
  const CJK = "'PingFang SC','Noto Sans SC','Microsoft YaHei',sans-serif"
  const D = () => window.SLDATA

  /* 纸张：默认乌木黑棉纸（极轻的暖调，和信号卡的纯黑玻璃区分开）；勋章卡按材质换纸色 */
  const VIOLET = ['#6440E6', '#8C6EFF', '#E6DFFF', '#A992FF', '#6A48EC']
  const SILVER = ['#5E6270', '#A4A9B6', '#F4F5F9', '#B4B9C5', '#5A5E6B']
  const PAPER = {
    base: { top: '#18171A', bot: '#0D0C0F', face: '#09080B', dark: 'rgba(0,0,0,.85)', lite: 'rgba(255,255,255,.11)',
      ink: '#EDEBF2', sub: '#A19EAB', foil: VIOLET, cta: '#A68FFF', glow: 'rgba(120,90,255,.10)' },
  }
  /* 亏损：深墨玫瑰，哑光，只有一点上下明暗 */
  const LOSSINK = ['#F07A8E', '#C9506A']
  const ROSE = '#F07A8E'

  const css = `
.sl-lpdark{position:relative;width:${W}px;height:${H}px;overflow:hidden;border-radius:18px;box-sizing:border-box;
  background:#0F0E11;color:#EDEBF2;font-family:'Archivo',${CJK};font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased;
  box-shadow:inset 0 1px 0 rgba(255,255,255,.07),inset 0 -1px 0 rgba(0,0,0,.5)}
.sl-lpdark *{box-sizing:border-box;margin:0;padding:0}
.sl-lpdark .lp-bg{position:absolute;left:0;top:0;display:block}
.sl-lpdark .lp-a{position:absolute;line-height:1}
.sl-lpdark .lp-c{position:absolute;left:0;right:0;text-align:center;line-height:1}
.sl-lpdark .lp-logo{position:relative;display:block;width:24px;height:28px;overflow:hidden;flex:none}
.sl-lpdark .lp-logo img{position:absolute;width:44px;height:44px;left:-10px;top:-3px;max-width:none;display:block}
.sl-lpdark .lp-brand{position:absolute;left:0;right:0;top:28px;display:flex;justify-content:center;align-items:center}
.sl-lpdark .lp-wm{margin-left:9px;display:flex;flex-direction:column;line-height:1}
.sl-lpdark .lp-wm b{font-family:${CJK};font-size:13px;font-weight:700;letter-spacing:.12em}
.sl-lpdark .lp-wm i{font-style:normal;font-family:'Archivo',sans-serif;font-size:8px;font-weight:600;letter-spacing:.34em;margin-top:4px}
.sl-lpdark .lp-line{font-family:'Archivo',${CJK};font-size:13px;font-weight:600;letter-spacing:.16em}
.sl-lpdark .lp-facts{font-family:'Archivo',${CJK};font-size:12px;letter-spacing:.06em}
.sl-lpdark .lp-facts b{font-weight:700}
.sl-lpdark .lp-facts s{text-decoration:none;display:inline-block;width:3px;height:3px;border-radius:50%;vertical-align:middle;margin:0 12px 2px;opacity:.55;background:currentColor}
.sl-lpdark .lp-foot{position:absolute;left:0;right:0;top:360px;height:62px;display:flex;justify-content:center;align-items:center}
.sl-lpdark .lp-qr{width:62px;height:62px;padding:4px;border-radius:5px;background:#EEEDF2;flex:none;
  box-shadow:0 1px 0 rgba(255,255,255,.10),0 2px 6px rgba(0,0,0,.55)}
.sl-lpdark .lp-qr svg{display:block}
.sl-lpdark .lp-who{margin-left:14px;display:flex;flex-direction:column;line-height:1;text-align:left}
.sl-lpdark .lp-who b{font-size:13px;font-weight:700;letter-spacing:.04em}
.sl-lpdark .lp-who span{font-family:${CJK};font-size:12px;margin-top:8px}
.sl-lpdark .lp-who span em{font-family:'Archivo',sans-serif;font-style:normal;font-weight:700;letter-spacing:.1em;margin-left:4px}
.sl-lpdark .lp-who u{text-decoration:none;font-family:${CJK};font-size:12px;font-weight:700;letter-spacing:.12em;margin-top:8px}
`

  const f1 = (v) => Math.round(v * 10) / 10
  const esc = (s) => String(s)

  /* 箔：斜向金属渐变，objectBoundingBox 跟随文字外框。
     两道反光（一宽一窄）夹着中间调，像箔面被压平后不完全平整的反光，而不是一条单调的过渡 */
  function foilDef(id, c, u) {
    return `<linearGradient id="${id}" ${u || 'x1="0" y1="0" x2="1" y2=".7"'}>` +
      `<stop offset="0" stop-color="${c[1]}"/><stop offset=".2" stop-color="${c[3]}"/><stop offset=".36" stop-color="${c[1]}"/>` +
      `<stop offset=".54" stop-color="${c[2]}"/><stop offset=".66" stop-color="${c[3]}"/><stop offset=".86" stop-color="${c[1]}"/><stop offset="1" stop-color="${c[4]}"/></linearGradient>`
  }
  function inkDef(id, c) {
    return `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c[0]}"/><stop offset="1" stop-color="${c[1]}"/></linearGradient>`
  }
  /* 纸纹：一层分形噪声映射成以纸色为中心的灰，既有略亮的棉絮也有略暗的凹点，
     横向频率略高，像长纤维；整体是柔和的云絮感而不是撒白点 */
  function paper(k, P) {
    return `<filter id="${k}-n" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB"><feTurbulence type="fractalNoise" baseFrequency=".9 .34" numOctaves="2" seed="7" stitchTiles="stitch"/>` +
      `<feColorMatrix values=".8 0 0 0 -.36  .8 0 0 0 -.362  .84 0 0 0 -.37  0 0 0 0 1"/></filter>` +
      `<linearGradient id="${k}-p" x1="0" y1="0" x2=".35" y2="1"><stop offset="0" stop-color="${P.top}"/><stop offset="1" stop-color="${P.bot}"/></linearGradient>` +
      `<radialGradient id="${k}-l" cx=".2" cy="-.08" r=".95"><stop offset="0" stop-color="#fff" stop-opacity="${P.sheen != null ? P.sheen : .035}"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>`
  }
  const paperRects = (k, P) => `<rect width="${W}" height="${H}" fill="url(#${k}-p)"/><rect width="${W}" height="${H}" fill="url(#${k}-l)"/><rect width="${W}" height="${H}" filter="url(#${k}-n)" opacity="${(P && P.grainOp) || .22}"/>`

  /* 烫箔压进黑纸：上沿一道深影，下沿一道纸面反光，再盖箔面 */
  function foilText(attrs, body, fill, P, d) {
    const a = d || 1
    const b0 = body.replace(/ fill="[^"]*"/g, '')
    return `<g aria-hidden="true"><text ${attrs} transform="translate(0 ${f1(a * 1.1)})" fill="${P.lite}">${b0}</text><text ${attrs} transform="translate(0 ${f1(-a * .8)})" fill="${P.dark}">${b0}</text></g><text ${attrs} fill="${fill}">${body}</text>`
  }
  const num = (size, st, w, ls) => `font-family="Archivo,sans-serif" font-size="${size}" font-weight="${w || 700}" letter-spacing="${ls != null ? ls : (-size * .02).toFixed(2)}" style="font-variant-numeric:tabular-nums;font-stretch:${st || 100}%"`

  const brand = (P) => `<div class="lp-brand" style="color:${P.ink}"><span class="lp-logo"><img src="/logo-256.png" alt=""></span><div class="lp-wm"><b>信号实验室</b><i style="color:${P.sub}">SIGNAL LAB</i></div></div>`
  function foot(P, cta) {
    const u = D().user
    return `<div class="lp-foot"><div class="lp-qr">${window.PX.qr(u.link, 54, '#141317', '#EEEDF2')}</div>` +
      `<div class="lp-who" style="color:${P.ink}"><b>${u.name}</b>${u.code ? `<span style="color:${P.sub}">${D().L.invite}<em style="color:${P.ink}">${u.code}</em></span>` : ''}` +
      `<u style="color:${P.cta || P.foil[1]}">${cta}</u></div></div>`
  }
  const card = (type, P, svg, html) => `<article class="sl-card sl-lpdark sl-lpdark-${type}" style="background:${P.bot};color:${P.ink}">` +
    `<svg class="lp-bg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${svg}</svg>${html}</article>`

  /* A 单笔战报：只有一枚烫箔主数字，居中压在黑棉纸上，四周全是留白 */
  function cardA(s) {
    const P = PAPER.base, k = s.key, t = D().trades[s.mode], win = s.mode === 'win'
    const txt = s.privacy ? D().fmt(t.pct, 2) + '%' : D().fmt(t.pnl, 2)
    const size = s.privacy ? 80 : 62
    const body = txt + (s.privacy ? '' : `<tspan font-size="14" font-weight="700" dx="6" letter-spacing="1.2" fill="${win ? P.foil[3] : ROSE}" style="font-stretch:100%">USD</tspan>`)
    /* 整组在 70 到 345 之间垂直居中；亏损多一枚小签，整组上移 */
    const capH = Math.round(size * .72), blk = 13 + 34 + capH + 30 + 12 + (win ? 0 : 48)
    const top = Math.round(208 - blk / 2), base = top + 13 + 34 + capH, facts = base + 30
    const at = `x="${W / 2}" y="${base}" text-anchor="middle" ${num(size, 87, 700)}`
    const svg = `<defs>${paper(k, P)}${foilDef(k + '-f', P.foil)}${win ? '' : inkDef(k + '-i', LOSSINK)}</defs>${paperRects(k, P)}` +
      `<g data-fit="center" data-ox="${W / 2}" data-oy="${base}">${foilText(at, body, win ? `url(#${k}-f)` : `url(#${k}-i)`, P, 1.2)}</g>` +
      (win ? '' : tag(k, P, W / 2, facts + 47))
    const html = brand(P) +
      `<div class="lp-c lp-line" style="top:${top}px;color:${P.ink}">${t.symbol} ${t.sideTxt}</div>` +
      `<div class="lp-c lp-facts" style="top:${facts}px;color:${P.sub}">${t.pips == null ? '' : `<b style="color:${P.ink}">${D().fmt(t.pips, 1)}</b> ${D().L.pips}<s></s>`}${D().L.hold} <b style="color:${P.ink}">${t.hold}</b></div>` +
      foot(P, D().L.ctaJoin)
    return card('A', P, svg, html)
  }
  /* 亏损标签：压凹的胶囊，玫瑰墨线和字 */
  function tag(k, P, cx, cy) {
    const w = 96, h = 26, x = cx - w / 2 + .5, y = cy - h / 2 + .5
    return `<g><rect x="${x}" y="${y + 1}" width="${w - 1}" height="${h - 1}" rx="12.5" fill="none" stroke="${P.lite}" stroke-width="1"/>` +
      `<rect x="${x}" y="${y}" width="${w - 1}" height="${h - 1}" rx="12.5" fill="${P.face}" stroke="${ROSE}" stroke-opacity=".75" stroke-width="1"/>` +
      `<text x="${cx}" y="${cy + 4.4}" text-anchor="middle" font-family="${CJK.replace(/'/g, '')}" font-size="12" font-weight="700" letter-spacing="1.6" fill="${ROSE}">${D().L.stopTag}</text></g>`
  }

  /* B 勋章奖状：勋章居中，外圈一道无色压凹圆环；名字烫与勋章同材质的箔，纸色与背光随材质轻微变化 */
  const MAT = {
    bronze: { top: '#1E1A19', bot: '#110E0D', glow: 'rgba(214,130,80,.20)', cta: '#D99A72', foil: ['#7E4322', '#C47A4A', '#F8D3B6', '#D08B5C', '#76401F'] },
    silver: { top: '#1A1B1F', bot: '#0E0F12', glow: 'rgba(170,182,210,.17)', cta: '#BCC2CE', foil: SILVER },
    gold: { top: '#1D1B17', bot: '#100F0C', glow: 'rgba(236,188,84,.20)', cta: '#DDB451', foil: ['#8E6418', '#D0A440', '#FCEAB0', '#DDB451', '#865E14'] },
    legend: { top: '#221B33', bot: '#110D1B', face: '#0B0814', glow: 'rgba(150,110,255,.24)', cta: '#E6C67A',
      foil: ['#9C7628', '#D8B564', '#FFF3CE', '#E3C274', '#93702A'], sheen: .07, ring2: true, big: true, sub: '#ABA4C2' },
    limited: { top: '#221517', bot: '#140C0E', face: '#0D0809', glow: 'rgba(200,50,74,.20)', cta: '#EE8496',
      foil: ['#8E2236', '#CF5266', '#FBB6C0', '#D9606F', '#84203A'], ring2: true, sub: '#AD9DA1' },
  }
  function cardB(s) {
    const m = D().medals[s.medal] || D().medals.winning_hand
    const M = MAT[m.material]
    const P = Object.assign({}, PAPER.base, M), k = s.key
    const cx = W / 2, cy = 162, R = 79, ms = P.big ? 126 : 114
    /* 压凹圆环：上沿深影、下沿反光、中间一道比纸深的凹面 */
    const ring = (r, sw) => `<circle cx="${cx}" cy="${cy + 1.2}" r="${r}" fill="none" stroke="${P.lite}" stroke-width="${sw}"/>` +
      `<circle cx="${cx}" cy="${cy - 1.2}" r="${r}" fill="none" stroke="${P.dark}" stroke-width="${sw}"/>` +
      `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${P.face}" stroke-width="${sw}"/>`
    const tier = m.tierTxt.split(' ')[0]
    const rare = (m.rarity < 20 ? D().L.rareBefore : D().L.commonBefore) + m.rarity + '%' + D().L.rarityAfter
    const svg = `<defs>${paper(k, P)}${foilDef(k + '-f', P.foil, 'x1="0" y1="0" x2=".6" y2="1"')}<radialGradient id="${k}-g"><stop offset="0" stop-color="${P.glow}"/><stop offset="1" stop-color="${P.glow}" stop-opacity="0"/></radialGradient></defs>${paperRects(k, P)}` +
      `<circle cx="${cx}" cy="${cy}" r="${R - 3}" fill="url(#${k}-g)"/>` + ring(R, 2.6) + (P.ring2 ? ring(R - 8, 1.1) : '') +
      foilText(`x="${cx}" y="${cy + R + 53}" text-anchor="middle" font-family="${CJK.replace(/'/g, '')}" font-size="34" font-weight="800" letter-spacing="5"`, m.name, `url(#${k}-f)`, P)
    const html = brand(P) +
      `<div class="lp-a" style="left:${cx - ms / 2}px;top:${cy - ms / 2}px">${window.PX.medal(m.id, m.tier, ms, k)}</div>` +
      `<div class="lp-c lp-facts" style="top:${cy + R + 70}px;color:${P.sub}"><b style="color:${P.cta};font-size:13px;letter-spacing:.16em">${tier}</b><s></s>${rare}</div>` +
      foot(P, D().L.ctaJoin)
    return card('B', P, svg, html)
  }

  /* C 月度成绩单：只压交易日，周一到周五五列；盈利日烫紫箔，亏损日在凹坑里画一道玫瑰墨圈 */
  function cardC(s) {
    const P = PAPER.base, k = s.key, mo = D().month(s.mode), win = mo.total >= 0
    const txt = s.privacy ? D().fmt(mo.pct, 1) + '%' : D().fmt(mo.total, 2)
    const size = s.privacy ? 72 : 58
    const body = txt + (s.privacy ? '' : `<tspan font-size="14" font-weight="700" dx="6" letter-spacing="1.2" fill="${win ? P.foil[3] : ROSE}" style="font-stretch:100%">USD</tspan>`)
    const at = `x="${W / 2}" y="${s.privacy ? 183 : 178}" text-anchor="middle" ${num(size, 87, 700)}`
    const pitch = 19, r = 5.5, x0 = W / 2 - pitch * 2, y0 = 218, off = mo.firstWeekday - 1
    let dots = ''
    mo.days.forEach((v, i) => {
      const n = i + off, wd = n % 7
      if (wd > 4) return
      const x = x0 + wd * pitch, y = y0 + Math.floor(n / 7) * pitch
      dots += `<circle cx="${x}" cy="${y + .9}" r="${r}" fill="${P.lite}"/><circle cx="${x}" cy="${y - .8}" r="${r}" fill="${P.dark}"/>`
      if (v > 0) dots += `<circle cx="${x}" cy="${y}" r="${r - .4}" fill="url(#${k}-d)"/>`
      else dots += `<circle cx="${x}" cy="${y}" r="${r - .3}" fill="${P.face}"/>` + (v < 0 ? `<circle cx="${x}" cy="${y}" r="${r - 1.5}" fill="none" stroke="${ROSE}" stroke-width="1.1"/>` : '')
    })
    const svg = `<defs>${paper(k, P)}${foilDef(k + '-f', P.foil)}<linearGradient id="${k}-d" x1="0" y1="0" x2=".8" y2="1"><stop offset="0" stop-color="${P.foil[3]}"/><stop offset=".5" stop-color="${P.foil[1]}"/><stop offset="1" stop-color="${P.foil[4]}"/></linearGradient>${win ? '' : inkDef(k + '-i', LOSSINK)}</defs>${paperRects(k, P)}` +
      `<g data-fit="center" data-ox="${W / 2}" data-oy="${s.privacy ? 183 : 178}">${foilText(at, body, win ? `url(#${k}-f)` : `url(#${k}-i)`, P, 1.2)}</g>` + `<g>${dots}</g>`
    const html = brand(P) +
      `<div class="lp-c lp-line" style="top:96px;color:${P.ink}">${D().L.monthLabel}</div>` +
      `<div class="lp-c lp-facts" style="top:322px;color:${P.sub}">${D().L.winRate} <b style="color:${P.ink}">${mo.winRate}%</b><s></s><b style="color:${P.ink}">${mo.trades}</b> ${D().L.tradesUnit}</div>` +
      foot(P, D().L.ctaJoin)
    return card('C', P, svg, html)
  }

  /* D 比赛名次：一个巨大的无色压凹 2。凹面比纸更深，上沿一道深影、下沿一道亮边，
     再沿字形描一根极细的冷银箔线，缩略图里也认得出；序数后缀烫紫箔 */
  function cardD(s) {
    const P = PAPER.base, k = s.key, c = D().comp
    const at = `x="${W / 2 - 14}" y="299" text-anchor="middle" ${num(220, 100, 800, -4)}`
    const rank = String(c.rank)
    const svg = `<defs>${paper(k, P)}${foilDef(k + '-f', P.foil)}${foilDef(k + '-s', SILVER, 'x1="0" y1="0" x2=".8" y2="1"')}` +
      `<linearGradient id="${k}-r" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0E0D10"/><stop offset=".6" stop-color="#121115"/><stop offset="1" stop-color="#18171B"/></linearGradient></defs>${paperRects(k, P)}` +
      `<g aria-hidden="true"><text ${at} transform="translate(0 2.4)" fill="rgba(255,255,255,.26)">${rank}</text>` +
      `<text ${at} transform="translate(0 -2.6)" fill="rgba(0,0,0,.9)">${rank}</text></g>` +
      /* 凹面：先整片压暗，再把字形下移一点盖回凹底色，上沿露出的一条暗带就是凹壁的阴影 */
      `<clipPath id="${k}-c"><text ${at}>${rank}</text></clipPath>` +
      `<g clip-path="url(#${k}-c)"><rect x="40" y="60" width="280" height="260" fill="#000"/><text ${at} transform="translate(0 5)" fill="url(#${k}-r)">${rank}</text></g>` +
      `<text ${at} fill="none" stroke="url(#${k}-s)" stroke-width="1.6" stroke-linejoin="round">${rank}</text>` +
      foilText(`x="${W / 2 + 50}" y="171" ${num(34, 100, 800, -.5)}`, c.rankSuffix, `url(#${k}-f)`, P)
    const html = brand(P) +
      `<div class="lp-c lp-line" style="top:96px;color:${P.ink}">${c.name}</div>` +
      `<div class="lp-c lp-facts" style="top:324px;color:${P.sub}">${D().L.ret} <b style="color:${P.ink}">${D().fmt(c.ret, 2)}%</b><s></s><b style="color:${P.ink}">${c.participants}</b> ${D().L.participantsUnit}</div>` +
      foot(P, D().L.ctaComp)
    return card('D', P, svg, html)
  }

  window.SL = window.SL || {}
  window.SL['lpdark'] = {
    name: '凸版',
    blurb: '乌木黑棉纸上无色压凹，主数字和名字烫一层紫箔或银箔，像一张深色的凸版请柬。',
    css,
    render(type, state) {
      if (type === 'A') return cardA(state)
      if (type === 'B') return cardB(state)
      if (type === 'C') return cardC(state)
      return cardD(state)
    },
  }
})()

  return window.SL['lpdark']
}
