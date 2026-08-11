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
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return
          if (id.includes('three')) return 'three'
          if (id.includes('lightweight-charts')) return 'charts'
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
