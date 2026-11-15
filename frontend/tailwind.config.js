/** @type {import('tailwindcss').Config} */
//
// ─────────────────────────────────────────────────────────────────────────────
// PRISMX 设计令牌 / design tokens
//
// 核心原则：颜料，不是光。/ Core principle: pigment, not glow.
//
// 品牌是黑 + 紫。上一版把紫当成「发光体」用——外发光阴影、渐变文字、玻璃拟态
// 上的紫色光晕——那是 LLM 生成界面的默认视觉签名，也是这次重做要清掉的东西。
// 这一版把同一个色相当成**油墨**用：实色面、硬边、1px 发丝线，紫色从不照亮
// 周围的像素。中性黑（zinc 系）取代原来的紫调黑，好让紫成为整页上唯一的彩度，
// 对比度自己会把「高级感」做出来，不需要靠光晕堆。
//
// The brand is black + violet. The previous version used violet as a *light
// source* — outer glow shadows, gradient text, purple halos on frosted glass —
// which is the default visual signature of LLM-generated UI and the main thing
// this redesign removes. This version uses the same hue as *ink*: flat fills,
// hard edges, 1px hairlines, and violet never illuminates neighbouring pixels.
// The canvas moved from violet-tinted black to a neutral zinc black so violet
// is the only chroma on the page; the contrast does the work that glow used to
// fake.
//
// ─────────────────────────────────────────────────────────────────────────────
// 颜色的真源在 src/styles/tokens.css，不在本文件。
//
// 2026-09-19 之前这里存了一份自己的十六进制，和 tokens.css 那份各自演进，结果
// 是涨跌色有四个值同时在跑：排行榜同一行里，`text-up`（当时 #35C97A）和它旁边
// `background: var(--up)`（#3AD584）的幅度条是两种绿；`prism.400` 同理停在被实测
// 判定为 4.49（不过 AA）的 #8B6CFF，而 `--purple-hi` 早已抬到 #9284FF。
//
// 现在凡是**两边都有**的颜色，这里一律用下面的 `token()` 去读 CSS 变量，本文件
// 不再存值。只有 Tailwind 单独用得到的色阶（prism 的 50/100/700/800/950、
// ink 的中间档、neutral.400）才留十六进制——它们没有 CSS 变量对应物，不构成双轨。
//
// Colour's single source of truth is src/styles/tokens.css, not this file.
// Until 2026-09-19 this file kept its own hex copies and the two drifted: four
// up/down values were live at once (a leaderboard row rendered `text-up` and a
// `var(--up)` bar in two different greens), and `prism.400` sat on a tone
// measured at 4.49 — below AA — long after `--purple-hi` had been lifted.
// Every colour that exists on both sides now goes through `token()` below.
// Only Tailwind-exclusive rungs keep literal hex, since they duplicate nothing.
// ─────────────────────────────────────────────────────────────────────────────

// tokens.css 的每个颜色都带一个通道三元组（`--up-rgb: 58 213 132`）。Tailwind v3
// 的 `/opacity` 修饰符只有拿到可拆解的颜色才生效——直接给它 `var(--up)` 字符串，
// `bg-up/15` 会静默丢掉那个 15%（全站约 140 处这种写法）。函数形式两种情况都覆盖：
// 无修饰符出 `rgb(var(--up-rgb))`，带修饰符出 `rgb(var(--up-rgb) / 0.15)`。
// Each colour in tokens.css also exposes a channel triplet. Tailwind v3 can only
// apply an opacity modifier to a colour it can decompose, so a bare
// `var(--up)` string would make `bg-up/15` silently drop its 15% (~140 call
// sites). The function form covers both shapes.
const token = (name) => ({ opacityValue }) =>
  opacityValue === undefined ? `rgb(var(${name}))` : `rgb(var(${name}) / ${opacityValue})`

