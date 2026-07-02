import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // 开发期代理后端 REST 与 WebSocket / proxy backend REST & WS in dev
      '/api': { target: 'http://localhost:8000', changeOrigin: true },
      '/ws': { target: 'ws://localhost:8000', ws: true },
      // Myfxbook 社区情绪抓取代理 / proxy Myfxbook community sentiment page
      '/proxy/myfxbook': {
        target: 'https://www.myfxbook.com',
        changeOrigin: true,
        rewrite: () => '/community/outlook',
      },
    },
  },
})
