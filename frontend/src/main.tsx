import React from 'react'
import ReactDOM from 'react-dom/client'
import './styles/index.css'
import './i18n'
import App from './App'

// 锁死缩放：iOS Safari 会忽略 viewport 的 user-scalable，需手动拦截捏合与双击缩放
// Lock zoom: iOS Safari ignores viewport user-scalable, so block pinch & double-tap zoom manually
document.addEventListener('gesturestart', (e) => e.preventDefault())
document.addEventListener('gesturechange', (e) => e.preventDefault())
document.addEventListener('gestureend', (e) => e.preventDefault())
let lastTouchEnd = 0
document.addEventListener('touchend', (e) => {
  const now = Date.now()
  if (now - lastTouchEnd <= 300) e.preventDefault()
  lastTouchEnd = now
}, { passive: false })

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
