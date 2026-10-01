// @ts-nocheck
/* 分享卡模板「tidark」：由设计稿 v4-tidark/cards.js 移植，模板本身是纯字符串渲染。
   数据、文案（D().L）、勋章与二维码都由 env 注入，见 ../cardEnv.ts。
   Share-card template ported verbatim from the design mockup; data, copy, medal and QR come from env. */
import type { CardEnv, CardTemplate } from '../cardEnv'

export default function create(env: CardEnv): CardTemplate {
  // 设计稿通过 window.SLDATA / window.PX 取数据并注册到 window.SL；这里用同名局部变量接住，模板源码不用改。
  const window = { get SLDATA() { return env.data }, PX: env.px, SL: {} };
/* 信号实验室分享卡 v4 · 钛金（深色）Black Titanium
   一块黑色 PVD 拉丝钛卡：表面是枪灰到近黑的拉丝金属，带一条冷色各向异性高光；
   文字激光雕刻，刻穿黑色镀层露出底下的银灰裸钛（上沿暗、下沿一丝亮边）。
   盈亏只用一枚阳极氧化的小色块（绿加号 / 红减号）表达。 */
(function () {
  const CJK = "'PingFang SC','Noto Sans SC','Microsoft YaHei',sans-serif"
  const NUM = "'Archivo',sans-serif"
  const D = () => window.SLDATA
  const f1 = (v) => Math.round(v * 10) / 10

  /* 阳极氧化色：在黑钛上要更亮一档，色带本身带一点色相漂移 */
  const ANO = {
    up: ['#A6F7CF', '#3AD584', '#169C68'],
    dn: ['#FF9CAA', '#FF5A71', '#E4476B'],
    vi: ['#E4DDFF', '#B9A6FF', '#A894FF'],
  }
  /* 裸钛刻面：雕刻槽里露出的银灰金属，上暗下亮（光从上方来，槽底向下反光） */
  const BARE = ['#B9BEC5', '#E6E9ED', '#F6F7F9', '#A9AFB7']

  const css = `
.sl-tidark{position:relative;width:360px;height:450px;overflow:hidden;border-radius:22px;box-sizing:border-box;isolation:isolate;
  --s0:#2C2E33;--s1:#1A1B1F;--s2:#0C0D0F;--band:.13;--hl:205,216,232;
  --ink:#DDE0E5;--ink2:#B9BEC5;--lip:rgba(255,255,255,.13);--shade:rgba(0,0,0,.62);
  background:
    linear-gradient(102deg,rgba(var(--hl),0) 24%,rgba(var(--hl),calc(var(--band)*.45)) 37%,rgba(var(--hl),var(--band)) 45%,rgba(var(--hl),calc(var(--band)*.2)) 55%,rgba(var(--hl),0) 67%),
    linear-gradient(102deg,rgba(var(--hl),0) 76%,rgba(var(--hl),calc(var(--band)*.32)) 84%,rgba(var(--hl),0) 92%),
    radial-gradient(90% 60% at 10% 0%,rgba(var(--hl),.09) 0%,rgba(var(--hl),0) 70%),
    linear-gradient(168deg,var(--s0) 0%,var(--s1) 50%,var(--s2) 100%);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.20),inset 0 -1px 0 rgba(0,0,0,.7),inset 0 0 0 1px rgba(255,255,255,.07);
  color:var(--ink);font-family:${NUM};font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased}
.sl-tidark *{box-sizing:border-box;margin:0;padding:0}
.sl-tidark .ti-grain{position:absolute;left:0;top:0;z-index:-1;display:block}
.sl-tidark .ti-a{position:absolute;line-height:1}
.sl-tidark .ti-e{color:var(--ink);text-shadow:0 -1px 0 var(--shade),0 1px 0 var(--lip)}
.sl-tidark .ti-cjk{font-family:${CJK}}
.sl-tidark .ti-logo{position:relative;display:block;width:24px;height:28px;overflow:hidden;flex:none}
.sl-tidark .ti-logo img{position:absolute;width:44px;height:44px;left:-10px;top:-3px;max-width:none;display:block}
.sl-tidark .ti-brand{position:absolute;left:24px;top:24px;display:flex;align-items:center;gap:9px}
.sl-tidark .ti-wm{display:flex;flex-direction:column;gap:4px;line-height:1}
.sl-tidark .ti-wm b{font-family:${CJK};font-size:13px;font-weight:700;letter-spacing:.12em}
.sl-tidark .ti-wm i{font-style:normal;font-size:8px;font-weight:600;letter-spacing:.34em;color:var(--ink2)}
.sl-tidark .ti-lbl{font-family:${NUM},${CJK};font-size:13px;font-weight:600;letter-spacing:.14em}
.sl-tidark .ti-lbl em{font-style:normal;font-family:${CJK};font-weight:700;letter-spacing:.12em;margin-left:8px}
.sl-tidark .ti-hn{font-family:${NUM};font-weight:640;font-variant-numeric:tabular-nums}
.sl-tidark .ti-facts{display:flex;gap:24px;font-family:${CJK};font-size:13px;color:var(--ink2);letter-spacing:.06em}
.sl-tidark .ti-facts b{font-family:${NUM};font-weight:700;color:var(--ink);letter-spacing:.02em;margin:0 3px 0 2px}
.sl-tidark .ti-facts b:first-child{margin-left:0}
.sl-tidark .ti-tag{display:inline-flex;align-items:center;gap:9px;height:28px;padding:0 13px 0 12px;border-radius:6px;font-family:${CJK};font-size:11px;font-weight:700;letter-spacing:.2em;
  background:linear-gradient(180deg,rgba(0,0,0,.34),rgba(0,0,0,.16));
  box-shadow:inset 0 1px 2px rgba(0,0,0,.7),inset 0 -1px 0 rgba(255,255,255,.07),0 1px 0 rgba(255,255,255,.09)}
.sl-tidark .ti-tag i{width:12px;height:3px;border-radius:1.5px;background:linear-gradient(90deg,${ANO.dn[0]},${ANO.dn[1]} 55%,${ANO.dn[2]});box-shadow:0 -1px 0 rgba(0,0,0,.6)}
.sl-tidark .ti-ft{position:absolute;left:24px;right:24px;bottom:24px;height:68px;display:flex;align-items:center}
.sl-tidark .ti-who{display:flex;flex-direction:column;gap:9px;line-height:1}
.sl-tidark .ti-who b{font-size:13px;font-weight:700;letter-spacing:.06em}
.sl-tidark .ti-who span{font-family:${CJK};font-size:11px;letter-spacing:.08em;color:var(--ink2)}
.sl-tidark .ti-who span em{font-style:normal;font-family:${NUM};font-weight:700;letter-spacing:.16em;color:var(--ink);margin-left:4px}
.sl-tidark .ti-cta{margin-left:auto;margin-right:14px;font-family:${CJK};font-size:13px;font-weight:700;letter-spacing:.12em}
.sl-tidark .ti-plate{width:68px;height:68px;padding:6px;border-radius:10px;flex:none;
  background:linear-gradient(150deg,#FDFDFE 0%,#EEF0F2 46%,#DDE1E5 54%,#F5F6F7 100%);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.95),inset 0 -1px 0 rgba(20,22,26,.18),0 0 0 1px rgba(0,0,0,.55),0 1px 0 1px rgba(255,255,255,.08),0 6px 12px -4px rgba(0,0,0,.75)}
.sl-tidark .ti-plate svg{display:block;width:56px;height:56px}
.sl-tidark .ti-well{position:absolute;border-radius:50%;
  box-shadow:inset 0 3px 7px rgba(0,0,0,.5),inset 0 1px 1px rgba(0,0,0,.55),inset 0 -1.5px 0 var(--wl,rgba(255,255,255,.12)),0 1px 0 rgba(255,255,255,.08),0 -1px 0 rgba(0,0,0,.4)}
.sl-tidark .ti-medal{position:absolute;filter:drop-shadow(0 8px 9px rgba(0,0,0,.6))}
.sl-tidark .ti-medal svg{display:block}
.sl-tidark .ti-name{font-family:${CJK};font-size:34px;font-weight:800;letter-spacing:.14em;margin-right:-.14em}
`

  /* 拉丝纹：一次各向异性的 fractalNoise（横向极低频、纵向高频）；
     在黑钛上拆成两路：亮丝（冷白，按噪声高段取透明度）+ 暗丝（纯黑，按噪声低段），
     这样不会把整块底色抬灰，纹理只在金属表面上“刮”出来。 */
  const grain = (k, a) => `<svg class="ti-grain" width="360" height="450" viewBox="0 0 360 450" aria-hidden="true"><filter id="${k}-gr" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">` +
    `<feTurbulence type="fractalNoise" baseFrequency="0.008 1.15" numOctaves="2" seed="7" result="n"/>` +
    `<feColorMatrix in="n" result="l" values="0 0 0 0 .86  0 0 0 0 .9  0 0 0 0 .96  2.4 0 0 0 -1.12"/>` +
    `<feColorMatrix in="n" result="d" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  -2.4 0 0 0 1.3"/>` +
    `<feMerge><feMergeNode in="d"/><feMergeNode in="l"/></feMerge></filter>` +
    `<rect width="360" height="450" filter="url(#${k}-gr)" opacity="${a || 0.13}"/></svg>`

  /* 裸钛刻面渐变：槽口上沿压暗、中段一道冷白亮带、槽底回落，像真实刻槽里的金属反光 */
  const bare = (id, y0, y1) => `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="0" y1="${y0}" x2="0" y2="${y1}">` +
    `<stop offset="0" stop-color="${BARE[0]}"/><stop offset=".36" stop-color="${BARE[1]}"/><stop offset=".5" stop-color="${BARE[2]}"/><stop offset="1" stop-color="${BARE[3]}"/></linearGradient>`

  /* 雕刻主数字：三层同形叠放（上沿暗边、下沿一丝亮边、裸钛槽面），符号是阳极氧化的小色块 */
  function hero(k, v, main, unit, fs, o) {
    o = o || {}
    const pos = v >= 0, A = pos ? ANO.up : ANO.dn
    const base = Math.round(fs * 0.80), h = Math.round(fs * 0.86)
    const bw = f1(fs * 0.35), bt = f1(Math.max(4, fs * 0.096)), my = base - fs * 0.355
    const r = f1(bt * 0.22)
    const sign = `<rect x="0" y="${f1(my - bt / 2)}" width="${bw}" height="${bt}" rx="${r}"/>` +
      (pos ? `<rect x="${f1(bw / 2 - bt / 2)}" y="${f1(my - bw / 2)}" width="${bt}" height="${bw}" rx="${r}"/>` : '')
    const tx = f1(bw + fs * 0.07)
    const st = `font-size:${fs}px;font-stretch:${o.stretch || 100}%;letter-spacing:${(-fs * 0.022).toFixed(2)}px`
    const ust = unit === '%' ? `font-size:${Math.round(fs * 0.5)}px;letter-spacing:0` : `font-size:15px;font-weight:700;letter-spacing:.12em;font-stretch:100%`
    const txt = `<text class="ti-hn" x="${tx}" y="${base}" style="${st}">${main}<tspan dx="${unit === '%' ? 3 : 9}" style="${ust}">${unit}</tspan></text>`
    const top = f1(base - fs * 0.74)
    return `<svg width="312" height="${h}" viewBox="0 0 312 ${h}" style="display:block;overflow:visible" aria-label="${pos ? '+' : '-'}${main}${unit}">` +
      `<defs>${bare(k + '-hg', top, base)}` +
      `<linearGradient id="${k}-ag" gradientUnits="userSpaceOnUse" x1="0" y1="${f1(my - bw / 2)}" x2="${bw}" y2="${f1(my + bw / 2)}"><stop offset="0" stop-color="${A[0]}"/><stop offset=".5" stop-color="${A[1]}"/><stop offset="1" stop-color="${A[2]}"/></linearGradient></defs>` +
      `<g fill="#FFFFFF" fill-opacity=".12" transform="translate(0 1.4)" aria-hidden="true">${sign}${txt}</g>` +
      `<g fill="#000000" fill-opacity=".7" transform="translate(0 -1.2)" aria-hidden="true">${sign}${txt}</g>` +
      `<g fill="url(#${k}-ag)">${sign}</g><g fill="url(#${k}-hg)">${txt}</g></svg>`
  }

  /* 品牌标：原版霓虹烧瓶（logo-256 裁切）+ 激光刻字的中英文字标 */
  const brand = (k) => `<div class="ti-brand"><span class="ti-logo"><img src="/logo-256.png" alt=""></span>` +
    `<span class="ti-wm ti-e"><b>信号实验室</b><i>SIGNAL LAB</i></span></div>`
  function foot(cta) {
    const u = D().user
    return `<div class="ti-ft"><div class="ti-who ti-e"><b>${u.name}</b>${u.code ? `<span>${D().L.invite}<em>${u.code}</em></span>` : ''}</div>` +
      `<div class="ti-cta ti-e">${cta}</div><div class="ti-plate">${window.PX.qr(u.link, 56, '#1C1F24', '#F1F2F4')}</div></div>`
  }
  const card = (type, s, inner, style, ga) => `<article class="sl-card sl-tidark sl-tidark-${type}"${style ? ` style="${style}"` : ''}>${grain(s.key, ga)}${inner}</article>`
  const nb = (v) => `<b>${v}</b>`

  /* A 单笔战报 */
  function cardA(s) {
    const t = D().trades[s.mode], win = s.mode === 'win'
    const v = s.privacy ? t.pct : t.pnl
    const main = D().fmt(v, 2).slice(1)
    const fs = s.privacy ? 80 : 64
    const hy = 176
    const inner = brand(s.key) +
      `<div class="ti-a ti-lbl ti-e" style="left:24px;top:${hy - 34}px">${t.symbol}<em>${t.sideTxt}</em></div>` +
      `<div class="ti-a" data-fit="left" style="left:24px;top:${hy}px">${hero(s.key, v, main, s.privacy ? '%' : 'USD', fs, { stretch: s.privacy ? 100 : 92 })}</div>` +
      `<div class="ti-a ti-facts ti-e" style="left:24px;top:${hy + Math.round(fs * 0.86) + 22}px;align-items:center">${t.pips == null ? '' : `<span>${nb(D().fmt(t.pips, 1))} ${D().L.pips}</span>`}<span>${D().L.hold} ${t.hold.replace(/(\d+)/g, '<b>$1</b>')}</span></div>` +
      (win ? '' : `<div class="ti-a ti-tag ti-e" style="left:24px;top:${hy + Math.round(fs * 0.86) + 54}px"><i></i>${t.exit}</div>`) +
      foot(D().L.ctaJoin)
    return card('A', s, inner)
  }

  /* B 勋章奖状：勋章嵌进金属上的一口圆形凹槽；材质只换金属表面色和槽底色 */
  /* s 表面三色、hl 高光带色相、w 槽底两色、wl 槽口下沿反光色（随材质染色） */
  const MAT = {
    bronze:  { s: ['#47332A', '#2C211B', '#171110'], hl: '240,198,172', w: ['rgba(70,46,32,.10)', 'rgba(12,7,4,.46)'], wl: 'rgba(222,160,118,.30)' },
    silver:  { s: ['#3C4046', '#25282C', '#141518'], hl: '205,216,232', w: ['rgba(46,50,56,.08)', 'rgba(4,5,6,.46)'], wl: 'rgba(214,222,232,.26)' },
    gold:    { s: ['#4A412F', '#2E281C', '#18150F'], hl: '246,226,184', w: ['rgba(70,60,38,.10)', 'rgba(9,8,4,.46)'], wl: 'rgba(232,206,140,.30)' },
    legend:  { s: ['#232427', '#141517', '#08090A'], hl: '214,220,230', w: ['rgba(18,18,21,.55)', 'rgba(3,3,4,.85)'], wl: 'rgba(255,255,255,.06)', ring: true, band: '.07' },
    limited: { s: ['#3A2D2E', '#251D1E', '#140F10'], hl: '238,204,206', w: ['rgba(112,30,40,.34)', 'rgba(32,6,10,.62)'], wl: 'rgba(240,120,120,.26)' },
  }
  /* 勋章座：车床铣出来的浅沉孔，底面是同心车纹（不是拉丝），只比卡面暗一档，不做成黑洞 */
  const wellBg = (M) => `repeating-radial-gradient(circle at 50% 50%,rgba(255,255,255,.04) 0 .8px,rgba(255,255,255,0) .8px 2.6px),` +
    `linear-gradient(102deg,rgba(${M.hl},0) 28%,rgba(${M.hl},.07) 50%,rgba(${M.hl},0) 72%),` +
    `radial-gradient(72% 72% at 50% 44%,${M.w[0]} 0%,${M.w[1]} 100%)`
  function cardB(s) {
    const m = D().medals[s.medal] || D().medals.winning_hand
    const M = MAT[m.material] || MAT.gold
    const tier = m.tierTxt.replace(/\s*[IVX]+$/, '')
    const cx = 180, cy = 168, wd = 172, ms = 140
    let vars = `--s0:${M.s[0]};--s1:${M.s[1]};--s2:${M.s[2]};--hl:${M.hl}`
    if (M.band) vars += `;--band:${M.band}`
    const ring = M.ring ? `;box-shadow:inset 0 4px 10px rgba(0,0,0,.7),inset 0 1px 1px rgba(0,0,0,.8),inset 0 -1.5px 0 rgba(255,255,255,.06),0 0 0 4px #08090A,0 0 0 5px rgba(240,206,120,.75),0 1px 0 5px rgba(255,236,180,.18),0 -1px 0 5px rgba(0,0,0,.7)` : ''
    const inner = brand(s.key) +
      `<div class="ti-well" style="left:${cx - wd / 2}px;top:${cy - wd / 2}px;width:${wd}px;height:${wd}px;--wl:${M.wl};background:${wellBg(M)}${ring}"></div>` +
      `<div class="ti-medal" style="left:${cx - ms / 2}px;top:${cy - ms / 2}px">${window.PX.medal(m.id, m.tier, ms, s.key)}</div>` +
      `<div class="ti-a ti-e" style="left:0;right:0;top:274px;display:flex;align-items:baseline;justify-content:center;gap:12px"><span class="ti-name">${m.name}</span><span class="ti-cjk" style="font-size:13px;font-weight:700;letter-spacing:.14em;color:var(--ink2)">${tier}</span></div>` +
      `<div class="ti-a ti-e ti-cjk" style="left:0;right:0;top:322px;text-align:center;font-size:11px;letter-spacing:.12em;color:var(--ink2)">${m.rarity < 20 ? D().L.rareBefore : D().L.commonBefore}<b style="font-family:${NUM};color:var(--ink);letter-spacing:.04em">${m.rarity}%</b>${D().L.rarityAfter}</div>` +
      foot(D().L.ctaJoin)
    return card('B', s, inner, vars, M.ring ? 0.09 : 0.13)
  }

  /* C 月度成绩单：一条雕刻的累计曲线，末端一颗阳极氧化圆点 */
  function cardC(s) {
    const mo = D().month(s.mode), win = mo.total >= 0
    const v = s.privacy ? mo.pct : mo.total
    const main = D().fmt(v, s.privacy ? 1 : 2).slice(1)
    const fs = s.privacy ? 80 : 64
    const hy = 124
    const pts = [0]
    mo.days.filter((x) => x !== 0).forEach((x) => pts.push(pts[pts.length - 1] + x))
    const X0 = 24, X1 = 330, Y0 = 0, Y1 = 64
    const lo = Math.min(...pts), hi = Math.max(...pts)
    const xy = pts.map((p, i) => [f1(X0 + (X1 - X0) * i / (pts.length - 1)), f1(Y1 - (p - lo) / ((hi - lo) || 1) * (Y1 - Y0))])
    /* Catmull-Rom 平滑：激光刻线是连续走刀，不该有折线的锯齿 */
    let d = 'M' + xy[0].join(' ')
    for (let i = 0; i < xy.length - 1; i++) {
      const p0 = xy[i - 1] || xy[i], p1 = xy[i], p2 = xy[i + 1], p3 = xy[i + 2] || p2, t = 0.4 / 3
      d += 'C' + [f1(p1[0] + (p2[0] - p0[0]) * t), f1(p1[1] + (p2[1] - p0[1]) * t), f1(p2[0] - (p3[0] - p1[0]) * t), f1(p2[1] - (p3[1] - p1[1]) * t), p2[0], p2[1]].join(' ')
    }
    const end = xy[xy.length - 1], A = win ? ANO.up : ANO.dn
    const ly = Math.max(252, hy + Math.round(fs * 0.86) + 68)
    const line = `<svg class="ti-a" style="left:0;top:${ly}px;overflow:visible" width="360" height="${Y1}" viewBox="0 0 360 ${Y1}"><defs><linearGradient id="${s.key}-dg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${A[0]}"/><stop offset="1" stop-color="${A[2]}"/></linearGradient></defs>` +
      `<g fill="none" stroke-linejoin="round" stroke-linecap="round" stroke-width="2.6">` +
      `<path d="${d}" stroke="#FFFFFF" stroke-opacity=".10" transform="translate(0 1.4)"/>` +
      `<path d="${d}" stroke="#000000" stroke-opacity=".65" transform="translate(0 -1.2)"/>` +
      `<path d="${d}" stroke="#C9CED5"/></g>` +
      `<circle cx="${end[0]}" cy="${f1(+end[1] - 1.2)}" r="5.5" fill="#000000" fill-opacity=".6"/><circle cx="${end[0]}" cy="${end[1]}" r="5.5" fill="url(#${s.key}-dg)"/></svg>`
    const inner = brand(s.key) +
      `<div class="ti-a ti-lbl ti-e" style="left:24px;top:${hy - 34}px">${D().L.monthLabel}</div>` +
      `<div class="ti-a" data-fit="left" style="left:24px;top:${hy}px">${hero(s.key, v, main, s.privacy ? '%' : 'USD', fs, { stretch: s.privacy ? 100 : 92 })}</div>` +
      `<div class="ti-a ti-facts ti-e" style="left:24px;top:${hy + Math.round(fs * 0.86) + 22}px"><span>${D().L.winRate} ${nb(mo.winRate.toFixed(1) + '%')}</span><span>${nb(mo.trades)} ${D().L.tradesUnit}</span></div>` +
      line + foot(D().L.ctaJoin)
    return card('C', s, inner)
  }

  /* D 比赛名次：一个巨大的雕刻 2，名次后缀是阳极氧化紫 */
  function cardD(s) {
    const c = D().comp, k = s.key
    const fs = 236, base = 176, w = 150, h = 190
    const st = `font-size:${fs}px;font-weight:650;letter-spacing:-.04em`
    const t = `<text class="ti-hn" x="-6" y="${base}" style="${st}">${c.rank}</text>`
    const rank = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="display:block;overflow:visible" aria-label="${c.rank}">` +
      `<defs>${bare(k + '-rg', 6, base)}` +
      `<linearGradient id="${k}-vg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${ANO.vi[0]}"/><stop offset=".55" stop-color="${ANO.vi[1]}"/><stop offset="1" stop-color="${ANO.vi[2]}"/></linearGradient></defs>` +
      `<g fill="#FFFFFF" fill-opacity=".12" transform="translate(0 2)" aria-hidden="true">${t}</g>` +
      `<g fill="#000000" fill-opacity=".7" transform="translate(0 -1.8)" aria-hidden="true">${t}</g>` +
      `<g fill="url(#${k}-rg)">${t}</g></svg>`
    const sfx = `<svg width="44" height="34" viewBox="0 0 44 34" style="display:block;overflow:visible" aria-label="${c.rankSuffix}">` +
      `<text x="0" y="27" class="ti-hn" style="font-size:34px;font-weight:700;letter-spacing:.01em" fill="#000000" fill-opacity=".65" transform="translate(0 -1.2)" aria-hidden="true">${c.rankSuffix}</text>` +
      `<text x="0" y="27" class="ti-hn" style="font-size:34px;font-weight:700;letter-spacing:.01em" fill="url(#${k}-vg)">${c.rankSuffix}</text></svg>`
    const inner = brand(s.key) +
      `<div class="ti-a ti-lbl ti-e ti-cjk" style="left:24px;top:92px;letter-spacing:.2em">${c.name}</div>` +
      `<div class="ti-a" style="left:24px;top:116px;display:flex;align-items:flex-start"><div>${rank}</div><div style="margin:24px 0 0 -6px">${sfx}</div></div>` +
      `<div class="ti-a ti-facts ti-e" style="left:24px;top:322px"><span>${D().L.ret} ${nb(D().fmt(c.ret, 2) + '%')}</span><span>${nb(c.participants)} ${D().L.participantsUnit}</span></div>` +
      foot(D().L.ctaComp)
    return card('D', s, inner)
  }

  window.SL = window.SL || {}
  window.SL['tidark'] = {
    name: '钛金',
    blurb: '一块黑色 PVD 拉丝钛卡，激光刻穿镀层露出银灰裸钛，盈亏只靠一枚阳极氧化的小色块。',
    css,
    render(type, state) {
      if (type === 'A') return cardA(state)
      if (type === 'B') return cardB(state)
      if (type === 'C') return cardC(state)
      return cardD(state)
    },
  }
})()

  return window.SL['tidark']
}