export default {
  // hover: / group-hover: / peer-hover: 只在真有鼠标的设备上生效。触屏（Android
  // WebView、iOS）点一下会触发 :hover 并且一直粘到下一次点别处，不加门槛的话
  // 点过的按钮会停在高亮状态。编译结果是 @media (hover: hover) and (pointer: fine)，
  // 手写 CSS 里的 :hover 用同一个条件（见 styles/layer-base.css 的按下反馈注释）。
  // hover variants apply only on devices with a real mouse. On touch a tap triggers
  // :hover and it sticks until the next tap elsewhere. Compiles to
  // @media (hover: hover) and (pointer: fine); hand-written CSS uses the same query.
  future: { hoverOnlyWhenSupported: true },
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // 暖白替代纯白：暗底上的纯白文字长时间看会眩光。数值向中性 zinc 靠拢，
        // 与代码里既有的 neutral-*/zinc-* 工具类同族，避免冷暖不一。
        // Warm-ish white instead of pure white: #fff glares over long sessions.
        // Pulled toward neutral zinc so it sits in the same family as the
        // existing neutral-*/zinc-* utilities rather than fighting them.
        // = tokens.css --text
        white: token('--text-rgb'),

        // neutral-400 / 500 跟着卡面一起抬。
        // 这两个键是全站二级 / 三级文字的地板。卡面从 #101012 抬到 #1B1B21
        // 之后，原值 #84848E 在新面上掉到 4.32、stock 的 neutral-400 (#A3A3A3)
        // 压在 .tag 的 5% 白底上只有 4.07——都跌破 AA。
        // 与 index.css 的 --text-3 / --text-2 保持同值，避免「同一档灰有两个
        // 来源」这种事再发生（原来 --text-2 是 #A1A1AA，而代码里实际用的是
        // Tailwind 的 neutral-300 #D4D4D8，两者差了一整档）。
        // Both keys are the floor for secondary/tertiary text. They move up with
        // the surface, and now match --text-2 / --text-3 exactly.
        neutral: {
          // 100 / 200 原本落在 Tailwind stock 值（#F5F5F5 / #E5E5E5），一个比 `text-white`
          // （= --text #EDEDF0）亮半档、一个暗半档，全站 347 处。2026-11-15 改读令牌：
          // 100 = 强调白（--text-strong），200 = 正文白（--text）。
          // 100 / 200 were stock (#F5F5F5 / #E5E5E5), half a step either side of
          // `text-white` (--text) across 347 call sites. Now 100 = --text-strong,
          // 200 = --text.
          100: token('--text-strong-rgb'),
          200: token('--text-rgb'),
          300: token('--text-2-rgb'),
          // 400 没有 CSS 变量对应物（--text-2 与 --text-3 之间那一档只有 Tailwind
          // 用得到），留十六进制。/ No token twin; Tailwind-only rung.
          400: '#B4B4BC',
          500: token('--text-3-rgb'),
        },

        // 画布：中性近黑，无紫调。/ canvas: neutral near-black, zero violet tint.
        ink: {
          950: token('--bg-rgb'),
          900: '#0C0C0E',
          850: '#101012',
          800: '#141417',
          700: '#1C1C21',
          600: '#26262C',
        },

        // 品牌紫（油墨）。色相比 Tailwind violet 更蓝、明度更低，读起来像
        // 印刷专色而不是 CSS 默认值。600 是主颜料（按钮/色块），400 是暗底上
        // 的可读强调文字色（对 #09090B 约 5.4:1，过 AA）。
        // Brand violet, as ink. Bluer hue and lower lightness than Tailwind's
        // violet so it reads as a spot colour, not a framework default. 600 is
        // the primary pigment (buttons, filled fields); 400 is the accent text
        // tone on dark (~5.4:1 against #09090B, passes AA).
        // 有 CSS 变量对应物的六档走 token()，其余色阶是 Tailwind 独有的，留值。
        // The six rungs that also exist as tokens read them; the rest are
        // Tailwind-exclusive and keep their literals.
        prism: {
          50: '#F2EDFF',
          100: '#E3D9FF',
          200: token('--purple-pale-rgb'),
          300: token('--purple-soft-rgb'),
          400: token('--purple-hi-rgb'),
          500: token('--purple-vivid-rgb'),
          600: token('--purple-rgb'),
          700: '#4715C4',
          800: '#351093',
          900: token('--purple-deep-rgb'),
          950: '#15063B',
        },

        // 早期版本的「霓虹」调色板。键名保留（还有引用），但值全部去霓虹化：
        // 青/粉/黄绿原本组成一条彩虹，那是最刺眼的 AI 签名之一。现在它们要么
        // 收敛回品牌紫，要么变成低彩度的中性钢色，不再自成一套配色。
        // The old "neon" palette. Keys kept (still referenced) but every value
        // is de-neoned: cyan/pink/lime used to form a rainbow, one of the
        // loudest AI signatures. They now either collapse into the brand violet
        // or become low-chroma steel, so they no longer read as a palette.
        // 2026-09-19 复查：`neon-*` 与 `glow` 在 src/ 与 index.html 里**已经一个
        // 调用点都没有了**（上面那句「还有引用」是留到过期的注释）。键先不删，
        // 但值改成跟着 --purple-hi 走，免得哪天有人用回来时又拿到停在 4.49 的旧紫。
        // Re-checked 2026-09-19: `neon-*` and `glow` now have zero call sites (the
        // "still referenced" note above had gone stale). The keys stay for now but
        // track --purple-hi, so a future caller cannot resurrect the sub-AA violet.
        neon: {
          violet: token('--purple-hi-rgb'),
          cyan: '#7C93B8',
          pink: token('--purple-hi-rgb'),
          lime: '#8FA88C',
        },
        glow: token('--purple-hi-rgb'),

        // 市场语义色。从霓虹薄荷/糖果玫瑰调深，长时间盯盘不刺眼，且在浅色
        // 与深色面上都过 AA。这两个颜色是**数据**，不是品牌色，永远不参与装饰。
        // Market semantics. Deepened from neon mint / candy rose so they don't
        // sting over a long session, and pass AA on both light and dark fills.
        // These two are *data* colours, never decorative.
        up: token('--up-rgb'),
        down: token('--down-rgb'),
        // 中间档（胜率 40–50%）与金：此前只有 CSS 变量，没有 Tailwind 键，于是
        // TSX 里出现了 `bg-[#E0A83C]` 这种硬编码（落地页试用金条、登录页提示条），
        // 注释还写着「既有 token --gold」。补上键，硬编码就有地方归位。
        // The mid band and gold existed only as CSS variables, so TSX reached for
        // `bg-[#E0A83C]` literals while the comment next to them claimed a token
        // was in use. Adding the keys gives those literals somewhere to go.
        mid: token('--mid-rgb'),
        gold: token('--gold-rgb'),
        // 告警色（= tokens.css --warn）。提醒 / 待处理 / 过期一律用 warn，amber-* 已退役。
        // Warning tone (= --warn). Every notice uses warn; amber-* is retired.
        warn: token('--warn-rgb'),
        // 强调白（= --text-strong #FFF）。`text-white` 读的是 --text，是正文色不是强调。
        // Emphasis white (= --text-strong). `text-white` is body text (--text), not emphasis.
        strong: token('--text-strong-rgb'),
        // 发丝线（= --line）。原来写死 0.08，与 --line 的 0.07 差一档；card 键 0 处使用，已删。
        // Hairline (= --line); it was a hard-coded 0.08. The unused card key was removed.
        line: 'var(--line)',
      },

      fontFamily: {
        // Archivo 是可变字体，带宽度轴（wdth 62–125）。标题用扩展字宽 + 重字重
        // 拿到海报式的编辑感，界面用标准字宽保持中性——一套字体覆盖两种语气，
        // 比换一支「显示字体」更省带宽也更统一。
        // 中文单独指定 Noto Sans SC：上一版 display 栈是 Space Grotesk，没有汉字
        // 字形，中文实际掉到系统 PingFang/雅黑，中英混排时字重和字面大小对不上，
        // 这是真实缺陷而不只是审美问题。
        // Archivo is variable with a width axis (wdth 62–125). Headlines use the
        // expanded widths at heavy weights for a poster/editorial voice; UI uses
        // the normal width and stays neutral — one family covering both registers
        // costs less bandwidth than adding a separate display face.
        // Noto Sans SC is listed explicitly for Chinese: the previous display
        // stack was Space Grotesk, which has no CJK glyphs, so Chinese silently
        // fell back to the system PingFang/YaHei and mismatched the Latin in both
        // weight and apparent size. That was a real defect, not a taste call.
        // 2026-09-13 起 Archivo / JetBrains Mono 自托管（src/styles/fonts.css），
        // Google Fonts 那条 render-blocking 外链已删——它在大陆是黑洞，卡首屏几十秒。
        // Noto Sans SC 刻意不进包（303 个子集、数 MB），中文交给系统 CJK：Android
        // 自带 Noto Sans CJK，iOS PingFang，Windows 雅黑。
        // Self-hosted since 2026-09-13; the Google Fonts link is gone (black-holed
        // in mainland China). Noto Sans SC deliberately not bundled; system CJK.
        display: ['Archivo', '"Noto Sans SC"', '"Noto Sans CJK SC"', '"Source Han Sans SC"', '"PingFang SC"', '"Microsoft YaHei"', 'system-ui', 'sans-serif'],
        sans: ['Archivo', '"Noto Sans SC"', '"Noto Sans CJK SC"', '"Source Han Sans SC"', '"PingFang SC"', '"Microsoft YaHei"', 'system-ui', 'sans-serif'],
        // 等宽栈的唯一来源是 tokens.css 的 --font-mono（补了中文字体，见那里的注释）。
        // The mono stack lives in tokens.css (--font-mono, with CJK faces); read it, don't copy it.
        mono: ['var(--font-mono)'],
      },

      // ── 字号阶梯：九档 / nine steps ──
      // 实测登录后界面在用 20 种字号，其中五对只差 4–5%：11/11.5、12/12.5、
      // 13/13.5、19/20、26/27。4% 的差**低于可感知的层级阈值，却高于零**——
      // 看不出「更重要」，只看得出「没对齐」。它们是历史遗留，不是设计决定。
      //
      // 在这里覆盖 Tailwind 的默认阶梯，880 处命名类（text-sm 263 次、text-xs
      // 316 次……）一次对齐，不用改任何 TSX。行高一并定死：1.35 单行 UI
      // （汉字比拉丁需要更松，1.2 会顶到边）、1.1 展示级数字。
      //
      // Overriding the stock scale aligns ~880 named-class call sites at once.
      // The app was using 20 distinct sizes, five pairs of which differed by
      // only 4–5% — below the threshold where size reads as hierarchy, above
      // the threshold where it reads as misalignment.
      // 映射原则是**就近对齐**，不是整体压缩：每个命名类落到阶梯上离它原值
      // 最近的一档（sm 14→13、base 16→15、lg 18→17、2xl 24→26），
      // 这样 880 处调用点的观感几乎不动，动的只是「有多少种字号」。
      // 若整体下移一档（sm→12、xs→11），全站正文会小一号——那不是这次要做的事。
      // Named steps snap to the *nearest* rung, not one rung down: the point is
      // to reduce how many sizes exist, not to shrink the whole UI.
      // 2026-11-15 起 2xs 并到 12px：正文最小 12px，10px 在手机上读不清。
      // Since 2026-11-15 2xs folds into 12px: body text bottoms out at 12px.
      fontSize: {
        '2xs': ['12px', '1.35'],
        xs: ['12px', '1.35'],
        sm: ['13px', '1.4'],
        base: ['15px', '1.45'],
        lg: ['17px', '1.35'],
        xl: ['20px', '1.25'],
        '2xl': ['26px', '1.15'],
        '3xl': ['26px', '1.15'],
        '4xl': ['40px', '1.1'],
        '5xl': ['40px', '1.1'],
      },

      // ── 间距：一律落在 4px 网格 / everything on a 4px grid ──
      // 实测一屏之内出现 gap 5/6/8/9/10/16 和五种 padding 组合，没有可辨识的
      // 阶梯。间距是分组的**主要**手段——值一多，眼睛就分不出「这两个是一组」。
      //
      // Tailwind 的整数档（4/8/12/16/20/24…）本来就在 4px 网格上，真正的乱源是
      // 分数档：0.5=2px、1.5=6px、2.5=10px、3.5=14px，它们落在 2px 网格上。
      // 全站共约 450 处在用（py-1.5 61 次、p-5 43 次、gap-1.5 39 次……）。
      // 把这四个键重定义到最近的 4px 档，450 处一次对齐，零 TSX 改动。
      //
      // 只动分数档、不把 20px 强推到 24px：那会改变密度，而 20 本来就合规。
      // Only the fractional steps are off-grid; snapping those four keys fixes
      // ~450 call sites without touching a single component.
      spacing: {
        0.5: '4px',
        1.5: '8px',
        2.5: '12px',
        3.5: '16px',
      },

      // ── 字重：三档 / three steps ──
      // 实测在用 400/500/600/700/800 五档，其中 500/600/700/800 是四档
      // 「半粗到粗」，600（81 次）与 700（284 次）在多数位置可以互换。
      // 收敛成 400 正文 / 500 标签与控件 / 700 数值与标题。
      // 选 400-500-700 而不是 400-600-700：后者两档挨太近，收敛了等于没收敛。
      //
      // 在这里重定义 semibold 与 extrabold，所有 font-semibold / font-extrabold
      // 调用点一起走，不用改 TSX。
      // Redefining semibold/extrabold collapses every call site at once.
      //
      // 2026-11-15 起 bold / extrabold / black 也落到 500：层级只靠字号和灰阶，
      // 粗体会让每个标题和价格都在喊。样式表里的 700–900 同步改成 500。
      // Since 2026-11-15 bold / extrabold / black land on 500 too: hierarchy comes
      // from size and grey steps, not weight. The stylesheets' 700–900 follow.
      //
      // 样式表里的 600 也收到 500（计划 030）。例外只有两类：JetBrains Mono 里只放数字或
      // 拉丁代码的规则（价格、盈亏、计数、品种代码）保留 600，它们不会落到系统中文字体，
      // 600 渲染的就是字体自带的半粗；节日美术和顶栏 LIVE / JOIN 金属字是装饰图形。
      // 可能出现中文的文字一律 500：微软雅黑只有 Regular / Bold，600 会直接跳成全粗。
      // The stylesheets' 600 went to 500 as well (plan 030). Two exceptions only:
      // JetBrains Mono rules holding nothing but digits or Latin codes (prices, P/L,
      // counts, symbols) keep 600, since they never fall back to a CJK face and 600
      // renders the font's own semibold; festival art and the top-bar LIVE / JOIN
      // metal word are decoration. Anything that may hold Chinese is 500: Microsoft
      // YaHei has only Regular and Bold, so 600 jumps straight to Bold.
      //
      // 裸 <b> / <strong> 的浏览器默认是 bold（700），不走这里；layer-base.css 里另有一条
      // b, strong { font-weight: 500 } 把它们也收到同一档。
      // Bare <b> / <strong> default to bold (700) in the UA sheet and never touch this
      // scale; layer-base.css sets b, strong { font-weight: 500 } to match.
      fontWeight: {
        normal: '400',
        medium: '500',
        semibold: '500',
        bold: '500',
        extrabold: '500',
        black: '500',
      },

      // ── 圆角：真源在 tokens.css，这里只读变量 / radius: tokens.css is the source ──
      // ⚠ Tailwind 的键名与 CSS 变量名**不同名**，按这张表对照：
      //   rounded-lg      = --r-tile   8   内嵌格 / 小件
      //   rounded-control = --r-md    10   控件（按钮 / 输入 / 分段）
      //   rounded-panel   = --r-panel 14   小浮层
      //   rounded-card    = --r-lg    24   卡片 / 抽屉 / 弹窗
      //   rounded         = 4px（Tailwind 默认，只给 ≤20px 高的行内标记）
      // md / xl / 2xl 三个 stock 键仍然覆盖，只是兜底：不覆盖的话 rounded-md 会回到
      // stock 的 6px、rounded-xl 回到 12px，又多出两个刻度外的值。新代码不要用这三个键。
      // 2026-11-15 收口：此前 8px 有五个名字（--r-xs / --r-tile / rounded-md / rounded-lg /
      // rounded-inner），rounded-panel 是 24 而 var(--r-panel) 是 14；pill / inner / float
      // 三个键已删，调用点改成上表的名字。
      // Tailwind key names differ from the CSS variables; use the table above.
      // md / xl / 2xl stay overridden only as guards (stock would give 6px / 12px,
      // two more off-scale values); new code should not use them. Consolidated
      // 2026-11-15: 8px used to have five names and rounded-panel (24) disagreed
      // with var(--r-panel) (14); pill / inner / float were removed.
      borderRadius: {
        lg: 'var(--r-tile)',
        control: 'var(--r-md)',
        panel: 'var(--r-panel)',
        card: 'var(--r-lg)',
        md: 'var(--r-tile)',
        xl: 'var(--r-panel)',
        '2xl': 'var(--r-lg)',
      },

      // ── 层级：真源在 tokens.css 的 --z-*，这里只读变量 / z-index reads tokens.css ──
      // TSX 里写 z-nav / z-overlay / z-menu …，不要再写 z-50 / z-[70] 这种裸数。
      // z-0 / z-10 / z-20（组件内部层序）照旧用 Tailwind 自带的。
      // Use z-nav / z-overlay / z-menu … in TSX instead of bare z-50 / z-[70];
      // z-0 / z-10 / z-20 (within-component order) stay stock.
      zIndex: {
        nav: 'var(--z-nav)',
        sticky: 'var(--z-sticky)',
        drawer: 'var(--z-drawer)',
        overlay: 'var(--z-overlay)',
        modal: 'var(--z-modal)',
        watermark: 'var(--z-watermark)',
        alert: 'var(--z-alert)',
        sheet: 'var(--z-sheet)',
        lightbox: 'var(--z-lightbox)',
        menu: 'var(--z-menu)',
        gate: 'var(--z-gate)',
        toast: 'var(--z-toast)',
        tip: 'var(--z-tip)',
      },

      // 阴影表达**高度**，不表达发光。全部中性、无彩色扩散半径。
      // 键名保留是因为代码里有 13 处 shadow-prism 引用——重新定义它，那 13 处
      // 就一起从「紫色光晕」变成「一层可信的高度」，不用逐个改。
      // Shadows express *elevation*, never emission: all neutral, no coloured
      // spread. The keys are kept because 13 call sites reference shadow-prism —
      // redefining it converts all of them from purple halo to honest elevation
      // without touching the call sites.
      boxShadow: {
        prism: '0 1px 2px rgba(0,0,0,0.4), 0 8px 24px -12px rgba(0,0,0,0.7)',
        'prism-lg': '0 2px 4px rgba(0,0,0,0.4), 0 24px 60px -20px rgba(0,0,0,0.85)',
        'neon-cyan': '0 1px 2px rgba(0,0,0,0.4)',
        'neon-pink': '0 1px 2px rgba(0,0,0,0.4)',
        glass: '0 1px 2px rgba(0,0,0,0.35)',
        'glass-lg': '0 2px 4px rgba(0,0,0,0.4), 0 24px 60px -20px rgba(0,0,0,0.8)',
      },

      backgroundImage: {
        // 网格从紫色调成白色极低透明度：紫色网格会和紫色前景元素抢彩度。
        // Grid recoloured from violet to a very low-alpha white: a violet grid
        // competes for chroma with the violet foreground elements.
        'prism-grid':
          'linear-gradient(rgba(255,255,255,0.035) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.035) 1px, transparent 1px)',
        // 保留键名但改成实色单值：任何「多档紫渐变」在标题或按钮上都是 AI 签名。
        // Key kept, value flattened to a single ink: multi-stop violet gradients
        // on headlines or buttons are the signature being removed.
        'neon-gradient': 'linear-gradient(0deg, #5A22EE, #5A22EE)',
        'glass-sheen': 'none',
        // 签名图形：光谱线。一条 1px 发丝线在指定位置裂成三条微偏移的色带，
        // 是「棱镜色散」的平面化表达——不需要 WebGL，也不发光。
        // Signature graphic: the spectral rule. A 1px hairline splitting into
        // three micro-offset bands — dispersion expressed as flat print, no
        // WebGL and no emission.
        'spectral-rule':
          'linear-gradient(90deg, transparent, rgb(var(--purple-hi-rgb) / 0.9) 18%, rgb(var(--text-rgb) / 0.9) 50%, rgb(var(--purple-rgb) / 0.9) 82%, transparent)',
      },

      // 让 `transition` / `transition-colors` 等工具类默认走项目的动效 token，而不是
      // Tailwind 自带的 150ms + cubic-bezier(0.4, 0, 0.2, 1)。全站一百多处裸 `transition`
      // 原来是另一条曲线，和 CSS 里的 var(--ease-out) 并存两套手感。显式写了
      // duration-* / ease-* 的地方不受影响。
      // Make `transition` / `transition-colors` and friends default to the project's
      // motion tokens instead of Tailwind's own 150ms + cubic-bezier(0.4, 0, 0.2, 1).
      // The 100+ bare `transition` call sites ran a second curve next to the CSS
      // var(--ease-out). Explicit duration-* / ease-* classes still win.
      transitionDuration: {
        DEFAULT: 'var(--dur-fast)',
      },
      transitionTimingFunction: {
        DEFAULT: 'var(--ease-out)',
      },

      keyframes: {
        // 只保留有理由存在的动效：进场淡入、真实状态呼吸、骨架屏微光。
        // 删掉的：float / float-slow / drift / gradient-x / marquee —— 它们都是
        // 「让页面动起来」的无动机装饰，也是移动端最贵的持续重绘来源。
        // Only motion with a reason survives: enter fades, a live-state pulse,
        // and the skeleton shimmer. Removed: float / float-slow / drift /
        // gradient-x / marquee — unmotivated "make it move" decoration and the
        // most expensive source of continuous repaint on mobile.
        //
        // fade-in-up 和 breathe 的帧只在 src/styles/keyframes.css 里定义一次。以前这里
        // 也有一份（位移 10px、呼吸低点 0.45），但 keyframes.css 在层叠里排在后面，
        // 实际生效的一直是它（8px、0.35），改这里不会有任何效果。下面的 animation
        // 只引用名字，Tailwind 找不到同名帧时不生成 @keyframes，直接沿用 keyframes.css。
        // fade-in-up and breathe frames live once, in src/styles/keyframes.css. A copy
        // used to sit here (10px travel, 0.45 low point), but keyframes.css comes later
        // in the cascade, so its 8px / 0.35 always won and editing this copy did nothing.
        // The animations below reference the names only; with no frames here Tailwind
        // emits no @keyframes and the keyframes.css ones apply.
        shimmer: {
          '0%': { transform: 'translateX(-150%)' },
          '100%': { transform: 'translateX(150%)' },
        },
      },

      animation: {
        // 填充用 backwards 而不是 both：结束后不再施加最后一帧。最后一帧本来就等于
        // 元素自身样式，看起来一样；但 both 会让残留的 transform 把元素变成
        // position: fixed 子元素的包含块，还会压住之后的 opacity 状态样式。
        // backwards, not both: once finished, the last frame is no longer applied. It
        // equals the element's own style so nothing looks different, but with both
        // the lingering transform makes the element the containing block for
        // position: fixed descendants and overrides later opacity state styles.
        'fade-in-up': 'fade-in-up var(--dur-slow) var(--ease-out) backwards',
        breathe: 'breathe 2.4s ease-in-out infinite',
        shimmer: 'shimmer 1.8s ease-in-out infinite',
      },
    },
  },
  plugins: [
    // ── inset 简写降级 / the inset shorthand, spelled out ──
    // Tailwind 的 `inset-0` 编译成 `inset: 0px`，而 `inset` 简写是 **Chrome 87+**，
    // 在本项目 Chrome 70 的下限之外。旧内核上整条声明被丢弃，元素只剩
    // `position: absolute` 而没有任何偏移——于是每一层「铺满父级」的遮罩、背景、
    // 渲染器画布都掉回静态流的位置。全站 23 处在用 `inset-*`（其中 21 处是
    // `inset-0`），几乎全是这种铺满层。
    //
    // 这里重定义 `inset-*` / `-inset-*` 这一族，改出四条长写法（`inset-x-*` 与
    // `inset-y-*` 本来就是长写法，`top-*` 等同理，都不受影响）。插件产出的工具类
    // 排在核心工具类之后、权重相同，靠源码顺序覆盖，调用点一行不用改。
    //
    // Tailwind compiles `inset-0` to `inset: 0px`, and the `inset` shorthand is
    // Chrome 87+, outside this project's Chrome 70 floor. On older engines the
    // whole declaration is dropped and the element keeps `position: absolute`
    // with no offsets, so every "cover the parent" scrim, backdrop and renderer
    // canvas falls back into static flow. 23 call sites use it, 21 of them
    // `inset-0`, and nearly all are exactly that kind of layer.
    // This redefines only the shorthand family as four longhands; `inset-x-*`,
    // `inset-y-*` and `top-*` already emit longhands and are untouched. Plugin
    // utilities are emitted after the core ones at equal specificity, so source
    // order wins and no call site changes.
    ({ matchUtilities, theme }) => {
      matchUtilities(
        {
          inset: (value) => ({ top: value, right: value, bottom: value, left: value }),
        },
        { values: theme('inset'), supportsNegativeValues: true }
      )
    },
  ],
}
