// 背景创意元素 / creative backdrop motifs
//
// ════════════════════════════════════════════════════════════════════════════
// hero 下方那块区域被否了六轮。前六轮全都在做同一件事而我没意识到：线阵网格、
// 摄影棚扫光、地平线光带、舞台光幕——**全部是光的分布**，换的只是亮度落在
// 哪里。用户要的从来不是「空得好看一点」，是那里应该有**东西**。
//
// 所以这一版放的是元素，不是照明。四个方向都取自页面已有的语言，不是通用装饰：
//
//   prism    棱镜折射：一道发丝光线射入三角棱镜，分成三条紫色谱带射出。
//            这正是本站签名图形 .rule-spectral（1px 发丝线裂成三条微偏移带）
//            放大到建筑尺度，也正是母品牌 PRISMX 的字面含义。
//   scale    价格标尺：左缘一根竖轴，真实刻度与真实价位（止盈/入场/止损三条
//            贯穿线取自第一幕手机屏里那条 XAUUSD 信号）。仪器感，不是装饰。
//   numerals 巨型价格：三个真实价位以巨大的描边等宽数字堆叠，从左缘出血。
//            编辑式排版，零装饰元素，而且它说的是产品自己的话。
//   candles  K 线天际线：底缘一排蜡烛剪影，产品自己的语言当成风景。
//
// 全部是平面 SVG 而不是 WebGL：这块背景连续翻车六轮，其中三轮的根因是 3D 里
// 「东西到底落在画面哪儿」我在无头环境下无法核对（相机自由度太多、变换原点
// 两套坐标系打架）。SVG 的 viewBox 是纯坐标数学，每个元素的位置在代码里就能
// 读出来、也能逐项量。定稿之后再决定要不要加视差。
//
// Six rounds on this region, and all of them were the same move without my
// noticing: line grid, studio sweep, horizon band, stage wash - every one of
// them a DISTRIBUTION OF LIGHT, differing only in where the brightness landed.
// What was wanted was never a prettier emptiness; it was something actually
// being there. So this version places elements rather than lighting, in four
// directions all drawn from the page's existing language rather than generic
// decoration: a prism splitting one hairline into three violet bands (the site's
// own .rule-spectral signature at architectural scale, and the literal meaning of
// the parent brand PRISMX); a price rule with real ticks and the real levels from
// act I's XAUUSD signal; those same prices as enormous outlined monospace
// numerals bleeding off the left edge; and a candlestick skyline along the bottom.
//
// All flat SVG rather than WebGL: three of the six failed rounds failed because
// I could not verify WHERE things landed in a 3D frame headlessly - too many
// camera degrees of freedom, and transform-origin fighting between two coordinate
// systems. An SVG viewBox is plain coordinate math, readable in the source and
// measurable item by item. Parallax can come after a direction is picked.
// ════════════════════════════════════════════════════════════════════════════

export type ArtVariant = 'none' | 'prism' | 'scale' | 'numerals' | 'candles'

/* ── 禁区 ──
   hero 文案列实测占 viewBox 的 x 101-479 / y 450-707（1440x900 下）。四个母题
   全部让开它：背景元素压在正文上就是噪点，不是创意。它们该长在 CTA 下方那块
   空地（y > 700）与手机右侧的边缘。
   The hero copy column measures x 101-479 by y 450-707 in viewBox units. All four
   motifs clear it: a backdrop element sitting on body copy is noise, not
   invention. They belong in the empty band below the CTA (y > 700) and along the
   edges beside the phone. */
export const SAFE = { x0: 101, x1: 479, y0: 450, y1: 707 }

const V1 = '#8B6CFF' // prism-400
const V2 = '#6E42FF' // prism-500
const V3 = '#B9A6FF'
const UP = '#35c97a'
const DOWN = '#f04d63'

/* 价位取自第一幕手机屏里那条 XAUUSD 信号，全站同一组数字。
   The levels come from act I's XAUUSD signal - one set of numbers site-wide. */
const LEVELS = [
  { p: '3445.60', label: '止盈', y: 236, c: UP },
  { p: '3412.80', label: '入场', y: 470, c: '#9A9AA6' },
  { p: '3398.20', label: '止损', y: 712, c: DOWN },
]

/* 确定性伪随机：背景不该每次刷新长得不一样，而且可复现才谈得上逐项核对。
   Deterministic: the backdrop should not differ per reload, and only a
   reproducible frame can be verified. */
