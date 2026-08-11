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

        // neutral-500 上调一档（Tailwind 原值 #737373）。
        // 这是全站「三级文字」（元信息、脚注、时间戳）的颜色，原值压在 #09090B 上
        // 只有 4.20:1（在抬升面 #101012 上更低到 4.01），卡在 WCAG AA 的 4.5 门槛下面——
        // 在室外屏幕或低亮度手机上就是读不清。#84848E 在画布 / 抬升面 / 嵌套面三层背景上
        // 分别是 5.37 / 5.13 / 4.87，全部过线，与 neutral-400（7.9:1，二级文字）之间仍有清晰的明度差。
        // 覆盖标准色阶是刻意的，与本文件里 white 的覆盖同一个理由：这两个值是全站
        // 文字对比度的地板，不能听凭框架默认值决定。
        // neutral-500 lifted one step (Tailwind ships #737373).
        // This is the tertiary text colour across the app (metadata, footnotes,
        // timestamps), and the stock value scores only 4.20:1 on #09090B — just under
        // the WCAG AA threshold of 4.5, which means genuinely unreadable on an outdoor
        // screen or a dimmed phone. #84848E scores 5.37 / 5.13 / 4.87 against the canvas,
        // raised and nested surfaces respectively, and still sits far enough below
        // neutral-400 (7.9:1, secondary text) that the hierarchy holds.
        // Overriding a stock scale step is deliberate, for the same reason as the
        // white override above: these two values are the floor for text contrast
        // everywhere, and that floor should not be left to a framework default.
        neutral: {
          500: '#84848E',
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

      // 圆角只有一套，全站遵守：6 小件 / 10 控件 / 14 卡片 / 20 大面板。
      // 上一版是 18/16/12/11/10/7px 六个数混用，没有规则，观感上就是「拼的」。
      // One radius scale, obeyed everywhere: 6 small parts / 10 controls /
      // 14 cards / 20 large panels. The previous version mixed six different
      // values with no rule, which is what makes a layout read as assembled.
      borderRadius: {
        pill: '6px',
        inner: '10px',
        card: '14px',
        panel: '20px',
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
