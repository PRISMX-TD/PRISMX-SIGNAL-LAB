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
        // 注意：postprocessing / gsap 的分支此前已随依赖一起删除；这一轮 three /
        // @react-three 也一并删掉——落地页的 WebGL 棱镜场景在这次改版中移除后，
        // src/ 里再没有任何模块 import 它们。分包规则里留着匹配不到任何模块的
        // 分支，只会让人以为项目还在用它们。
        // 依赖本身仍在 package.json 里，需要单独一次 npm uninstall 才能真正瘦身
        // （见交付说明）。
        // Note: the postprocessing / gsap branches were removed earlier along with
        // those dependencies; this pass removes three / @react-three too — nothing
        // in src/ imports them since the landing page's WebGL prism scene was cut.
        // Chunk rules matching nothing just imply the project still uses them.
        // The packages themselves are still in package.json and need a separate
        // npm uninstall to actually shrink the install (see the handover notes).
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return
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
