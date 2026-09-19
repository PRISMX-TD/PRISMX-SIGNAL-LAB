import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // 开发期代理后端 REST 与 WebSocket
      '/api': { target: 'http://localhost:8000', changeOrigin: true },
      '/ws': { target: 'ws://localhost:8000', ws: true },
    },
  },
  build: {
    // 产物的语法下限：Chrome / 安卓 WebView 70（2018 年 10 月）、Safari 12、Firefox 68。
    //
    // Vite 默认是 'modules'（≈ Chrome 87），会把 `??` / `?.` / 类字段原样留在产物里——
    // 2020 年以前的引擎见到 `??` 直接语法错误，整个入口跑不起来，用户看到的是永久白屏；
    // 更新一点但不够新的（Chrome 80–94）能跑起来，却会在别处崩（见 winrate/shared.ts
    // 的 zoneOffsetMinutes）。大陆老手机（EMUI 9/10 的华为、没有 Play 服务因而 WebView
    // 停在出厂版本的机器）正是这个区间。esbuild 只降语法，运行时 API 由 src/polyfills.ts
    // 补，两者缺一不可。
    //
    // 代价：产物大约多几个百分点（可选链展开成 != null 判断、类字段展开成构造函数赋值）。
    // 不用 @vitejs/plugin-legacy：那是给不支持 ES 模块的浏览器（Chrome < 61）准备的双份
    // 产物 + SystemJS，体积和复杂度都翻倍，而这里要救的机器都支持模块，只是缺几个语法。
    //
    // Syntax floor for the build output: Chrome / Android WebView 70 (Oct 2018),
    // Safari 12, Firefox 68. Vite's default 'modules' (≈ Chrome 87) leaves `??` /
    // `?.` / class fields in place; pre-2020 engines hit a SyntaxError on `??` and
    // the entry never runs — a permanent blank page. Engines from Chrome 80–94 run
    // but break elsewhere (zoneOffsetMinutes in winrate/shared.ts). Older mainland
    // phones (Huawei on EMUI 9/10, devices without Play services whose WebView is
    // frozen at the factory build) sit exactly in that range. esbuild lowers syntax
    // only; runtime APIs come from src/polyfills.ts. Not plugin-legacy: that is for
    // browsers without ES modules (Chrome < 61), doubling output with SystemJS,
    // while every device we care about has modules and only lacks a few features.
    target: ['es2018', 'chrome70', 'safari12', 'firefox68', 'edge79'],
    rollupOptions: {
      output: {
        // 手动分包：把体积巨大的第三方库拆成独立、可长期缓存的 chunk，避免它们
        // 混进共享包里拖慢首屏，也让某个库升级时只失效对应 chunk 的缓存。
        // lightweight-charts 只在懒加载的图表路由里用到，单独成块后不进首屏关键路径。
        // Manual chunking: split the heavy third-party libs into their own,
        // long-cacheable chunks so they don't bloat the shared bundle or the first
        // paint, and so upgrading one only busts that chunk's cache.
        // lightweight-charts is only pulled in by its own lazy route, so isolating
        // it keeps it off the initial critical path.
        //
        // three 的分支曾在删除落地页 3D 棱镜场景时一并移除，现在又回来了：落地页
        // 的手机机身改用 WebGL 物理材质渲染（见 components/landing/PhoneGL.ts），
        // 但它是 PhoneStory 里的动态 import，只在桌面 scrub 模式下加载。独立成块
        // 因此是必要的——否则 three 会被并进首屏包，抵消掉懒加载的全部意义。
        // three's branch was removed when the landing page's 3D prism scene was
        // cut; it is back because the phone body is now rendered with WebGL
        // physical materials (see components/landing/PhoneGL.ts). It is a dynamic
        // import inside PhoneStory and only loads in desktop scrub mode, so its
        // own chunk is required - otherwise three would be folded into the
        // initial bundle and negate the lazy loading entirely.
        // 匹配式一律带包目录边界（`/node_modules/<pkg>/`），不要裸子串。
        //
        // 原来是 `id.includes('three')`：那是对**完整路径**做子串匹配，任何路径里
        // 恰好含 "three" 的依赖都会被塞进 three 块——将来新增的 `three-*` 子包、
        // 或名字里带 three 的传递依赖都会误伤，而误伤的表现是首屏包里多出一个跟
        // 3D 毫无关系的库、或者 three 块里少了本该在的东西，两种都很难一眼看出。
        // lightweight-charts 同理。Rollup 的 id 是规范化过的 posix 路径（Windows
        // 上也是正斜杠），所以这个判据跨平台成立。
        // react 那一条刻意保留宽松匹配：react-dom / react-router / react-i18next
        // 都该跟 react 同块，写死 `/node_modules/react/` 反而会把它们拆出去。
        //
        // Match on a package directory boundary (`/node_modules/<pkg>/`), never a
        // bare substring. This used to be `id.includes('three')`, a substring test
        // against the *full path*, so any dependency whose path happens to contain
        // "three" landed in the three chunk — a future `three-*` subpackage or a
        // transitive dependency with three in its name. The symptom either way is
        // an unrelated library in the initial bundle, or something missing from
        // the three chunk; neither is obvious at a glance. Same for
        // lightweight-charts. Rollup ids are normalised posix paths (forward
        // slashes on Windows too), so this holds cross-platform.
        // The react branch deliberately stays loose: react-dom, react-router and
        // react-i18next all belong in the same chunk, and `/node_modules/react/`
        // would split them out.
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return
          if (id.includes('/node_modules/three/')) return 'three'
          if (id.includes('/node_modules/lightweight-charts/')) return 'charts'
          if (
            id.includes('react') ||
            id.includes('scheduler') ||
            id.includes('i18next')
          )
            return 'vendor'
        },
      },
    },
  },
})
