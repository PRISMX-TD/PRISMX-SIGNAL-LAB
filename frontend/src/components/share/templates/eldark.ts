// @ts-nocheck
/* 分享卡模板「eldark」：由设计稿 v4-eldark/cards.js 移植，模板本身是纯字符串渲染。
   数据、文案（D().L）、勋章与二维码都由 env 注入，见 ../cardEnv.ts。
   Share-card template ported verbatim from the design mockup; data, copy, medal and QR come from env. */
import type { CardEnv, CardTemplate } from '../cardEnv'

export default function create(env: CardEnv): CardTemplate {
  // 设计稿通过 window.SLDATA / window.PX 取数据并注册到 window.SL；这里用同名局部变量接住，模板源码不用改。
  const window = { get SLDATA() { return env.data }, PX: env.px, SL: {} };
/* 信号实验室分享卡 v4 · 元素 Element（深色）
   不再放格子：元素符号直接写在冷石墨釉面上。原子序数小号紫色挂在符号左上，符号是釉白渐变，主数字在下面。 */
(function () {
  const INK = '#ECE9E2'
  const SUB = '#9497A3'
  const VI = '#A592FF'
  const CJK = "'PingFang SC','Noto Sans SC','Microsoft YaHei',sans-serif"
  /* 釉面：左上一片宽而软的冷光，中段一道极淡的斜向反光，底色是偏蓝的深石墨 */
  const sheen = (tint) => `radial-gradient(70% 34% at 24% 4%,rgba(196,208,240,.13) 0%,rgba(196,208,240,0) 100%),` +
    `radial-gradient(120% 62% at 8% -6%,rgba(150,164,206,.10) 0%,rgba(150,164,206,0) 64%),` +
    `linear-gradient(121deg,rgba(255,255,255,0) 46%,rgba(220,230,255,.03) 57%,rgba(255,255,255,0) 68%),` +
    `linear-gradient(176deg,#1A1E27 0%,#11141B 54%,${tint || '#0B0D12'} 100%)`

  const css = `
.sl-eldark{position:relative;width:360px;height:450px;overflow:hidden;border-radius:22px;box-sizing:border-box;
  background:${sheen()};box-shadow:inset 0 1px 0 rgba(255,255,255,.07),inset 0 0 0 1px rgba(255,255,255,.025);
  color:${INK};font-family:'Archivo',${CJK};font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased}
.sl-eldark *{box-sizing:border-box;margin:0;padding:0}
.sl-eldark .e-cjk{font-family:${CJK}}
.sl-eldark .e-logo{position:relative;display:block;width:24px;height:28px;overflow:hidden;flex:none}
.sl-eldark .e-logo img{position:absolute;width:44px;height:44px;left:-10px;top:-3px;max-width:none;display:block}
.sl-eldark .e-brand{position:absolute;left:24px;top:24px;display:flex;align-items:center}
.sl-eldark .e-wm{margin-left:8px;display:flex;flex-direction:column;line-height:1}
.sl-eldark .e-wm b{font-family:${CJK};font-size:13px;font-weight:800;letter-spacing:.08em;color:${INK}}
.sl-eldark .e-wm i{font-style:normal;font-size:8px;font-weight:600;letter-spacing:.32em;color:#8A8E9A;margin-top:4px}
.sl-eldark .e-a{position:absolute;line-height:1}
.sl-eldark .e-z{font-family:'Archivo',sans-serif;font-size:13px;font-weight:700;color:${VI};letter-spacing:.02em}
.sl-eldark .e-name{font-family:'Archivo',${CJK};font-size:13px;font-weight:700;color:${INK};letter-spacing:.04em}
.sl-eldark .e-tag{font-family:${CJK};font-size:12px;font-weight:700;color:${INK};background:rgba(236,233,226,.075);border-radius:999px;padding:6px 11px 5px;letter-spacing:.06em}
.sl-eldark .e-facts{position:absolute;left:24px;display:flex;align-items:center;gap:22px;font-size:12px;line-height:1;color:${SUB};font-family:'Archivo',${CJK}}
.sl-eldark .e-facts b{color:${INK};font-weight:700}
.sl-eldark .e-foot{position:absolute;left:24px;right:24px;top:362px;height:64px;display:flex;align-items:center}
.sl-eldark .e-qr{width:64px;height:64px;padding:4px;background:#F4F2ED;border-radius:6px;flex:none}
.sl-eldark .e-qr svg{display:block}
.sl-eldark .e-who{margin-left:14px;display:flex;flex-direction:column;line-height:1}
.sl-eldark .e-who b{font-size:13px;font-weight:700;color:${INK}}
.sl-eldark .e-who span{font-family:${CJK};font-size:12px;color:${SUB};margin-top:8px}
.sl-eldark .e-who span em{font-family:'Archivo',sans-serif;font-style:normal;font-weight:700;color:${INK};letter-spacing:.1em;margin-left:3px}
.sl-eldark .e-cta{margin-left:auto;font-family:${CJK};font-size:12px;font-weight:700;color:${VI};letter-spacing:.06em}
`

  const D = () => window.SLDATA
  const UP = ['#A6F7C9', '#3AD584', '#22A866']
  const DN = ['#FFB0BA', '#FF6478', '#E84D66']
  /* 符号的釉白：顶部亮，往下沉进底色，像一层厚釉 */
  const GLAZE = ['#B4AFA5', '#A49F96', '#8A867F']

  /* SVG 文本 + 竖向渐变；一层黑色错位做压印，可选一层同色宽描边做微光 */
  function glyph(k, id, txt, unit, size, c, opt) {
    const o = opt || {}
    const st = o.stretch || 100, us = o.unit || Math.round(size * .3), W = o.w || 300
    const h = Math.round(size * .76), b = Math.round(size * .73)
    const ta = `font-family="Archivo,sans-serif" font-size="${size}" font-weight="${o.weight || 700}" letter-spacing="${(-size * (o.ls != null ? o.ls : .025)).toFixed(2)}" style="font-variant-numeric:tabular-nums;font-stretch:${st}%"`
    const body = `${txt}${unit ? `<tspan font-size="${us}" font-weight="700" dx="${o.dx != null ? o.dx : 6}" letter-spacing="0.5" style="font-stretch:100%">${unit}</tspan>` : ''}`
    return `<svg width="${W}" height="${h}" viewBox="0 0 ${W} ${h}" style="display:block;overflow:visible"${o.op ? ` opacity="${o.op}"` : ''}><defs><linearGradient id="${k}-${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c[0]}"/><stop offset=".5" stop-color="${c[1]}"/><stop offset="1" stop-color="${c[2]}"${o.fade != null ? ` stop-opacity="${o.fade}"` : ''}/></linearGradient></defs>` +
      (o.glow === false ? '' : `<text x="0" y="${b}" ${ta} fill="none" stroke="${c[1]}" stroke-opacity=".12" stroke-width="${Math.min(4, size * .06).toFixed(1)}" stroke-linejoin="round" aria-hidden="true">${body}</text>`) +
      `<text x="0" y="${b + (o.drop || 1.6)}" ${ta} fill="#000" fill-opacity=".6" aria-hidden="true">${body}</text><text x="0" y="${b}" ${ta} fill="url(#${k}-${id})">${body}</text></svg>`
  }
  const heroNum = (k, txt, privacy, win) => glyph(k, 'h', txt, privacy ? '' : 'USD', privacy ? 72 : 64, win ? UP : DN, { stretch: 87, ls: .03, unit: 15, dx: 5 })

  const brand = () => `<div class="e-brand"><span class="e-logo"><img src="/logo-256.png" alt=""></span><div class="e-wm"><b>信号实验室</b><i>SIGNAL LAB</i></div></div>`
  function foot(cta) {
    const u = D().user
    return `<div class="e-foot"><div class="e-qr">${window.PX.qr(u.link, 56, '#0E1016', '#F4F2ED')}</div>` +
      `<div class="e-who"><b>${u.name}</b>${u.code ? `<span>${D().L.invite}<em>${u.code}</em></span>` : ''}</div><div class="e-cta">${cta}</div></div>`
  }
  const card = (type, inner, style) => `<article class="sl-card sl-eldark sl-eldark-${type}"${style ? ` style="${style}"` : ''}>${inner}</article>`

  /* 元素头：左上原子序数，右上一行说明，下面是大符号 */
  const head = (z, label, k, sym, size, extra) =>
    `<div class="e-a e-z" style="left:26px;top:94px">${z}</div>` +
    `<div class="e-a e-name${extra || ''}" style="right:24px;top:94px">${label}</div>` +
    `<div class="e-a" style="left:20px;top:114px">${glyph(k, 's', sym, '', size, GLAZE, { w: 220, ls: .035, glow: false, drop: 2 })}</div>`

  /* A 单笔战报 */
  function cardA(s) {
    const t = D().trades[s.mode], win = s.mode === 'win'
    const txt = s.privacy ? D().fmt(t.pct, 2) + '%' : D().fmt(t.pnl, 2)
    const ht = s.privacy ? 236 : 246, hh = Math.round((s.privacy ? 72 : 64) * .76)
    const facts = `<div class="e-facts" style="top:${ht + hh + 20}px">${t.pips == null ? '' : `<span><b>${D().fmt(t.pips, 1)}</b> ${D().L.pips}</span>`}<span>${D().L.hold} <b>${t.hold}</b></span>${win ? '' : '<span class="e-tag" style="margin-top:-6px">${D().L.stopTag}</span>'}</div>`
    return card('A', brand() + head(t.elNum, `${t.symbol} ${t.sideTxt}`, s.key, t.elSym, 112) +
      `<div class="e-a" style="left:22px;top:${ht}px">${heroNum(s.key, txt, s.privacy, win)}</div>` + facts + foot(D().L.ctaJoin))
  }

  /* B 勋章奖状：符号作一枚大号同色调底纹，勋章压在上面做主角 */
  /* 材质只改釉色：底色尾调、勋章背后的光、符号与等级字色；传奇是紫黑釉配金，绝版是牛血红釉 */
  const MAT = {
    bronze: { glow: 'rgba(214,150,96,.26)', sym: '#E3B48C', bg: '#120E0B' },
    silver: { glow: 'rgba(176,188,214,.26)', sym: '#D5DBE6', bg: '#0D0F14' },
    gold: { glow: 'rgba(240,198,98,.28)', sym: '#F0CE7C', bg: '#110F09' },
    legend: { glow: 'rgba(243,214,143,.22)', sym: '#F3D68F', bg: '#0C0914', halo: 'rgba(120,80,255,.20)' },
    limited: { glow: 'rgba(210,78,66,.28)', sym: '#EBA597', bg: '#12090A' },
  }
  const SYM = { starter: 'Qb', veteran: 'Lb', winning_hand: 'Sh', comp_back_to_back: 'Wm', founder_2026: 'Cy' }
  /* 各符号在 112px 下的实测宽度；宽字母（Wm）按比例缩小，基线对齐，不压到勋章 */
  const SYMW = { Qb: 150, Lb: 127, Sh: 136, Wm: 198, Cy: 140 }
  function cardB(s) {
    const m = D().medals[s.medal] || D().medals.winning_hand
    const M = MAT[m.material]
    const tierShort = m.tierTxt.split(' ')[0]
    const cx = 250, cy = 182, ms = 168
    const light = `<div class="e-a" style="left:0;top:0;right:0;bottom:0;background:radial-gradient(150px 140px at ${cx}px ${cy}px,${M.glow} 0%,rgba(0,0,0,0) 100%)${M.halo ? `,radial-gradient(240px 200px at ${cx}px ${cy}px,${M.halo} 0%,rgba(0,0,0,0) 100%)` : ''}"></div>`
    const sy = SYM[m.id] || '', fs = Math.min(112, Math.round(112 * 128 / (SYMW[sy] || 128)))
    const sym = `<div class="e-a" style="left:20px;top:${Math.round(114 + .73 * (112 - fs))}px">${glyph(s.key, 's', sy, '', fs, [M.sym, M.sym, M.sym], { w: 140, ls: .035, glow: false, drop: 2, fade: .25, op: .42 })}</div>`
    const medal = `<div class="e-a" style="left:${cx - ms / 2}px;top:${cy - ms / 2}px">${window.PX.medal(m.id, m.tier, ms, s.key)}</div>`
    const tier = `<div class="e-a e-z" style="left:26px;top:94px;color:${M.sym};letter-spacing:.08em">${tierShort}</div>`
    const name = `<div class="e-a e-cjk" style="left:22px;top:290px;font-size:34px;font-weight:800;letter-spacing:.04em;color:${INK}">${m.name}</div>` +
      `<div class="e-a" style="right:24px;top:307px;font-size:12px;color:${SUB};font-family:'Archivo',${CJK}">${m.rarity < 20 ? D().L.rareBefore : D().L.commonBefore}<b style="color:${INK}">${m.rarity}%</b>${D().L.rarityAfter}</div>`
    return card('B', light + brand() + tier + sym + medal + name + foot(D().L.ctaJoin), `background:${sheen(M.bg)}`)
  }

  /* C 月度成绩单：符号右侧一条累计细线 */
  function cardC(s) {
    const mo = D().month(s.mode), win = mo.total >= 0
    const txt = s.privacy ? D().fmt(mo.pct, 1) + '%' : D().fmt(mo.total, 2)
    const LW = 104, LH = 72, pts = [0]
    mo.days.filter(v => v !== 0).forEach(v => pts.push(pts[pts.length - 1] + v))
    const lo = Math.min(...pts), hi = Math.max(...pts), sx = LW / (pts.length - 1), sy = (LH - 6) / ((hi - lo) || 1)
    const xy = pts.map((v, i) => [(i * sx).toFixed(1), (LH - 3 - (v - lo) * sy).toFixed(1)])
    const lc = win ? '#3AD584' : '#FF6478', end = xy[xy.length - 1], pl = xy.map(p => p.join(',')).join(' ')
    const strip = `<svg width="${LW + 4}" height="${LH}" viewBox="0 0 ${LW + 4} ${LH}" style="display:block;overflow:visible">` +
      `<polyline points="${pl}" fill="none" stroke="${lc}" stroke-opacity=".16" stroke-width="6" stroke-linejoin="round" stroke-linecap="round"/>` +
      `<polyline points="${pl}" fill="none" stroke="${lc}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>` +
      `<circle cx="${end[0]}" cy="${end[1]}" r="6" fill="${lc}" fill-opacity=".18"/><circle cx="${end[0]}" cy="${end[1]}" r="3" fill="${lc}"/></svg>`
    const ht = s.privacy ? 236 : 246, hh = Math.round((s.privacy ? 72 : 64) * .76)
    const facts = `<div class="e-facts" style="top:${ht + hh + 20}px"><span>${D().L.winRate} <b>${mo.winRate}%</b></span><span><b>${mo.trades}</b> ${D().L.tradesUnit}</span></div>`
    return card('C', brand() + head(String(mo.month).padStart(2, '0'), D().L.monthLabel, s.key, mo.abbr, 100) +
      `<div class="e-a" style="right:28px;top:128px">${strip}</div>` +
      `<div class="e-a" style="left:22px;top:${ht}px">${heroNum(s.key, txt, s.privacy, win)}</div>` + facts + foot(D().L.ctaJoin))
  }

  /* D 比赛名次：名次 2 本身就是元素 */
  function cardD(s) {
    const c = D().comp
    const rank = `<div class="e-a" style="left:16px;top:112px;display:flex;align-items:flex-start">${glyph(s.key, 'r', String(c.rank), '', 220, ['#D6CCFF', '#9A82FF', '#7F62F5'], { w: 132, ls: .04, weight: 800 })}` +
      `<span style="font-size:30px;font-weight:800;color:${VI};margin-top:18px;margin-left:6px;letter-spacing:-.01em">${c.rankSuffix}</span></div>`
    const facts = `<div class="e-facts" style="top:306px"><span>${D().L.ret} <b>${D().fmt(c.ret, 2)}%</b></span><span><b>${c.participants}</b> ${D().L.participantsUnit}</span></div>`
    return card('D', brand() + `<div class="e-a e-name e-cjk" style="left:24px;top:94px">${c.name}</div>` + rank + facts + foot(D().L.ctaComp))
  }

  window.SL = window.SL || {}
  window.SL['eldark'] = {
    name: '元素',
    blurb: '冷石墨釉面上直接写元素符号：紫色原子序数、釉白大字，主数字在下面。',
    css,
    render(type, state) {
      if (type === 'A') return cardA(state)
      if (type === 'B') return cardB(state)
      if (type === 'C') return cardC(state)
      return cardD(state)
    },
  }
})()

  return window.SL['eldark']
}
