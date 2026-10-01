// @ts-nocheck
/* 分享卡模板「scope」：由设计稿 v4-scope/cards.js 移植，模板本身是纯字符串渲染。
   数据、文案（D().L）、勋章与二维码都由 env 注入，见 ../cardEnv.ts。
   Share-card template ported verbatim from the design mockup; data, copy, medal and QR come from env. */
import type { CardEnv, CardTemplate } from '../cardEnv'

export default function create(env: CardEnv): CardTemplate {
  // 设计稿通过 window.SLDATA / window.PX 取数据并注册到 window.SL；这里用同名局部变量接住，模板源码不用改。
  const window = { get SLDATA() { return env.data }, PX: env.px, SL: {} };
/* 信号实验室分享卡 v4 · 信号
   纯黑表盘上只有一条紫色信号线和一个大数字。像手表心率屏，也像一枚腕表表盘：安静、精确、发光。 */
window.SL = window.SL || {};
(function () {
  const W = 360, H = 450, PAD = 24
  const NUM = "'Archivo','PingFang SC','Microsoft YaHei',sans-serif"
  const C = {
    core: '#F5F2FF', mid: '#9B86FF', deep: '#5A22EE', acc: '#9284FF',
    up: '#3AD584', dn: '#FF6478',
  }
  const D = () => window.SLDATA
  const f1 = (v) => Math.round(v * 10) / 10

  // Catmull-Rom 平滑成三次贝塞尔
  function smooth(p, t) {
    t = t == null ? 0.5 : t
    let d = 'M' + f1(p[0][0]) + ' ' + f1(p[0][1])
    for (let i = 0; i < p.length - 1; i++) {
      const p0 = p[i - 1] || p[i], p1 = p[i], p2 = p[i + 1], p3 = p[i + 2] || p2
      const c1x = p1[0] + (p2[0] - p0[0]) * t / 3, c1y = p1[1] + (p2[1] - p0[1]) * t / 3
      const c2x = p2[0] - (p3[0] - p1[0]) * t / 3, c2y = p2[1] - (p3[1] - p1[1]) * t / 3
      d += 'C' + f1(c1x) + ' ' + f1(c1y) + ' ' + f1(c2x) + ' ' + f1(c2y) + ' ' + f1(p2[0]) + ' ' + f1(p2[1])
    }
    return d
  }
  const poly = (p) => p.map((q, i) => (i ? 'L' : 'M') + f1(q[0]) + ' ' + f1(q[1])).join('')

  /* 信号线：三层描边叠出发光（不用模糊滤镜），左端渐隐，可选终点光点 */
  function signal(key, d, o) {
    o = o || {}
    const g = o.glow || C.deep, m = o.mid || C.mid, c = o.core || C.core
    const fx0 = o.fx0 == null ? 0 : o.fx0, fx1 = o.fx1 == null ? 150 : o.fx1
    let defs = `<linearGradient id="${key}-fg" gradientUnits="userSpaceOnUse" x1="${fx0}" y1="0" x2="${fx1}" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#fff"/></linearGradient>` +
      `<mask id="${key}-fm" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${o.h || H}"><rect width="${W}" height="${o.h || H}" fill="url(#${key}-fg)"/></mask>`
    const body = `<g mask="url(#${key}-fm)"><g fill="none" stroke-linecap="round" stroke-linejoin="round">` +
      `<path d="${d}" stroke="${g}" stroke-opacity="${o.a1 || 0.22}" stroke-width="${o.w1 || 10}"/>` +
      `<path d="${d}" stroke="${m}" stroke-opacity="${o.a2 || 0.55}" stroke-width="${o.w2 || 3.4}"/>` +
      `<path d="${d}" stroke="${c}" stroke-width="${o.w3 || 1.4}"/></g></g>`
    let dot = ''
    if (o.end) {
      const [x, y] = o.end, dc = o.dot || C.core
      dot = `<circle cx="${f1(x)}" cy="${f1(y)}" r="18" fill="${g}" fill-opacity=".10"/>` +
        `<circle cx="${f1(x)}" cy="${f1(y)}" r="8.5" fill="${m}" fill-opacity=".22"/>` +
        `<circle cx="${f1(x)}" cy="${f1(y)}" r="4" fill="${dc}"/>` +
        `<circle cx="${f1(x)}" cy="${f1(y)}" r="1.6" fill="#fff"/>`
    }
    return { defs, body: body + dot }
  }

  /* 主数字：符号用几何形画（规避各种减号字形），数字用 SVG 渐变填充 */
  function hero(key, v, o) {
    const fs = o.fs, base = Math.round(fs * 0.86), h = Math.round(fs * 1.0)
    const pos = v >= 0
    const st = pos ? ['#E9FFF4', '#7CE8B2', '#2EC277'] : ['#FFE9EC', '#FF8796', '#E94A61']
    const top = base - fs * 0.72
    const bw = fs * 0.40, bt = Math.max(2.6, fs * 0.08), my = base - fs * 0.355
    const sign = `<rect x="0" y="${f1(my - bt / 2)}" width="${f1(bw)}" height="${f1(bt)}" rx="${f1(bt * 0.18)}"/>` +
      (pos ? `<rect x="${f1(bw / 2 - bt / 2)}" y="${f1(my - bw / 2)}" width="${f1(bt)}" height="${f1(bw)}" rx="${f1(bt * 0.18)}"/>` : '')
    const tx = f1(bw + fs * 0.045)
    return `<svg class="scope-hero" width="312" height="${h}" viewBox="0 0 312 ${h}" style="overflow:visible">` +
      `<defs><linearGradient id="${key}-hg" gradientUnits="userSpaceOnUse" x1="0" y1="${f1(top)}" x2="0" y2="${base}"><stop offset="0" stop-color="${st[0]}"/><stop offset=".55" stop-color="${st[1]}"/><stop offset="1" stop-color="${st[2]}"/></linearGradient></defs>` +
      `<g fill="url(#${key}-hg)">${sign}<text x="${tx}" y="${base}" style="font-family:${NUM};font-weight:640;font-stretch:${o.stretch || 100}%;letter-spacing:-.02em;font-variant-numeric:tabular-nums" font-size="${fs}">${o.main}` +
      `<tspan font-size="${o.fs2}" dx="${o.gap || 6}" fill="${o.tailFill || '#8E89A6'}" style="font-weight:600;letter-spacing:.04em">${o.tail}</tspan></text></g></svg>`
  }

  function brand() {
    return `<div class="scope-brand"><span class="scope-mark"><img src="/logo-256.png" alt=""></span><span><b>信号实验室</b><i>SIGNAL LAB</i></span></div>`
  }
  function footer(cta) {
    const u = D().user
    return `<footer class="scope-ft"><div class="scope-who"><b>${cta}</b><span><em>${u.name}</em>${u.code ? `<em>${D().L.invite} <u>${u.code}</u></em>` : ''}</span></div>` +
      `<div class="scope-qr">${window.PX.qr(u.link, 56, '#0A0910', '#F2F0F7')}</div></footer>`
  }
  const card = (type, inner, style) => `<article class="sl-card sl-scope sl-scope-${type}"${style ? ` style="${style}"` : ''}>${inner}</article>`
  const fact = (a, b) => `<div class="scope-facts">${a ? `<span>${a}</span>` : ''}<span>${b}</span></div>`
  const numSpan = (s) => `<span class="scope-n">${s}</span>`

  /* 把一串数值映射成卡面坐标 */
  function mapLine(vals, x0, x1, yTop, yBot) {
    let lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals)
    if (hi - lo < 1e-9) hi = lo + 1
    return vals.map((v, i) => [x0 + (x1 - x0) * i / (vals.length - 1), yBot - (v - lo) / (hi - lo) * (yBot - yTop)])
  }

  // 轻微低通：保留走势和起伏，去掉锯齿感，首尾不动
  const calm = (a) => a.map((v, i) => (i === 0 || i === a.length - 1) ? v : v * 0.5 + (a[i - 1] + 2 * v + a[i + 1]) / 8)

  function heroSize(str) { return str.length <= 6 ? 70 : str.length <= 8 ? 60 : 54 }

  /* ---------- A 单笔战报 ---------- */
  function cardA(s) {
    const t = D().trades[s.mode], k = s.key
    const sideSign = t.side === 'SELL' ? -1 : 1
    // 持仓盈亏轨迹：由价格路径换算，赚钱向上、亏钱向下
    const pnl = calm(t.path.map((p) => (p - t.path[0]) * sideSign))
    const pts = mapLine(pnl, -4, 312, 238, 340)
    const d = smooth(pts)
    const end = pts[pts.length - 1]
    const sig = signal(k, d, { end, fx0: 0, fx1: 170, dot: t.pnl >= 0 ? '#C9F7DF' : '#FFC2CA' })
    const main = s.privacy ? D().fmt(t.pct, 2).slice(1) : D().fmt(t.pnl, 2).slice(1)
    const tail = s.privacy ? '%' : 'USD'
    const fs = s.privacy ? 80 : heroSize(main)
    const loss = t.pnl < 0
    const inner =
      `<div class="scope-bg" style="background:radial-gradient(240px 170px at ${f1(end[0])}px ${f1(end[1])}px, rgba(90,34,238,.26), rgba(90,34,238,0) 70%)"></div>` +
      brand() +
      `<div class="scope-meta" style="top:100px"><span class="scope-ins">${numSpan(t.symbol)} ${t.sideTxt}</span>${loss ? `<span class="scope-tag"><i></i>${t.exit}</span>` : ''}</div>` +
      `<div class="scope-num" data-fit="left" style="top:124px">${hero(k, t.pnl, { fs, main, tail, fs2: s.privacy ? Math.round(fs * 0.5) : 15, gap: s.privacy ? 2 : 8, tailFill: s.privacy ? `url(#${k}-hg)` : null })}</div>` +
      fact(t.pips == null ? '' : `${numSpan(D().fmt(t.pips, 1))} ${D().L.pips}`, `${D().L.hold} ${t.hold.replace(/(\d+)/g, '<span class="scope-n">$1</span>')}`).replace('class="scope-facts"', 'class="scope-facts" style="top:' + Math.round(124 + fs * 0.86 + 20) + 'px"') +
      `<svg class="scope-sig" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs>${sig.defs}</defs>${sig.body}</svg>` +
      footer(D().L.ctaJoin)
    return card('A', inner)
  }

  /* ---------- C 月度成绩单 ---------- */
  function cardC(s) {
    const m = D().month(s.mode), k = s.key
    let acc = 0
    const eq = [0]
    m.days.forEach((v) => { if (v !== 0) { acc += v; eq.push(acc) } })
    const pts = mapLine(calm(eq), -4, 312, 238, 340)
    const d = smooth(pts, 0.4)
    const end = pts[pts.length - 1]
    const sig = signal(k, d, { end, fx0: 0, fx1: 120, dot: m.total >= 0 ? '#C9F7DF' : '#FFC2CA' })
    const v = s.privacy ? m.pct : m.total
    const main = D().fmt(v, s.privacy ? 1 : 2).slice(1)
    const fs = s.privacy ? 80 : heroSize(main)
    const inner =
      `<div class="scope-bg" style="background:radial-gradient(240px 170px at ${f1(end[0])}px ${f1(end[1])}px, rgba(90,34,238,.26), rgba(90,34,238,0) 70%)"></div>` +
      brand() +
      `<div class="scope-meta" style="top:100px"><span class="scope-ins">${D().L.monthLabel}</span></div>` +
      `<div class="scope-num" data-fit="left" style="top:124px">${hero(k, v, { fs, main, tail: s.privacy ? '%' : 'USD', fs2: s.privacy ? 40 : 15, gap: s.privacy ? 2 : 8, tailFill: s.privacy ? `url(#${k}-hg)` : null })}</div>` +
      fact(`${D().L.winRate} ${numSpan(m.winRate.toFixed(1) + '%')}`, `${numSpan(m.trades)} ${D().L.tradesUnit}`).replace('class="scope-facts"', 'class="scope-facts" style="top:' + Math.round(124 + fs * 0.86 + 20) + 'px"') +
      `<svg class="scope-sig" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs>${sig.defs}</defs>${sig.body}</svg>` +
      footer(D().L.ctaJoin)
    return card('C', inner)
  }

  /* ---------- B 勋章奖状 ---------- */
  const LIGHT = {
    bronze:  { bg: '#0D0806', l1: 'rgba(214,140,82,.30)', l2: 'rgba(214,140,82,0)', glow: '#B8692F', mid: '#E2A06A', core: '#FFE6D2' },
    silver:  { bg: '#08090D', l1: 'rgba(196,208,232,.24)', l2: 'rgba(196,208,232,0)', glow: '#6E7BA0', mid: '#C9D3EA', core: '#FFFFFF' },
    gold:    { bg: '#0D0A05', l1: 'rgba(236,196,104,.30)', l2: 'rgba(236,196,104,0)', glow: '#B07F22', mid: '#F0CD78', core: '#FFF6DA' },
    legend:  { bg: '#0B0612', l1: 'rgba(240,200,110,.34)', l2: 'rgba(110,60,255,0)', glow: '#6A3BFF', mid: '#F0CD78', core: '#FFF8E4', ring: true },
    limited: { bg: '#0D0506', l1: 'rgba(196,72,60,.32)', l2: 'rgba(196,72,60,0)', glow: '#9E2A26', mid: '#E0866A', core: '#FFE2D8' },
  }
  function cardB(s) {
    const md = D().medals[s.medal] || D().medals.winning_hand, k = s.key
    const L = LIGHT[md.material] || LIGHT.gold
    const cx = 180, cy = 170, ms = 172
    const ex = cx - ms * 0.40 // 信号线落进勋章的位置
    const y = cy
    // 心电式脉冲：平稳，一次 P 波，一次尖锐 QRS，一次 T 波，然后归于勋章
    const P = [[-6, y], [18, y], [26, y - 5], [34, y], [42, y], [47, y + 7], [54, y - 46], [61, y + 16], [66, y], [76, y], [86, y - 9], [96, y], [ex, y]]
    const d = poly(P)
    const sig = signal(k, d, { glow: L.glow, mid: L.mid, core: L.core, fx0: 0, fx1: 60, w1: 9, w2: 3, w3: 1.3 })
    const medal = window.PX.medal(md.id, md.tier, ms, k)
    const tier = md.tierTxt.replace(/\s*[IVX]+$/, '')
    const rare = (md.rarity < 20 ? D().L.rareBefore : D().L.commonBefore) + `<span class="scope-n">${md.rarity}%</span>` + D().L.rarityAfter
    const halo = `radial-gradient(150px 150px at ${cx}px ${cy}px, ${L.l1}, ${L.l2} 100%)` +
      (L.ring ? `, radial-gradient(260px 230px at ${cx}px ${cy}px, rgba(106,59,255,.30), rgba(106,59,255,0) 100%)` : '')
    const ring = L.ring ? `<circle cx="${cx}" cy="${cy}" r="${ms * 0.56}" fill="none" stroke="#F0CD78" stroke-opacity=".22" stroke-width=".8"/><circle cx="${cx}" cy="${cy}" r="${ms * 0.66}" fill="none" stroke="#9B86FF" stroke-opacity=".14" stroke-width=".8"/>` : ''
    const inner =
      `<div class="scope-bg" style="background:${halo}"></div>` +
      `<svg class="scope-sig" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs>${sig.defs}</defs>${ring}${sig.body}</svg>` +
      `<div class="scope-medal" style="left:${cx - ms / 2}px;top:${cy - ms / 2}px">${medal}</div>` +
      brand() +
      `<div class="scope-badge"><b>${md.name}</b><span>${tier}</span></div>` +
      `<div class="scope-rare">${rare}</div>` +
      footer(D().L.ctaJoin)
    return card('B', inner, `background:${L.bg}`)
  }

  /* ---------- D 比赛名次 ---------- */
  function cardD(s) {
    const c = D().comp, k = s.key
    const y = 298, px = 286, py = 128
    const P = [[-6, y], [150, y], [196, y - 3], [226, y + 2], [252, y], [px - 14, y], [px, py], [px + 13, y + 10], [px + 22, y], [366, y]]
    const d = poly(P)
    const sig = signal(k, d, { end: [px, py], fx0: 0, fx1: 190, w3: 1.3 })
    const inner =
      `<div class="scope-bg" style="background:radial-gradient(220px 220px at ${px}px ${py}px, rgba(90,34,238,.30), rgba(90,34,238,0) 70%)"></div>` +
      `<svg class="scope-sig" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs>${sig.defs}</defs>${sig.body}</svg>` +
      brand() +
      `<div class="scope-comp">${c.name}</div>` +
      `<div class="scope-rank"><b>${c.rank}</b><i>${c.rankSuffix}</i></div>` +
      fact(`${D().L.ret} ${numSpan(D().fmt(c.ret, 2) + '%')}`, `${numSpan(c.participants)} ${D().L.participantsUnit}`).replace('class="scope-facts"', 'class="scope-facts" style="top:318px"') +
      footer(D().L.ctaComp)
    return card('D', inner)
  }

  const CJK = "'PingFang SC','Noto Sans SC','Microsoft YaHei',sans-serif"
  const css = `
.sl-scope{position:relative;width:360px;height:450px;overflow:hidden;border-radius:22px;background:#07060B;color:#F2F0F8;font-family:${CJK};-webkit-font-smoothing:antialiased;box-sizing:border-box;isolation:isolate}
.sl-scope *{box-sizing:border-box}
.sl-scope .scope-bg{position:absolute;inset:0;pointer-events:none}
.sl-scope .scope-sig{position:absolute;left:0;top:0;overflow:visible}
.sl-scope .scope-n{font-family:${NUM};font-variant-numeric:tabular-nums;font-weight:600;letter-spacing:.01em}
.sl-scope .scope-brand{position:absolute;left:24px;top:24px;display:flex;align-items:center;gap:8px}
.sl-scope .scope-mark{position:relative;display:block;width:24px;height:28px;overflow:hidden;flex:none}
.sl-scope .scope-mark img{position:absolute;width:44px;height:44px;left:-10px;top:-3px;max-width:none;display:block}
.sl-scope .scope-brand>span:last-child{display:flex;flex-direction:column;gap:2px;line-height:1}
.sl-scope .scope-brand b{font-size:13px;font-weight:600;letter-spacing:.06em;color:#F2F0F8}
.sl-scope .scope-brand i{font-style:normal;font-family:${NUM};font-size:8px;font-weight:600;letter-spacing:.24em;color:#77718F}
.sl-scope .scope-meta{position:absolute;left:24px;right:24px;display:flex;align-items:center;justify-content:space-between;height:20px}
.sl-scope .scope-ins{font-size:13px;font-weight:500;color:#BDB8D0;letter-spacing:.04em}
.sl-scope .scope-ins .scope-n{color:#F2F0F8;letter-spacing:.06em}
.sl-scope .scope-tag{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 10px;border-radius:11px;border:1px solid rgba(255,140,155,.28);font-size:11px;color:#F3D3D8;letter-spacing:.06em}
.sl-scope .scope-tag i{width:5px;height:5px;border-radius:50%;background:${C.dn}}
.sl-scope .scope-num{position:absolute;left:23px}
.sl-scope .scope-hero{display:block}
.sl-scope .scope-facts{position:absolute;left:24px;display:flex;gap:20px;font-size:13px;color:#8F8AA8;letter-spacing:.03em}
.sl-scope .scope-facts .scope-n{color:#E4E1EE}
.sl-scope .scope-ft{position:absolute;left:24px;right:24px;bottom:24px;display:flex;align-items:flex-end;justify-content:space-between}
.sl-scope .scope-who{display:flex;flex-direction:column;gap:7px;padding-bottom:2px}
.sl-scope .scope-who b{font-size:13px;font-weight:600;color:#F2F0F8;letter-spacing:.08em}
.sl-scope .scope-who span{display:flex;gap:12px;font-size:11px;color:#8C87A3;letter-spacing:.04em}
.sl-scope .scope-who em{font-style:normal}
.sl-scope .scope-who u{text-decoration:none;font-family:${NUM};font-weight:600;letter-spacing:.12em;color:#B9B4CC}
.sl-scope .scope-qr{width:64px;height:64px;padding:4px;border-radius:8px;background:#F2F0F7;flex:none}
.sl-scope .scope-qr svg{display:block;width:56px;height:56px}
.sl-scope .scope-medal{position:absolute}
.sl-scope .scope-medal svg{display:block}
.sl-scope .scope-badge{position:absolute;left:0;right:0;top:272px;display:flex;align-items:baseline;justify-content:center;gap:10px}
.sl-scope .scope-badge b{font-size:34px;font-weight:700;letter-spacing:.12em;color:#F6F3FC;margin-right:-.12em}
.sl-scope .scope-badge span{font-size:13px;color:#A9A3C0;letter-spacing:.08em}
.sl-scope .scope-rare{position:absolute;left:0;right:0;top:320px;text-align:center;font-size:11px;color:#8A85A2;letter-spacing:.06em}
.sl-scope .scope-rare .scope-n{color:#D8D4E6}
.sl-scope .scope-comp{position:absolute;left:24px;top:78px;font-size:17px;font-weight:600;letter-spacing:.08em;color:#F2F0F8}
.sl-scope .scope-rank{position:absolute;left:13px;top:98px;display:flex;align-items:flex-start;font-family:${NUM};font-variant-numeric:tabular-nums;color:#F6F3FC;line-height:1}
.sl-scope .scope-rank b{font-size:220px;font-weight:680;letter-spacing:-.04em}
.sl-scope .scope-rank i{font-style:normal;font-size:34px;font-weight:600;margin:26px 0 0 4px;color:#A99CFF;letter-spacing:.02em}
`

  window.SL['scope'] = {
    name: '信号',
    blurb: '纯黑底上一条紫色信号线，一个大数字。像手表心率屏，也像腕表表盘。',
    css,
    render(type, state) {
      if (type === 'A') return cardA(state)
      if (type === 'B') return cardB(state)
      if (type === 'C') return cardC(state)
      return cardD(state)
    },
  }
})()

  return window.SL['scope']
}
