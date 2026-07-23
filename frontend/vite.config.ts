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
        // three（3D 主页场景）与 lightweight-charts（图表页）本就只在各自懒加载
        // 的路由里用到，单独成块后不会进入首屏关键路径。
        // Manual chunking: split the heavy third-party libs into their own,
        // long-cacheable chunks so they don't bloat the shared bundle or the
        // first paint, and so upgrading one only busts that chunk's cache.
        // three (the 3D landing scene) and lightweight-charts (the charts page)
        // are only pulled in by their own lazy routes, so isolating them keeps
        // them off the initial critical path.
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return
          if (
            id.includes('three') ||
            id.includes('@react-three') ||
            id.includes('postprocessing')
          )
            return 'three'
          if (id.includes('lightweight-charts')) return 'charts'
          if (id.includes('gsap')) return 'gsap'
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
