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
// ─────────────────────────────────────────────────────────────────────────────
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // 暖白替代纯白：暗底上的纯白文字长时间看会眩光。数值向中性 zinc 靠拢，
        // 与代码里既有的 neutral-*/zinc-* 工具类同族，避免冷暖不一。
        // Warm-ish white instead of pure white: #fff glares over long sessions.
        // Pulled toward neutral zinc so it sits in the same family as the
        // existing neutral-*/zinc-* utilities rather than fighting them.
        white: '#EDEDF0',

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
          300: '#D4D4D8',
          400: '#B4B4BC',
          500: '#9C9CA6',
        },

        // 画布：中性近黑，无紫调。/ canvas: neutral near-black, zero violet tint.
        ink: {
          950: '#09090B',
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
        prism: {
          50: '#F2EDFF',
          100: '#E3D9FF',
          200: '#C8B6FF',
          300: '#A88CFF',
          400: '#8B6CFF',
          500: '#6E42FF',
          600: '#5A22EE',
          700: '#4715C4',
          800: '#351093',
          900: '#240B63',
          950: '#15063B',
        },

        // 早期版本的「霓虹」调色板。键名保留（还有引用），但值全部去霓虹化：
        // 青/粉/黄绿原本组成一条彩虹，那是最刺眼的 AI 签名之一。现在它们要么
        // 收敛回品牌紫，要么变成低彩度的中性钢色，不再自成一套配色。
        // The old "neon" palette. Keys kept (still referenced) but every value
        // is de-neoned: cyan/pink/lime used to form a rainbow, one of the
        // loudest AI signatures. They now either collapse into the brand violet
        // or become low-chroma steel, so they no longer read as a palette.
        neon: {
          violet: '#8B6CFF',
          cyan: '#7C93B8',
          pink: '#8B6CFF',
          lime: '#8FA88C',
        },
        glow: '#8B6CFF',

        // 市场语义色。从霓虹薄荷/糖果玫瑰调深，长时间盯盘不刺眼，且在浅色
        // 与深色面上都过 AA。这两个颜色是**数据**，不是品牌色，永远不参与装饰。
        // Market semantics. Deepened from neon mint / candy rose so they don't
        // sting over a long session, and pass AA on both light and dark fills.
        // These two are *data* colours, never decorative.
        up: '#35C97A',
        down: '#F04D63',

        card: 'rgba(255,255,255,0.04)',
        line: 'rgba(255,255,255,0.08)',
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
        display: ['Archivo', '"Noto Sans SC"', 'system-ui', 'sans-serif'],
        sans: ['Archivo', '"Noto Sans SC"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
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
      fontSize: {
        '2xs': ['10px', '1.35'],
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
      fontWeight: {
        normal: '400',
        medium: '500',
        semibold: '500',
        bold: '700',
        extrabold: '700',
        black: '700',
      },

      // 圆角：四档 / four steps — 8 内嵌格 · 14 小浮层 · 24 卡片 · 999 控件。
      // 上一版是 6/10/14/20 四档但语义不同（小件/控件/卡片/大面板）：小件和
      // 控件都改成药丸之后合并成一档，腾出来的位置给「小浮层」（下拉菜单）——
      // 那是落到生产代码时才发现的一档，样本里没有这类元素。
      // 与 index.css 的 --r-tile / --r-panel / --r-lg / --r-xs 保持同值。
      borderRadius: {
        pill: '999px',
        inner: '8px',
        card: '24px',
        panel: '24px',
        float: '14px',
        // Tailwind 自带的三档也拉到同一套上：代码里 rounded-md 用了 39 次
        // （6px）、rounded-xl 29 次（12px）、rounded-2xl 2 次（16px），全都
        // 落在四档之外。rounded-lg 本身就是 8px，正好等于内嵌格档，不用动；
        // rounded-full 是 9999px，等同药丸。
        // The stock steps join the same scale; rounded-lg already equals the
        // tile step and rounded-full already equals the pill.
        md: '8px',
        xl: '14px',
        '2xl': '24px',
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
          'linear-gradient(90deg, transparent, rgba(139,108,255,0.9) 18%, rgba(237,237,240,0.9) 50%, rgba(90,34,238,0.9) 82%, transparent)',
      },

      keyframes: {
        // 只保留有理由存在的动效：进场淡入、真实状态呼吸、骨架屏微光。
        // 删掉的：float / float-slow / drift / gradient-x / marquee —— 它们都是
        // 「让页面动起来」的无动机装饰，也是移动端最贵的持续重绘来源。
        // Only motion with a reason survives: enter fades, a live-state pulse,
        // and the skeleton shimmer. Removed: float / float-slow / drift /
        // gradient-x / marquee — unmotivated "make it move" decoration and the
        // most expensive source of continuous repaint on mobile.
        'fade-in-up': {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        fadein: {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        // 实时状态指示：只在真的有「在线/推流中」语义的地方用。
        // Live-state indicator: only where "online / streaming" is a real state.
        breathe: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.45' },
        },
        shimmer: {
          '0%': { transform: 'translateX(-150%)' },
          '100%': { transform: 'translateX(150%)' },
        },
      },

      animation: {
        'fade-in-up': 'fade-in-up 0.45s cubic-bezier(0.22, 1, 0.36, 1) both',
        fadein: 'fadein 0.6s cubic-bezier(0.22, 1, 0.36, 1) both',
        breathe: 'breathe 2.4s ease-in-out infinite',
        shimmer: 'shimmer 1.8s ease-in-out infinite',
        // 兼容既有引用：不再漂浮、不再脉冲发光，退化为静态。
        // Legacy references kept alive but degraded to static: no more floating,
        // no more glow pulsing.
        float: 'none',
        'float-slow': 'none',
        'glow-pulse': 'none',
        'gradient-x': 'none',
        drift: 'none',
        'drift-slow': 'none',
        marquee: 'none',
      },
    },
  },
  plugins: [],
}