function lcg(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

function Prism() {
  /* 棱镜置于左下，入射线从左缘水平射入，三条谱带向右下发散并穿过整个画面。
     谱带是本站 .rule-spectral 的放大版：同一条线裂成三条，各差一点点。
     The prism sits lower left, one hairline enters horizontally from the edge and
     three bands fan out across the frame - .rule-spectral enlarged: one line
     splitting into three, each a shade apart. */
  return (
    <g>
      <path d="M 196 722 L 56 996 L 396 996 Z" fill={V1} fillOpacity="0.04" stroke={V1} strokeOpacity="0.32" strokeWidth="1.5" />
      <path d="M 0 806 L 150 806" stroke="#EDEDF0" strokeOpacity="0.26" strokeWidth="1.5" />
      <path d="M 150 806 L 246 830" stroke="#EDEDF0" strokeOpacity="0.16" strokeWidth="1.5" />
      <path d="M 246 830 L 1440 762" stroke={V1} strokeOpacity="0.36" strokeWidth="2" />
      <path d="M 246 830 L 1440 838" stroke={V2} strokeOpacity="0.26" strokeWidth="2" />
      <path d="M 246 830 L 1440 914" stroke={V3} strokeOpacity="0.16" strokeWidth="2" />
    </g>
  )
}

function Scale() {
  const ticks: number[] = []
  for (let y = 150; y <= 860; y += 44) ticks.push(y)
  return (
    <g>
      {/* 价格轴放右缘而不是左缘：真实交易终端的价格轴本来就在右边，语义正确，
          而且左边整列留给文案。贯穿线从 x=500 起画，不进文案列。
          The price axis sits on the right as it does in every real terminal:
          semantically correct, and it leaves the whole left column to the type.
          The level lines start at x=500, clear of the copy. */}
      <line x1="1322" y1="130" x2="1322" y2="880" stroke="#ffffff" strokeOpacity="0.13" strokeWidth="1.5" />
      {ticks.map((y, i) => (
        <line
          key={y}
          x1={i % 4 === 0 ? 1294 : 1308}
          y1={y}
          x2="1322"
          y2={y}
          stroke="#ffffff"
          strokeOpacity={i % 4 === 0 ? 0.16 : 0.08}
          strokeWidth="1.5"
        />
      ))}
      {LEVELS.map((l) => (
        <g key={l.p}>
          <line x1="500" y1={l.y} x2="1322" y2={l.y} stroke={l.c} strokeOpacity="0.16" strokeWidth="1.5" strokeDasharray="7 11" />
          <line x1="1284" y1={l.y} x2="1342" y2={l.y} stroke={l.c} strokeOpacity="0.5" strokeWidth="2.5" />
          <text x="1356" y={l.y - 10} fontSize="15" letterSpacing="0.12em" fill={l.c} fillOpacity="0.6">
            {l.label}
          </text>
          <text x="1356" y={l.y + 24} fontSize="26" fontWeight="600" className="tnum" fill={l.c} fillOpacity="0.38">
            {l.p}
          </text>
        </g>
      ))}
    </g>
  )
}

function Numerals() {
  /* 描边而非填充：巨型实心数字会盖住手机，描边只留骨架。左缘出血让它读成
     「画面之外还有更多」，而不是一块居中的装饰。
     Outlined rather than filled: solid numerals at this size would bury the
     phone, an outline leaves only the skeleton. Bleeding off the left edge makes
     it read as continuing past the frame rather than as a centred ornament. */
  return (
    <g className="tnum" fontSize="176" fontWeight="700" fill="none" strokeWidth="1.6">
      <text x="-64" y="908" stroke={UP} strokeOpacity="0.17">
        3445.60
      </text>
      <text x="-64" y="1082" stroke="#EDEDF0" strokeOpacity="0.12">
        3412.80
      </text>
    </g>
  )
}

function Candles() {
  const rnd = lcg(20260812)
  const bars: { x: number; w: number; top: number; bot: number; hi: number; lo: number; up: boolean }[] = []
  let mid = 800
  for (let x = -30; x < 1500; x += 44) {
    mid += (rnd() - 0.48) * 46
    /* 按最坏情况倒推而不是拍脑袋：上一版夹在 740-880，但 740 减半实体 58 再减
       影线 46 = 636，整整探进禁区 71px。现在下限 765、实体 ≤60、影线 ≤26，
       最高点 765-30-26=709，刚好在 707 之下。
       Derived from the worst case rather than guessed: the previous clamp of
       740-880 gave 740 minus a 58 half-body minus a 46 wick = 636, a full 71px
       inside the reserved column. At a 765 floor with bodies capped at 60 and
       wicks at 26 the highest point is 709, just clear of 707. */
    mid = Math.max(765, Math.min(880, mid))
    const h = 20 + rnd() * 60
    const up = rnd() > 0.44
    const top = mid - h / 2
    bars.push({ x, w: 22, top, bot: top + h, hi: top - rnd() * 26, lo: top + h + rnd() * 26, up })
  }
  return (
    <g>
      {bars.map((b, i) => (
        <g key={i} fill={b.up ? UP : DOWN} fillOpacity={b.up ? 0.09 : 0.075} stroke="none">
          <rect x={b.x + b.w / 2 - 1} y={b.hi} width="2" height={b.lo - b.hi} />
          <rect x={b.x} y={b.top} width={b.w} height={b.bot - b.top} rx="2" />
        </g>
      ))}
    </g>
  )
}

/* 对齐方式按母题所依附的边来定。构图标定在 1440x900，而 slice 在竖屏上按高度
   放大（375x812 的缩放系数是 0.90），可见宽度只剩约 417 个 viewBox 单位——居中
   对齐会把左缘的棱镜与巨型数字、右缘的价格轴**整个裁掉**，四个母题里三个在真机
   上等于不存在。让每个母题锚在自己那条边上，裁的就只是它本来就要出血的部分。
   Alignment follows the edge each motif is anchored to. The composition is
   authored at 1440x900 and slice scales to height on portrait (a factor of 0.90
   at 375x812), leaving only about 417 viewBox units of visible width - centring
   would crop away the left-edge prism and numerals and the right-edge price axis
   entirely, so three of the four motifs would simply not exist on a phone.
   Anchoring each motif to its own edge crops only what it already bleeds past. */
const ALIGN: Record<Exclude<ArtVariant, 'none'>, string> = {
  prism: 'xMinYMid slice',
  scale: 'xMaxYMid slice',
  numerals: 'xMinYMid slice',
  candles: 'xMidYMid slice',
}

export default function BackdropArt({ variant }: { variant: ArtVariant }) {
  if (variant === 'none') return null
  return (
    <div className="backdrop-art" aria-hidden>
      <svg viewBox="0 0 1440 900" preserveAspectRatio={ALIGN[variant]}>
        {variant === 'prism' && <Prism />}
        {variant === 'scale' && <Scale />}
        {variant === 'numerals' && <Numerals />}
        {variant === 'candles' && <Candles />}
      </svg>
    </div>
  )
}
